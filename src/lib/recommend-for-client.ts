import 'server-only';

import {
  startOfWeek,
  formatISO,
  subDays,
  differenceInCalendarWeeks,
} from 'date-fns';

import { db } from './supabase';
import {
  ADHERENCE_WINDOW_WEEKS,
  PAIN_INCIDENT_WINDOW_DAYS,
  type TrainingAge,
} from './config';
import { computeProgramContext } from './program-week';
import { buildExposureHistory, countConsecutiveStalled, type ExerciseLogRow } from './plateau';
import {
  computeClientRirDrift,
  pickTopSetRir,
  type RirExposure,
} from './rir-drift';
import {
  decideRecommendation,
  type MuscleGroup,
  type PainEvent,
  type PainType,
  type PrimaryGoal,
  type Recommendation,
  type RecommenderInput,
  type StallSignal,
  type StrengthTrend,
} from './recommender';

export type RecommendationResult = {
  recommendation: Recommendation;
  /** Snapshot of the input signals — used by the audit-log endpoint to
   *  enable retroactive analysis after threshold changes. */
  signals: RecommenderInput;
};

/**
 * Builds the full RecommenderInput from the database and runs the pure
 * decision tree. One server function so callers don't need to know about
 * the input shape.
 *
 * Returns null when the client doesn't exist or has no active program —
 * in either case there's nothing useful to recommend.
 *
 * Query plan (sequential where there are dependencies, parallel where not):
 *   1. client + active program + deload_weeks (3-way parallel)
 *   2. days + exercises (depends on program.id)
 *   3. workouts in adherence window + check-ins (parallel)
 *   4. exercise_logs for those workouts (depends on workout ids)
 *   5. sets for those logs (depends on log ids)
 *   6. best_efforts in recent window (for strength-trend signal)
 *
 * That's ~6 round-trips. The page that calls this already does ~7; one
 * more is acceptable for a coach-only view.
 */
