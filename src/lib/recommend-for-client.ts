import 'server-only';

import {
  startOfWeek,
  formatISO,
  subDays,
  differenceInCalendarWeeks,
} from 'date-fns';

import { db } from './supabase';
import {
  ADHERENCE_LOOKBACK_WEEKS,
  FATIGUE_E1RM_REGRESSION_LOOKBACK_WEEKS,
  FATIGUE_PAIN_RECURRING_WEEKS,
  PAIN_INCIDENT_WINDOW_DAYS,
  type TrainingAge,
} from './config';
import { computeProgramContext } from './program-week';
import {
  computeClientRirDrift,
  pickTopSetRir,
  type RirExposure,
} from './rir-drift';
import {
  computeAdherence,
  type ScheduledDay,
} from './signals/adherence';
import {
  evaluateFatigueTriggers,
  type RecurringPainExercise,
} from './signals/fatigue';
import {
  classifyExercisePlateau,
  type PlateauStage,
} from './signals/plateau';
import {
  buildProgressionSeries,
  type SessionInput,
  type SessionMetric,
} from './signals/progression';
import { loadLogsAndSets } from './signals/load-session-inputs';
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

  // Workout-fetch window: take the WIDEST of {adherence lookback,
  // fatigue T2 regression lookback, block-since}. Adherence still
  // counts only the inner ADHERENCE_LOOKBACK_WEEKS window;
  // signals/fatigue T2 needs the FATIGUE_E1RM_REGRESSION_LOOKBACK_WEEKS
  // window; RIR drift needs the full block.
  const adherenceSince = subDays(at, ADHERENCE_LOOKBACK_WEEKS * 7).toISOString();
  const regressionSince = subDays(
    at,
    (FATIGUE_E1RM_REGRESSION_LOOKBACK_WEEKS + 1) * 7,
  ).toISOString();
  const painSince = subDays(at, PAIN_INCIDENT_WINDOW_DAYS).toISOString();
  const bwSince = subDays(at, 28).toISOString().slice(0, 10);
  const workoutsSince = [adherenceSince, regressionSince, blockSince].sort()[0];

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

  // Adherence signal — sole computation site, shared with suggestions.ts.
  const scheduledDays: ScheduledDay[] = (dayRows ?? []).map((d) => ({
    id: d.id,
    day_index: d.day_index,
    label: d.label,
  }));
  const adherenceSignal = computeAdherence({
    completedWorkouts: (workouts ?? [])
      .filter((w) => w.started_at >= adherenceSince)
      .map((w) => ({ day_id: w.day_id, started_at: w.started_at })),
    scheduledDays,
    weeklyDayTarget: client.weekly_day_target ?? 4,
    at,
  });

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
  if (adherenceSignal.daysCompletedInWindow === 0) {
    strengthTrend = 'insufficient';
  } else if (prCount >= 2) {
    strengthTrend = 'up';
  } else if (prCount === 1) {
    strengthTrend = 'flat';
  } else {
    strengthTrend = 'down';
  }

  // ---- Per-exercise session series + RIR drift ----
  // Builds SessionInput[] per exercise (carries unit + rir) for the
  // signals/plateau + signals/fatigue computations below. Also builds
  // per-exercise RIR exposures restricted to the current block
  // (blockAnchorIso) for the drift gate.
  const workoutIds = (workouts ?? []).map((w) => w.id);
  const sessionInputsByExercise = new Map<string, SessionInput[]>();
  const rirExposuresByExercise = new Map<string, RirExposure[]>();
  if (workoutIds.length > 0) {
    // Shared gatherer — same fetch plumbing as suggestions.ts and the
    // daily-analysis cron (previously re-implemented in each).
    const { logs, setsByLog } = await loadLogsAndSets(workoutIds);
    const workoutById = new Map((workouts ?? []).map((w) => [w.id, w]));
    for (const l of logs) {
      const w = workoutById.get(l.workout_id);
      if (!w) continue;
      const setsForLog = setsByLog.get(l.id) ?? [];

      // Per-exercise SessionInput (unit + rir preserved) — feeds both
      // signals/plateau and signals/fatigue via buildProgressionSeries.
      const sessionInputs = sessionInputsByExercise.get(l.exercise_id) ?? [];
      sessionInputs.push({
        workoutId: l.workout_id,
        workoutStartedAt: w.started_at,
        sets: setsForLog,
      });
      sessionInputsByExercise.set(l.exercise_id, sessionInputs);

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

  // ---- Per-exercise progression + signals — order matters ----
  // Stage 4.5: Gate 5 stall classification now goes through
  // signals/plateau.classifyExercisePlateau, the same helper that
  // suggestions.ts uses. The cross-surface agreement test in
  // tests/lib.test.ts locks the invariant: same (exercise × week)
  // input → same PlateauStage on both surfaces. The retired wrapper in
  // plateau.ts is no longer called from this file; daily-analysis is
  // its only remaining caller and tracks as a separate follow-up
  // ticket (see plateau.ts deprecation comment).
  //
  // Build the per-exercise SessionMetric series FIRST, then the RIR
  // drift signal, because classifyExercisePlateau needs both
  // (rirDriftAcrossBlock feeds the fatigue_stall branch).

  const perExerciseSeries = new Map<string, SessionMetric[]>();
  for (const [exerciseId, sessionInputs] of sessionInputsByExercise) {
    perExerciseSeries.set(
      exerciseId,
      buildProgressionSeries({ historical: [], logged: sessionInputs }),
    );
  }

  const rirDriftResult = computeClientRirDrift(
    [...rirExposuresByExercise.entries()].map(([exerciseId, exposures]) => ({
      exerciseId,
      exposures,
    })),
  );

  // Per-exercise plateau classification — sole computation site shared
  // with suggestions.ts (same helper, same inputs, same output).
  const plateauByExercise = new Map<string, PlateauStage>();
  for (const [exerciseId, series] of perExerciseSeries) {
    const result = classifyExercisePlateau({
      series,
      rirDriftAcrossBlock: rirDriftResult.drift,
      at,
    });
    plateauByExercise.set(exerciseId, result.stage);
  }

  // Build StallSignals — only for exercises currently in the active
  // program (so stalls on archived/swapped-out exercises don't leak
  // through). A "stall signal" for Gate 5 is any structural-action
  // stage: watch / progress / swap_candidate. high_rir_stall is an
  // EFFORT issue (suggestions.ts surfaces it as a coaching cue, not a
  // structural change). fatigue_stall defers entirely to Gate B.
  // load_progression is positive/hold, NOT a stall.
  const STRUCTURAL_STALL_STAGES: ReadonlySet<PlateauStage> = new Set([
    'watch',
    'progress',
    'swap_candidate',
  ]);
  const stallSignals: StallSignal[] = [];
  const stalledExerciseIds = new Set<string>();
  for (const [exerciseId, stage] of plateauByExercise) {
    if (!STRUCTURAL_STALL_STAGES.has(stage)) continue;
    if (!exerciseToDay.has(exerciseId)) continue;
    stalledExerciseIds.add(exerciseId);
  }
  // Index: dayId → set of progressing exercise ids on that day.
  // "Progressing" for Gate 5 means actively progressing OR holding via
  // load_progression — both signal the day overall is not in a
  // recovery hole, which is what othersOnDayProgressing was always
  // meant to indicate.
  const PROGRESSING_STAGES: ReadonlySet<PlateauStage> = new Set([
    'progressing',
    'load_progression',
  ]);
  const progressingByDay = new Map<string, Set<string>>();
  for (const [exerciseId, stage] of plateauByExercise) {
    if (!PROGRESSING_STAGES.has(stage)) continue;
    const meta = exerciseToDay.get(exerciseId);
    if (!meta) continue;
    const s = progressingByDay.get(meta.dayId) ?? new Set();
    s.add(exerciseId);
    progressingByDay.set(meta.dayId, s);
  }
  for (const exerciseId of stalledExerciseIds) {
    const meta = exerciseToDay.get(exerciseId)!;
    // Re-narrow stage in the loop body so TS can prove it's one of
    // the StallSignal['stage'] values. STRUCTURAL_STALL_STAGES above
    // is the runtime guard; this is its compile-time mirror. If the
    // membership check upstream ever drifts, this `continue` is the
    // safety net.
    const stage = plateauByExercise.get(exerciseId);
    if (stage !== 'watch' && stage !== 'progress' && stage !== 'swap_candidate') continue;
    const othersOnDayProgressing = (progressingByDay.get(meta.dayId)?.size ?? 0) > 0;
    stallSignals.push({
      exerciseId,
      exerciseName: meta.exerciseName,
      dayId: meta.dayId,
      dayLabel: meta.dayLabel,
      programWeek: programContext.weekInProgram ?? 1,
      othersOnDayProgressing,
      muscleGroup: meta.muscleGroup,
      stage,
    });
  }

  // Recurring pain: count distinct weeks per exercise with joint/tendon
  // pain in the recent window. Fires Trigger 4 when ≥1 exercise hits
  // FATIGUE_PAIN_RECURRING_WEEKS.
  const weekKey = (ts: string) => {
    const monday = startOfWeek(new Date(ts), { weekStartsOn: 1 });
    return formatISO(monday, { representation: 'date' });
  };
  const painWeeksByExercise = new Map<string, Set<string>>();
  for (const l of painLogs ?? []) {
    if (l.pain_type !== 'joint' && l.pain_type !== 'tendon') continue;
    const wRaw = l.workouts as unknown;
    const w = (Array.isArray(wRaw) ? wRaw[0] : wRaw) as
      | { started_at?: string }
      | null;
    if (!w?.started_at) continue;
    const wk = weekKey(w.started_at);
    const set = painWeeksByExercise.get(l.exercise_id) ?? new Set<string>();
    set.add(wk);
    painWeeksByExercise.set(l.exercise_id, set);
  }
  const recurringPain: RecurringPainExercise[] = [];
  for (const [exerciseId, weeks] of painWeeksByExercise) {
    if (weeks.size >= FATIGUE_PAIN_RECURRING_WEEKS) {
      recurringPain.push({
        exerciseId,
        distinctWeeksWithJointOrTendonPain: weeks.size,
      });
    }
  }

  const fatigueSignal = evaluateFatigueTriggers({
    rirDriftAcrossBlock: rirDriftResult.drift,
    perExerciseSeries,
    weeksSinceLastDeload: programContext.weeksSinceLastDeload,
    recurringPain,
    at,
  });

  const signals: RecommenderInput = {
    trainingAge: (client.training_age ?? null) as TrainingAge | null,
    primaryGoal: (client.primary_goal ?? null) as PrimaryGoal | null,
    adherenceSignal,
    weekInProgram: programContext.weekInProgram ?? 1,
    weeksSinceLastDeload: programContext.weeksSinceLastDeload,
    painEvents,
    bodyWeightSlopePctPerWeek,
    strengthTrend,
    stallSignals,
    fatigueSignal,
    weeksOnCurrentSplit: programContext.weeksSinceUpload ?? 0,
  };

  return {
    recommendation: decideRecommendation(signals),
    signals,
  };
}