export async function loadRecommendation(
  clientId: string,
  at: Date = new Date(),
): Promise<RecommendationResult | null> {
  const supa = db();

  const [{ data: client }, { data: program }, { data: deloadRows }] = await Promise.all([
    supa
      .from('clients')
      .select('id, weekly_day_target, training_age, primary_goal')
      .eq('id', clientId)
      .maybeSingle(),
    supa
      .from('programs')
      .select('id, training_start_at, uploaded_at, last_edited_at')
      .eq('client_id', clientId)
      .eq('active', true)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from('client_deload_weeks')
      .select('week_start')
      .eq('client_id', clientId),
  ]);

  if (!client || !program) return null;

  const programContext = computeProgramContext(
    {
      trainingStartAt: program.training_start_at,
      uploadedAt: program.uploaded_at,
      lastEditedAt: program.last_edited_at,
      deloadWeekStarts: (deloadRows ?? []).map((d) => d.week_start),
    },
    at,
  );

  // Block window — the current accumulation block, used for RIR drift.
  // Anchored to the most recent deload week_start (deload resets the
  // block), falling back to training_start_at or uploaded_at. The
  // recommender fetches workouts over the WIDER of {adherence window,
  // block window} so RIR drift can see early-block exposures even when
  // they're outside the 3-week adherence lookback.
  const deloadIso = [...(deloadRows ?? []).map((d) => d.week_start)].sort();
  const lastDeload = deloadIso.length ? deloadIso[deloadIso.length - 1] : null;
  const blockAnchorIso =
    lastDeload ??
    (program.training_start_at ?? program.uploaded_at).slice(0, 10);
  const blockSince = `${blockAnchorIso}T00:00:00Z`;

  // Days + exercises for the active program.
  const { data: dayRows } = await supa
    .from('days')
    .select(
      'id, day_index, label, exercises(id, name, name_key, archived_at, muscle_group)',
    )
    .eq('program_id', program.id)
    .order('day_index');

  type ExRow = {
    id: string;
    name: string;
    name_key: string;
    archived_at: string | null;
    muscle_group: string | null;
  };
  type DayRow = { id: string; day_index: number; label: string; exercises: ExRow[] };

  const exerciseToDay = new Map<
    string,
    {
      dayId: string;
      dayLabel: string;
      exerciseName: string;
      muscleGroup: MuscleGroup | null;
    }
  >();
  for (const d of (dayRows ?? []) as DayRow[]) {
    for (const e of d.exercises ?? []) {
      if (e.archived_at) continue;
      exerciseToDay.set(e.id, {
        dayId: d.id,
        dayLabel: d.label,
        exerciseName: e.name,
        muscleGroup: (e.muscle_group ?? null) as MuscleGroup | null,
      });
    }
  }

  // Adherence window vs block window — fetch the wider so RIR drift sees
  // the full block while adherence still only counts the 3-week sub-window.
  const adherenceSince = subDays(at, ADHERENCE_WINDOW_WEEKS * 7).toISOString();
  const painSince = subDays(at, PAIN_INCIDENT_WINDOW_DAYS).toISOString();
  const bwSince = subDays(at, 28).toISOString().slice(0, 10);
  const workoutsSince =
    adherenceSince < blockSince ? adherenceSince : blockSince;

  const [{ data: workouts }, { data: checkins }] = await Promise.all([
    supa
      .from('workouts')
      .select('id, day_id, started_at, completed_at, week_start')
      .eq('client_id', clientId)
      .gte('started_at', workoutsSince)
      .not('completed_at', 'is', null)
      .order('started_at', { ascending: true }),
    supa
      .from('check_ins')
      .select('date, body_weight, body_weight_unit')
      .eq('client_id', clientId)
      .gte('date', bwSince)
      .not('body_weight', 'is', null)
      .order('date', { ascending: true }),
  ]);

  const sessionsCompleted = (workouts ?? []).filter(
    (w) => w.started_at >= adherenceSince,
  ).length;
  const sessionsPlanned = (client.weekly_day_target ?? 4) * ADHERENCE_WINDOW_WEEKS;

  // ---- Pain events (last 14 days) ----
  const { data: painLogs } = await supa
    .from('exercise_logs')
    .select(
      'exercise_id, pain_reason, pain_type, created_at, exercises!inner(name), workouts!inner(client_id, started_at)',
    )
    .eq('workouts.client_id', clientId)
    .gte('workouts.started_at', painSince)
    .or('status.eq.pain,pain_reason.not.is.null');

  // Severity ranking — joint is most conservative, muscle is benign. When
  // an exercise has incidents of multiple types, the worst dictates the
  // gate's response.
  const SEVERITY: Record<PainType, number> = { joint: 3, tendon: 2, muscle: 1 };
  const painByExercise = new Map<
    string,
    { name: string; count: number; worstType: PainType | null }
  >();
  for (const l of painLogs ?? []) {
    const exRaw = l.exercises as unknown;
    const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as { name?: string } | null;
    const name = ex?.name ?? 'unknown';
    const incidentType = (l.pain_type ?? null) as PainType | null;
    const cur = painByExercise.get(l.exercise_id) ?? {
      name,
      count: 0,
      worstType: null,
    };
    cur.count++;
    if (incidentType != null) {
      if (cur.worstType == null || SEVERITY[incidentType] > SEVERITY[cur.worstType]) {
        cur.worstType = incidentType;
      }
    }
    painByExercise.set(l.exercise_id, cur);
  }
  const painEvents: PainEvent[] = [];
  for (const [exerciseId, { name, count, worstType }] of painByExercise) {
    painEvents.push({
      exerciseId,
      exerciseName: name,
      incidentCountInWindow: count,
      worstPainType: worstType,
    });
  }
  const newPainExerciseCount = painEvents.filter((p) => p.incidentCountInWindow > 0).length;

  // ---- Bodyweight slope (%/week, simple endpoint approximation) ----
  let bodyWeightSlopePctPerWeek: number | null = null;
  if (checkins && checkins.length >= 2) {
    const first = checkins[0];
    const last = checkins[checkins.length - 1];
    if (
      first.body_weight != null &&
      last.body_weight != null &&
      Number(first.body_weight) > 0
    ) {
      const weeks = Math.max(
        1,
        differenceInCalendarWeeks(new Date(last.date), new Date(first.date), {
          weekStartsOn: 1,
        }) || 1,
      );
      const pctChange =
        ((Number(last.body_weight) - Number(first.body_weight)) /
          Number(first.body_weight)) *
        100;
      bodyWeightSlopePctPerWeek = pctChange / weeks;
    }
  }

  // ---- Strength trend (PR rate, last 4 weeks) ----
  const prSince = subDays(at, 28).toISOString();
  const { data: prs } = await supa
    .from('best_efforts')
    .select('updated_at')
    .eq('client_id', clientId)
    .gte('updated_at', prSince);
  const prCount = prs?.length ?? 0;
  let strengthTrend: StrengthTrend;
  if (sessionsCompleted === 0) {
    strengthTrend = 'insufficient';
  } else if (prCount >= 2) {
    strengthTrend = 'up';
  } else if (prCount === 1) {
    strengthTrend = 'flat';
  } else {
    strengthTrend = 'down';
  }

  // ---- Stall analysis + RIR drift ----
  // Per-exercise log history → exposures → stalled count, using the same
  // pure helpers as suggestions.ts so behavior matches the legacy gate.
  // We ALSO build per-exercise RIR exposures (top-set RIR per workout)
  // restricted to the current block (blockAnchorIso) for the drift gate.
  const workoutIds = (workouts ?? []).map((w) => w.id);
  const logsAndSets: ExerciseLogRow[] = [];
  const logsByExercise = new Map<string, ExerciseLogRow[]>();
  const rirExposuresByExercise = new Map<string, RirExposure[]>();
  if (workoutIds.length > 0) {
    const { data: logs } = await supa
      .from('exercise_logs')
      .select('id, workout_id, exercise_id')
      .in('workout_id', workoutIds);

    const logIds = (logs ?? []).map((l) => l.id);
    const { data: sets } = logIds.length
      ? await supa
          .from('sets')
          .select('exercise_log_id, weight, reps, rir')
          .in('exercise_log_id', logIds)
      : {
          data: [] as Array<{
            exercise_log_id: string;
            weight: number | string | null;
            reps: number | null;
            rir: number | null;
          }>,
        };
    const setsByLog = new Map<
      string,
      { weight: number | null; reps: number | null; rir: number | null }[]
    >();
    for (const s of sets ?? []) {
      const arr = setsByLog.get(s.exercise_log_id) ?? [];
      arr.push({
        weight: s.weight === null ? null : Number(s.weight),
        reps: s.reps === null ? null : s.reps,
        rir: s.rir,
      });
      setsByLog.set(s.exercise_log_id, arr);
    }
    const workoutById = new Map((workouts ?? []).map((w) => [w.id, w]));
    for (const l of logs ?? []) {
      const w = workoutById.get(l.workout_id);
      if (!w) continue;
      const setsForLog = setsByLog.get(l.id) ?? [];
      const row: ExerciseLogRow = {
        workoutId: l.workout_id,
        workoutStartedAt: w.started_at,
        sets: setsForLog.map((s) => ({ weight: s.weight, reps: s.reps })),
      };
      logsAndSets.push(row);
      const byEx = logsByExercise.get(l.exercise_id) ?? [];
      byEx.push(row);
      logsByExercise.set(l.exercise_id, byEx);

      // RIR exposure for the drift gate. Only count exposures within the
      // current block (since last deload, else since training_start_at).
      const startedIso = w.started_at.slice(0, 10);
      if (startedIso >= blockAnchorIso) {
        const top = pickTopSetRir(setsForLog);
        if (top) {
          const exposures = rirExposuresByExercise.get(l.exercise_id) ?? [];
          exposures.push({
            workoutStartedAt: w.started_at,
            topWeight: top.topWeight,
            topRir: top.topRir,
          });
          rirExposuresByExercise.set(l.exercise_id, exposures);
        }
      }
    }
  }

  // Compute per-exercise stall counts.
  const stallByExercise = new Map<string, number>();
  for (const [exerciseId, rows] of logsByExercise) {
    const history = buildExposureHistory(rows);
    if (history.length < 2) continue;
    const stalled = countConsecutiveStalled(history);
    stallByExercise.set(exerciseId, stalled);
  }

  // Build StallSignals — only for exercises currently in the active program
  // (so stalls on archived/swapped-out exercises don't leak through).
  const stallSignals: StallSignal[] = [];
  const stalledExerciseIds = new Set<string>();
  // First pass: find stalled exercise ids so we can compute
  // "othersOnDayProgressing" per signal.
  for (const [exerciseId, stalled] of stallByExercise) {
    if (stalled < 2) continue;
    if (!exerciseToDay.has(exerciseId)) continue;
    stalledExerciseIds.add(exerciseId);
  }
  // Index: dayId → set of exercise ids whose history shows progression
  // (i.e. they have history but are not stalled).
  const progressingByDay = new Map<string, Set<string>>();
  for (const [exerciseId, stalled] of stallByExercise) {
    if (stalled >= 2) continue;
    const meta = exerciseToDay.get(exerciseId);
    if (!meta) continue;
    const s = progressingByDay.get(meta.dayId) ?? new Set();
    s.add(exerciseId);
    progressingByDay.set(meta.dayId, s);
  }
  for (const exerciseId of stalledExerciseIds) {
    const meta = exerciseToDay.get(exerciseId)!;
    const othersOnDayProgressing = (progressingByDay.get(meta.dayId)?.size ?? 0) > 0;
    stallSignals.push({
      exerciseId,
      exerciseName: meta.exerciseName,
      dayId: meta.dayId,
      dayLabel: meta.dayLabel,
      programWeek: programContext.weekInProgram ?? 1,
      othersOnDayProgressing,
      muscleGroup: meta.muscleGroup,
    });
  }

  // Fraction of primary lifts stalled THIS week.
  const thisWeekStart = startOfWeek(at, { weekStartsOn: 1 });
  const thisWeekStartIso = formatISO(thisWeekStart, { representation: 'date' });
  const thisWeekWorkoutIds = new Set(
    (workouts ?? []).filter((w) => w.week_start >= thisWeekStartIso).map((w) => w.id),
  );
  const exercisesLoggedThisWeek = new Set<string>();
  for (const [exerciseId, rows] of logsByExercise) {
    for (const r of rows) {
      if (thisWeekWorkoutIds.has(r.workoutId)) {
        exercisesLoggedThisWeek.add(exerciseId);
        break;
      }
    }
  }
  const stalledThisWeek = [...exercisesLoggedThisWeek].filter((id) =>
    stalledExerciseIds.has(id),
  ).length;
  const fractionPrimaryLiftsStalled =
    exercisesLoggedThisWeek.size > 0
      ? stalledThisWeek / exercisesLoggedThisWeek.size
      : 0;

  const rirDriftResult = computeClientRirDrift(
    [...rirExposuresByExercise.entries()].map(([exerciseId, exposures]) => ({
      exerciseId,
      exposures,
    })),
  );

  const signals: RecommenderInput = {
    trainingAge: (client.training_age ?? null) as TrainingAge | null,
    primaryGoal: (client.primary_goal ?? null) as PrimaryGoal | null,
    sessionsCompleted,
    sessionsPlanned,
    weekInProgram: programContext.weekInProgram ?? 1,
    weeksSinceLastDeload: programContext.weeksSinceLastDeload,
    painEvents,
    bodyWeightSlopePctPerWeek,
    strengthTrend,
    stallSignals,
    fractionPrimaryLiftsStalled,
    rirDriftAcrossBlock: rirDriftResult.drift,
    newPainExerciseCount,
    weeksOnCurrentSplit: programContext.weeksSinceUpload ?? 0,
  };

  return {
    recommendation: decideRecommendation(signals),
    signals,
  };
}
