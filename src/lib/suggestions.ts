import 'server-only';

import { startOfWeek, formatISO, differenceInCalendarWeeks } from 'date-fns';

import { db } from './supabase';
import {
  buildProgressionSeries,
  pickTopPRsByClient,
  synthesizeHistoricalTimestamps,
  type HistoricalInput,
  type SessionInput,
  type SessionMetric,
} from './signals/progression';
import {
  computeAdherence,
  type ScheduledDay,
  type AdherenceSignal,
} from './signals/adherence';
import {
  evaluateFatigueTriggers,
  type FatigueSignal,
  type RecurringPainExercise,
} from './signals/fatigue';
import {
  classifyExercisePlateau,
  type PlateauResult,
} from './signals/plateau';
import { classifyPainIncident, MILD_PAIN_REGEX } from './signals/pain';
import {
  blockLengthForAge,
  prescribeRir,
} from './signals/rir-prescription';
import {
  buildWeeklyCoachingNote,
  computeEffortGapCandidate,
  selectBestEffortGap,
} from './signals/weekly-note';
import {
  getActiveClientContext,
  getContextDirective,
  type ContextDirective,
} from './signals/client-context';
import { fetchActiveContextsForClients } from './client-context-store';
import { computeProgramContext } from './program-week';
import {
  computeClientRirDrift,
  pickTopSetRir,
  type RirExposure,
} from './rir-drift';
import { matchCatalogForMany, type CatalogEntry } from './catalog';
import {
  swapMinProgramWeekFor,
  type TrainingAge,
  FATIGUE_PAIN_RECURRING_WEEKS,
  PAIN_INCIDENT_WINDOW_DAYS,
  PAIN_LOAD_REDUCTION_FIRST,
  PLATEAU_HYPERTROPHY_REP_MIN,
  ANALYSIS_LOOKBACK_WEEKS,
  PLATEAU_STRENGTH_REP_MAX,
  RIR_EFFORT_GAP_THRESHOLD,
  SKIPPED_ARCHIVE_WEEKS,
  UNTAGGED_EXERCISE_SET_CEILING,
  VOLUME_CEILING_SETS_PER_MUSCLE,
} from './config';

/**
 * Per-client suggestions for the weekly report. Implements the staged
 * plateau rules from the spec (§5):
 *   - WATCH at ≥2 stalled exposures, ADJUST at ≥3, SWAP_CANDIDATE at ≥4
 *   - SWAP downgraded to ADJUST if currentWeek < 6 (too early)
 *   - WATCH/ADJUST/SWAP suppressed if adherence is low
 *     (<4 logged days across last 2 weeks)
 *   - PAIN findings always fire
 *   - Skipped-day finding when a previously-active day stops getting logs
 *
 * Plateau aggregation is by exercise NAME across all days (§10.7) — the
 * cue logic is day-scoped via name_key, but the analysis collates.
 *
 * Auto-apply support is currently:
 *   - 'add_set' for ADJUST: bumps prescribed_sets by 1 on the named
 *     exercise across every day where it appears
 *   - 'archive_day' for SKIPPED_DAY (≥2 weeks dormant): soft-deletes
 *     exercises in that day so the day stops appearing in /today
 * SWAP_CANDIDATE and PAIN suggestions are informational for now —
 * applying them needs the curated exercise list (coming separately).
 */

export type SuggestionApplyKind = 'add_set' | 'archive_day' | 'deload';

export type Suggestion = {
  id: string; // stable per-client + per-target so the UI can dedupe
  type:
    | 'watch'
    | 'adjust'
    | 'swap_candidate'
    | 'pain'
    | 'adherence'
    | 'skipped_day'
    | 'deload'
    | 'load_progression'
    | 'high_rir_stall'
    | 'weekly_note';
  title: string;
  body: string;
  apply?:
    | { kind: 'add_set'; exerciseIds: string[]; targetName: string }
    | { kind: 'archive_day'; dayId: string; dayLabel: string }
    | {
        kind: 'swap_exercise';
        exerciseIds: string[];
        targetName: string;
        alternatives: { name: string; group_key: string }[];
      }
    | { kind: 'deload'; firedTriggers: string[] }
    | null;
};

export type ClientSuggestions = {
  clientId: string;
  suggestions: Suggestion[];
};

export async function buildSuggestionsByClient(
  clientIds: string[],
  at: Date = new Date(),
): Promise<Map<string, Suggestion[]>> {
  const result = new Map<string, Suggestion[]>();
  if (clientIds.length === 0) return result;

  const supa = db();

  const thisWeekStart = startOfWeek(at, { weekStartsOn: 1 });

  // Fetch active programs + days + exercises for each client.
  // Also fetch historical_exposures so we can prepend pre-app data
  // (parsed from coach's sheets via scripts/import-history.ts) ahead of
  // in-app workouts for the plateau analysis. clients.training_age gates
  // when a stall escalates to swap_candidate (see swapMinProgramWeekFor).
  const thisWeekStartTs = thisWeekStart.toISOString();
  const [
    { data: programs },
    { data: historical },
    { data: clientRows },
    { data: deloadWeekRows },
    { data: weekPRRows },
  ] = await Promise.all([
    supa
      .from('programs')
      .select(
        'id, client_id, uploaded_at, training_start_at, last_edited_at, days(id, day_index, label, exercises(id, name, name_key, prescribed_sets, rep_min, rep_max, muscle_group, is_compound, archived_at))',
      )
      .in('client_id', clientIds)
      .eq('active', true),
    supa
      .from('historical_exposures')
      .select('client_id, exercise_name_key, week_index, weight, unit, reps')
      .in('client_id', clientIds)
      .order('week_index', { ascending: true }),
    supa
      .from('clients')
      .select('id, training_age, weekly_day_target, created_at')
      .in('id', clientIds),
    supa
      .from('client_deload_weeks')
      .select('client_id, week_start')
      .in('client_id', clientIds),
    // Stage 5 v2: best_efforts updated this week → tier-1 PR celebration
    // candidate. updated_at >= this Monday catches all PRs landed in the
    // current calendar week.
    supa
      .from('best_efforts')
      .select('client_id, exercise_name_key, best_weight, best_unit, best_reps')
      .in('client_id', clientIds)
      .gte('updated_at', thisWeekStartTs)
      .not('source_set_id', 'is', null),
  ]);

  // Tier-1 PR per client — highest e1RM PR, kg-normalized (shared helper;
  // the old inline compare on raw weight let a 100 lb PR beat a 60 kg one).
  const topPRByClient = pickTopPRsByClient(weekPRRows ?? []);

  const trainingAgeByClient = new Map<string, TrainingAge | null>();
  const weeklyDayTargetByClient = new Map<string, number>();
  const clientCreatedAtByClient = new Map<string, Date>();
  for (const c of clientRows ?? []) {
    trainingAgeByClient.set(c.id, (c.training_age ?? null) as TrainingAge | null);
    weeklyDayTargetByClient.set(c.id, c.weekly_day_target ?? 4);
    if (c.created_at) {
      clientCreatedAtByClient.set(c.id, new Date(c.created_at as string));
    }
  }

  // Stage 6 Piece 3 — batch-fetch active client_context rows. One round
  // trip for the whole fan-out; per-client we'll combine this with
  // hasNoLogs (from completedWorkoutsByClient) inside the loop to
  // synthesize onboarding contexts where appropriate.
  const persistedContextByClient =
    await fetchActiveContextsForClients(clientIds);
  const deloadWeekStartsByClient = new Map<string, string[]>();
  for (const d of deloadWeekRows ?? []) {
    const arr = deloadWeekStartsByClient.get(d.client_id) ?? [];
    arr.push(d.week_start);
    deloadWeekStartsByClient.set(d.client_id, arr);
  }

  type ExRow = {
    id: string;
    name: string;
    name_key: string;
    prescribed_sets: number | null;
    rep_min: number | null;
    rep_max: number | null;
    muscle_group: string | null;
    is_compound: boolean | null;
    archived_at: string | null;
  };
  type DayRow = { id: string; day_index: number; label: string; exercises: ExRow[] };
  type ProgRow = { id: string; client_id: string; uploaded_at: string; training_start_at: string | null; last_edited_at: string | null; days: DayRow[] };

  const programByClient = new Map<string, ProgRow>();
  for (const p of (programs ?? []) as unknown as ProgRow[]) {
    programByClient.set(p.client_id, p);
  }

  // Fetch completed workouts for these clients (id + when + day_id),
  // bounded to the analysis lookback. Unbounded, this scanned lifetime
  // history on every call and grew forever; every downstream window
  // (plateau, adherence, pain-recurrence, split rotation) fits inside
  // ANALYSIS_LOOKBACK_WEEKS. Days last trained before the bound fall out
  // of the skipped-day analysis (they read as "never trained"), which is
  // fine — the archive suggestion fires at SKIPPED_ARCHIVE_WEEKS anyway.
  const lookbackStart = new Date(
    at.getTime() - ANALYSIS_LOOKBACK_WEEKS * 7 * 24 * 60 * 60_000,
  ).toISOString();
  const { data: workouts } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, week_start')
    .in('client_id', clientIds)
    .not('completed_at', 'is', null)
    .gte('started_at', lookbackStart)
    .order('started_at', { ascending: true });

  const completedWorkoutsByClient = new Map<
    string,
    { id: string; day_id: string; started_at: string; week_start: string }[]
  >();
  for (const w of workouts ?? []) {
    const arr = completedWorkoutsByClient.get(w.client_id) ?? [];
    arr.push({ id: w.id, day_id: w.day_id, started_at: w.started_at, week_start: w.week_start });
    completedWorkoutsByClient.set(w.client_id, arr);
  }

  const allWorkoutIds = (workouts ?? []).map((w) => w.id);

  // Fetch exercise_logs (with name + sets) for ALL completed workouts in one batch.
  const { data: logs } = allWorkoutIds.length
    ? await supa
        .from('exercise_logs')
        .select('id, workout_id, exercise_id, pain_reason, pain_type, client_note, exercises(name, name_key)')
        .in('workout_id', allWorkoutIds)
    : { data: [] as Array<{ id: string; workout_id: string; exercise_id: string; pain_reason: string | null; pain_type: string | null; client_note: string | null; exercises: unknown }> };

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('exercise_log_id, weight, reps, rir, unit')
        .in('exercise_log_id', logIds)
    : { data: [] as Array<{ exercise_log_id: string; weight: number | string | null; reps: number | null; rir: number | null; unit: 'kg' | 'lb' | null }> };

  const setsByLog = new Map<
    string,
    {
      weight: number | null;
      reps: number | null;
      rir: number | null;
      unit: 'kg' | 'lb' | null;
    }[]
  >();
  for (const s of sets ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      weight: s.weight === null ? null : Number(s.weight),
      reps: s.reps === null ? null : s.reps,
      rir: s.rir,
      unit: s.unit,
    });
    setsByLog.set(s.exercise_log_id, arr);
  }

  const workoutToClient = new Map<string, string>();
  for (const w of workouts ?? []) workoutToClient.set(w.id, w.client_id);

  for (const cid of clientIds) result.set(cid, []);

  // ---- PAIN findings (graded traffic-light ladder via signals/pain) ----
  // 1) Pre-compute pain-week history per (clientId, exerciseId) within the
  //    recent window so classifyPainIncident knows whether this incident is
  //    a first-flag or recurring on the same lift.
  // 2) Iterate THIS WEEK's pain-flagged logs and emit per-stage suggestions:
  //      red_flag  → stop + refer to coach review, apply: null
  //      recurring → swap to same-pattern alternative, apply: swap_exercise
  //                  (enrichment pass below fills exerciseIds + alternatives)
  //      mild      → reduce load by PAIN_LOAD_REDUCTION_FIRST (15%), keep
  //                  exercise, monitor, apply: null
  const painWindowStartMs =
    new Date(thisWeekStart).getTime() -
    PAIN_INCIDENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const painWeeksByClientExercise = new Map<string, Map<string, Set<string>>>();
  for (const l of logs ?? []) {
    const cid = workoutToClient.get(l.workout_id);
    if (!cid) continue;
    const ws = completedWorkoutsByClient.get(cid)?.find((w) => w.id === l.workout_id);
    if (!ws) continue;
    if (new Date(ws.started_at).getTime() < painWindowStartMs) continue;
    const combined = `${l.pain_reason ?? ''} ${l.client_note ?? ''}`;
    const flagged = !!l.pain_reason || MILD_PAIN_REGEX.test(combined);
    if (!flagged) continue;
    const wk = formatISO(
      startOfWeek(new Date(ws.started_at), { weekStartsOn: 1 }),
      { representation: 'date' },
    );
    let perEx = painWeeksByClientExercise.get(cid);
    if (!perEx) {
      perEx = new Map();
      painWeeksByClientExercise.set(cid, perEx);
    }
    const set = perEx.get(l.exercise_id) ?? new Set<string>();
    set.add(wk);
    perEx.set(l.exercise_id, set);
  }

  // Track pain-recurring suggestions so the enrichment pass can attach
  // exerciseIds / catalog alternatives (mild + red_flag stay apply:null).
  const painPending: Array<{ clientId: string; exName: string; suggestionIndex: number }> = [];

  for (const l of logs ?? []) {
    const cid = workoutToClient.get(l.workout_id);
    if (!cid) continue;
    const ws = completedWorkoutsByClient.get(cid)?.find((w) => w.id === l.workout_id);
    if (!ws || new Date(ws.started_at).toISOString() < thisWeekStartTs) continue;
    const recurringOnSameExercise =
      (painWeeksByClientExercise.get(cid)?.get(l.exercise_id)?.size ?? 0) >=
      FATIGUE_PAIN_RECURRING_WEEKS;
    const classification = classifyPainIncident({
      painReason: l.pain_reason,
      clientNote: l.client_note,
      recurringOnSameExercise,
    });
    if (!classification) continue;
    const exRaw = l.exercises as unknown;
    const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as { name?: string } | null;
    const exName = ex?.name ?? 'an exercise';
    const arr = result.get(cid)!;
    if (classification.stage === 'red_flag') {
      arr.push({
        id: `pain:${l.id}`,
        type: 'pain',
        title: `${exName} — STOP, coach review`,
        body: `"${classification.triggerSnippet}". Red-flag pain wording — stop this movement, do NOT prescribe around it. Have a direct conversation with the client and refer out if symptoms persist. (No auto-swap; acute/neuro/structural cues need human judgement.)`,
        apply: null,
      });
    } else if (classification.stage === 'recurring') {
      const reductionPct = Math.round(PAIN_LOAD_REDUCTION_FIRST * 100);
      arr.push({
        id: `pain:${l.id}`,
        type: 'pain',
        title: `${exName} — recurring pain, propose swap`,
        body: `Pain flagged on ${exName} across multiple weeks. First-line load reduction hasn't resolved it; swap to a same-pattern alternative (prefer unilateral or machine variant). Drop load ${reductionPct}% on the first session of the new exercise.`,
        apply: {
          kind: 'swap_exercise',
          exerciseIds: [],
          targetName: exName,
          alternatives: [],
        },
      });
      painPending.push({ clientId: cid, exName, suggestionIndex: arr.length - 1 });
    } else {
      // mild
      const reductionPct = Math.round(PAIN_LOAD_REDUCTION_FIRST * 100);
      arr.push({
        id: `pain:${l.id}`,
        type: 'pain',
        title: `${exName} — pain, reduce load ${reductionPct}%`,
        body: `"${classification.triggerSnippet}". First-flag pain on ${exName} — reduce load by ~${reductionPct}% next session and monitor for one block; consider ROM reduction. Keep the exercise; only swap if it recurs across weeks.`,
        apply: null,
      });
    }
  }

  // ---- For each client: Gate A (adherence), Gate B (fatigue), plateau, skipped-day ----
  for (const cid of clientIds) {
    const out = result.get(cid)!;
    const prog = programByClient.get(cid);
    const completed = completedWorkoutsByClient.get(cid) ?? [];

    // Stage 6 Piece 3 — derive this client's active context + directive.
    // ONE place in this function constructs the directive; every
    // gate below reads from this one variable, so the construction-
    // consistency invariant holds by construction (the weekly note's
    // contextTemplate, Gate A's suppress/soften, the structural-block
    // suppressors all come from the same source).
    const clientCreatedAt = clientCreatedAtByClient.get(cid) ?? null;
    const activeContext = clientCreatedAt
      ? getActiveClientContext({
          at,
          persistedRow: persistedContextByClient.get(cid) ?? null,
          clientCreatedAt,
          hasNoLogs: completed.length === 0,
        })
      : null;
    const directive: ContextDirective | null = activeContext
      ? getContextDirective(activeContext.reasonCode)
      : null;

    // Stage 5 v2 — weekly-note candidate accumulators at per-client
    // scope so they're accessible at the per-client tail (where the
    // weekly-note emission lives). Populated inside the structural
    // analysis block below when prog + adherence + fatigue conditions
    // permit.
    type EffortGapCandidate = {
      exerciseName: string;
      meanTopSetRir: number;
      targetMax: number;
      gap: number;
    };
    const effortGapCandidates: EffortGapCandidate[] = [];
    let untaggedExerciseName: string | null = null;

    // Gate A — adherence (single computation site via signals/adherence).
    const scheduledDays: ScheduledDay[] = prog
      ? (prog.days ?? []).map((d) => ({
          id: d.id,
          day_index: d.day_index,
          label: d.label,
        }))
      : [];
    const adherenceSignal: AdherenceSignal = computeAdherence({
      completedWorkouts: completed.map((w) => ({
        day_id: w.day_id,
        started_at: w.started_at,
      })),
      scheduledDays,
      weeklyDayTarget: weeklyDayTargetByClient.get(cid) ?? 4,
      at,
    });
    const adherenceLow = adherenceSignal.isLow;
    // Stage 6 Piece 3 — Gate A context branching. suppressGateA wins
    // over softenGateA (per-directive design: they're mutually
    // exclusive in getContextDirective). When neither flag is set we
    // fall through to the standard Gate A wording.
    if (adherenceLow && !directive?.suppressGateA) {
      const pct = Math.round(adherenceSignal.ratio * 100);
      const missingClause =
        adherenceSignal.missingDayLabels.length > 0
          ? ` Not trained in the last ${adherenceSignal.lookbackWeeks} weeks: ${adherenceSignal.missingDayLabels.join(', ')}.`
          : '';
      const softened = directive?.softenGateA ?? false;
      const title = softened
        ? `Adherence ${pct}% — life-stress context`
        : `Adherence ${pct}% — below ${Math.round(adherenceSignal.gateRatio * 100)}%`;
      const body = softened
        ? `${pct}% adherence (${adherenceSignal.daysCompletedInWindow}/${adherenceSignal.daysExpectedInWindow} sessions across the last ${adherenceSignal.lookbackWeeks} weeks). Client is in a life-stress context — capacity is the limiter, not motivation. Help them right-size this week: agree on the smallest version of training that fits, then revisit. Program changes are held while context is active.`
        : `${pct}% adherence (${adherenceSignal.daysCompletedInWindow}/${adherenceSignal.daysExpectedInWindow} sessions across the last ${adherenceSignal.lookbackWeeks} weeks).` +
          missingClause +
          ' Surface the scheduling/motivation barrier — find out what is blocking the missed sessions and whether they can be made up. Do NOT change the program for adherence; plateau-driven suggestions are suppressed until adherence recovers.';
      out.push({
        id: `adherence:${cid}`,
        type: 'adherence',
        title,
        body,
        apply: null,
      });
    }

    // Gate B — fatigue (single computation site via signals/fatigue).
    // Build per-exercise inputs from this client's completed in-app logs.
    const sessionsByExercise = new Map<string, SessionInput[]>();
    const rirExposuresByExerciseB = new Map<string, RirExposure[]>();
    const painWeeksByExerciseB = new Map<string, Set<string>>();
    const blockAnchorIso = prog
      ? (prog.training_start_at ?? prog.uploaded_at).slice(0, 10)
      : null;
    const deloadIso = (deloadWeekStartsByClient.get(cid) ?? []).slice().sort();
    const blockSinceIso =
      deloadIso.length > 0 ? deloadIso[deloadIso.length - 1] : blockAnchorIso;

    const logsForClientB = (logs ?? []).filter(
      (l) => workoutToClient.get(l.workout_id) === cid,
    );
    for (const l of logsForClientB) {
      const ws = completed.find((w) => w.id === l.workout_id);
      if (!ws) continue;
      const setsForLog = setsByLog.get(l.id) ?? [];
      const inputs = sessionsByExercise.get(l.exercise_id) ?? [];
      inputs.push({
        workoutId: l.workout_id,
        workoutStartedAt: ws.started_at,
        sets: setsForLog,
      });
      sessionsByExercise.set(l.exercise_id, inputs);
      if (blockSinceIso && ws.started_at.slice(0, 10) >= blockSinceIso) {
        const top = pickTopSetRir(setsForLog);
        if (top) {
          const exposures = rirExposuresByExerciseB.get(l.exercise_id) ?? [];
          exposures.push({
            workoutStartedAt: ws.started_at,
            topWeight: top.topWeight,
            topRir: top.topRir,
          });
          rirExposuresByExerciseB.set(l.exercise_id, exposures);
        }
      }
      if (l.pain_type === 'joint' || l.pain_type === 'tendon') {
        const wk = formatISO(
          startOfWeek(new Date(ws.started_at), { weekStartsOn: 1 }),
          { representation: 'date' },
        );
        const set = painWeeksByExerciseB.get(l.exercise_id) ?? new Set<string>();
        set.add(wk);
        painWeeksByExerciseB.set(l.exercise_id, set);
      }
    }
    const perExerciseSeries = new Map<string, SessionMetric[]>();
    for (const [exId, inputs] of sessionsByExercise) {
      perExerciseSeries.set(
        exId,
        buildProgressionSeries({ historical: [], logged: inputs }),
      );
    }
    const rirDriftResult = computeClientRirDrift(
      [...rirExposuresByExerciseB.entries()].map(([exerciseId, exposures]) => ({
        exerciseId,
        exposures,
      })),
    );
    const recurringPain: RecurringPainExercise[] = [];
    for (const [exId, weeks] of painWeeksByExerciseB) {
      if (weeks.size >= FATIGUE_PAIN_RECURRING_WEEKS) {
        recurringPain.push({
          exerciseId: exId,
          distinctWeeksWithJointOrTendonPain: weeks.size,
        });
      }
    }
    const programContext = prog
      ? computeProgramContext(
          {
            trainingStartAt: prog.training_start_at,
            uploadedAt: prog.uploaded_at,
            lastEditedAt: prog.last_edited_at,
            deloadWeekStarts: deloadWeekStartsByClient.get(cid) ?? [],
          },
          at,
        )
      : null;
    const fatigueSignal: FatigueSignal = evaluateFatigueTriggers({
      rirDriftAcrossBlock: rirDriftResult.drift,
      perExerciseSeries,
      weeksSinceLastDeload: programContext?.weeksSinceLastDeload ?? null,
      recurringPain,
      at,
    });
    if (fatigueSignal.shouldDeload) {
      // Stage 4: actionable. One-click Apply marks the current week as a
      // deload (client_deload_weeks + workouts.is_deload mirror via
      // lib/deload), and cue.applyDeloadOverlay reduces working-set
      // volume at RENDER time without touching exercises.prescribed_sets.
      // Non-destructive: the next non-deload week reverts cleanly.
      out.push({
        id: `deload:${cid}`,
        type: 'deload',
        title: 'Recommend deload week',
        body:
          `Fatigue triggers firing: ${fatigueSignal.firedTriggers.join(', ')}. ` +
          'Cut volume ~40–60% this week while keeping load and RIR target similar (fewer sets, not lighter weights — Coleman 2024 PeerJ e16777 shows complete-cessation deloads can slightly hurt strength). Hold all other program changes until next block; plateau escalations are suppressed this week.',
        apply: { kind: 'deload', firedTriggers: fatigueSignal.firedTriggers },
      });
    }

    // Plateau: aggregate by exercise NAME across all days for this client.
    // Use training_start_at when the coach has set it (client transitioned
    // mid-mesocycle from elsewhere), else fall back to uploaded_at.
    const programAnchor = prog
      ? new Date(prog.training_start_at ?? prog.uploaded_at)
      : null;
    const programWeekNumber = programAnchor
      ? Math.max(1, differenceInCalendarWeeks(at, programAnchor, { weekStartsOn: 1 }) + 1)
      : 1;

    const swapMinWeek = swapMinProgramWeekFor(trainingAgeByClient.get(cid) ?? null);

    // Stage 6 Piece 3 — directive guards. suppressAllProgramChanges
    // halts add_set / swap / archive_day / deload emissions for the
    // duration of the active context (onboarding, travel, life_stress,
    // planned_break, at_risk, paused). suppressPlateauSuggestions
    // halts the per-exercise plateau classifications (watch / progress
    // / swap_candidate / high_rir_stall). Either one fires alone is
    // enough to skip the structural block.
    if (
      !adherenceLow &&
      !fatigueSignal.shouldDeload &&
      !directive?.suppressAllProgramChanges &&
      !directive?.suppressPlateauSuggestions &&
      prog
    ) {
      // Build per-name SessionInput map (sets carry unit + rir per
      // Stage 2's progression series).
      const nameToSessionInputs = new Map<string, SessionInput[]>();
      const nameToExerciseIds = new Map<string, Set<string>>();
      const nameKeyByLower = new Map<string, string>(); // lowercased display → app name_key

      const logsForClient = (logs ?? []).filter((l) => workoutToClient.get(l.workout_id) === cid);

      for (const l of logsForClient) {
        const exRaw = l.exercises as unknown;
        const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as { name?: string } | null;
        if (!ex?.name) continue;
        const nameKey = ex.name.trim().toLowerCase();
        const ws = completed.find((w) => w.id === l.workout_id);
        if (!ws) continue;
        const arr = nameToSessionInputs.get(nameKey) ?? [];
        arr.push({
          workoutId: l.workout_id,
          workoutStartedAt: ws.started_at,
          sets: setsByLog.get(l.id) ?? [],
        });
        nameToSessionInputs.set(nameKey, arr);
      }

      // Map name → exercise.id list (only un-archived, only on this program).
      const displayNameByLowercase = new Map<string, string>();
      for (const d of prog.days ?? []) {
        for (const e of d.exercises ?? []) {
          if (e.archived_at) continue;
          const k = e.name.trim().toLowerCase();
          displayNameByLowercase.set(k, e.name);
          nameKeyByLower.set(k, e.name_key);
          const set = nameToExerciseIds.get(k) ?? new Set<string>();
          set.add(e.id);
          nameToExerciseIds.set(k, set);
        }
      }

      // Historical exposures for this client, grouped by lowercased display
      // name (via the exercise's name_key on the program). Per-exercise
      // timestamps are clamped to land strictly before the first app
      // workout for that exercise — without the clamp, hist sessions on
      // clients with null training_start_at + recent uploaded_at get
      // projected MONTHS into the future and silently pollute plateau math
      // (Stage-0 audit found ClientA × Wide Row's wk34 hist landing in
      // 2027-01).
      // Per-name historical inputs, anchored + timestamp-clamped by
      // synthesizeHistoricalTimestamps. Fed straight into
      // buildProgressionSeries — no intermediate adapt.
      const histByName = new Map<string, HistoricalInput[]>();
      const histForClient = (historical ?? []).filter((h) => h.client_id === cid);
      const lowerByNameKey = new Map<string, string>();
      for (const [low, nk] of nameKeyByLower) lowerByNameKey.set(nk, low);
      const anchor = prog.training_start_at
        ? new Date(prog.training_start_at)
        : new Date(prog.uploaded_at);

      // Group raw hist rows by lowercased display name before timestamp synth.
      const histRowsByName = new Map<string, typeof histForClient>();
      for (const h of histForClient) {
        const low = lowerByNameKey.get(h.exercise_name_key);
        if (!low) continue;
        const arr = histRowsByName.get(low) ?? [];
        arr.push(h);
        histRowsByName.set(low, arr);
      }

      for (const [low, rows] of histRowsByName) {
        const inputsArr = nameToSessionInputs.get(low) ?? [];
        const firstAppMs = inputsArr.length > 0
          ? Math.min(...inputsArr.map((s) => new Date(s.workoutStartedAt).getTime()))
          : null;
        const firstAppWorkoutAt = firstAppMs !== null ? new Date(firstAppMs) : null;
        const histInputs = synthesizeHistoricalTimestamps(
          rows.map((h) => ({
            exercise_name_key: h.exercise_name_key,
            week_index: h.week_index,
            weight: Number(h.weight),
            unit: h.unit as 'kg' | 'lb',
            reps: h.reps,
          })),
          { anchor, firstAppWorkoutAt },
        );
        histByName.set(low, histInputs);
      }

      // Per-name exercise metadata for goal classification + volume-ceiling lookup.
      const nameToRepRange = new Map<string, { rep_min: number | null; rep_max: number | null }>();
      const nameToMuscleGroup = new Map<string, string | null>();
      const nameToIsCompound = new Map<string, boolean | null>();
      const nameToPrescribedSets = new Map<string, number>();
      // Stage 5 v2 tier-4 candidate: first untagged active exercise
      // (muscle_group null). Populated below into per-client-scope
      // `untaggedExerciseName` so the weekly-note emission at the
      // per-client tail can read it.
      for (const d of prog.days ?? []) {
        for (const e of d.exercises ?? []) {
          if (e.archived_at) continue;
          const k = e.name.trim().toLowerCase();
          if (!nameToRepRange.has(k)) {
            nameToRepRange.set(k, { rep_min: e.rep_min, rep_max: e.rep_max });
          }
          if (!nameToMuscleGroup.has(k)) {
            nameToMuscleGroup.set(k, e.muscle_group);
          }
          if (!nameToIsCompound.has(k)) {
            nameToIsCompound.set(k, e.is_compound);
          }
          nameToPrescribedSets.set(
            k,
            (nameToPrescribedSets.get(k) ?? 0) + (e.prescribed_sets ?? 0),
          );
          if (untaggedExerciseName === null && e.muscle_group === null) {
            untaggedExerciseName = e.name;
          }
        }
      }

      // Stage 5 v2 tier-2 candidates: per-exercise effort-gap observations
      // captured during the plateau classification loop. Push into
      // per-client-scope `effortGapCandidates` (declared at the per-client
      // scope top); picked at per-client tail for the weekly note.
      const thisWeekMondayIso = formatISO(thisWeekStart, { representation: 'date' });
      const isDeloadWeek = (deloadWeekStartsByClient.get(cid) ?? []).includes(
        thisWeekMondayIso,
      );
      const blockLengthWeeks = blockLengthForAge(
        trainingAgeByClient.get(cid) ?? null,
      );
      // Per-muscle weekly programmed set tally (sum prescribed_sets across
      // all active exercises sharing the muscle_group). Untagged exercises
      // are excluded from the per-muscle ceiling and instead capped per-
      // exercise via UNTAGGED_EXERCISE_SET_CEILING.
      const setsByMuscle = new Map<string, number>();
      for (const d of prog.days ?? []) {
        for (const e of d.exercises ?? []) {
          if (e.archived_at || !e.muscle_group) continue;
          setsByMuscle.set(
            e.muscle_group,
            (setsByMuscle.get(e.muscle_group) ?? 0) + (e.prescribed_sets ?? 0),
          );
        }
      }

      // Walk every exercise that has either historical OR in-app data.
      const allNames = new Set<string>([
        ...nameToSessionInputs.keys(),
        ...histByName.keys(),
      ]);

      for (const nameKey of allNames) {
        const exerciseIdSet = nameToExerciseIds.get(nameKey);
        if (!exerciseIdSet || exerciseIdSet.size === 0) continue; // exercise no longer in active program
        const sessionInputs = nameToSessionInputs.get(nameKey) ?? [];
        const historical = histByName.get(nameKey) ?? [];
        // Build SessionMetric series: historical (already timestamp-clamped
        // by the synth helper) + logged sessions. buildProgressionSeries
        // sorts + applies flagImplausibleSpikes.
        const series = buildProgressionSeries({
          historical,
          logged: sessionInputs,
        });
        const plateau = classifyExercisePlateau({
          series,
          rirDriftAcrossBlock: rirDriftResult.drift,
          at,
        });

        const displayName = displayNameByLowercase.get(nameKey) ?? nameKey;
        const exerciseIds = [...exerciseIdSet];
        const repRange = nameToRepRange.get(nameKey) ?? { rep_min: null, rep_max: null };
        const muscle = nameToMuscleGroup.get(nameKey) ?? null;
        const isCompound = nameToIsCompound.get(nameKey) ?? null;
        const currentPrescribedSets = nameToPrescribedSets.get(nameKey) ?? 0;

        // Stage 5 v2: capture effort-gap candidates for the weekly note.
        // computeEffortGapCandidate handles the meanTopSetRir-null and
        // below-threshold cases; we just need to feed it the prescribed
        // target's max RIR via prescribeRir.
        //
        // The `if (!programContext) continue;` is a defensive TS-
        // narrowing aid: at runtime programContext is guaranteed non-
        // null in this codepath (the outer block at the top of this
        // loop's containing if requires `prog` truthy, and
        // computeProgramContext returns a non-nullable ProgramContext).
        // The continue therefore never triggers in production — runtime
        // semantics are identical to the prior version. Only purpose is
        // to let TS narrow programContext for the property accesses
        // below without resorting to non-null assertions.
        if (!programContext) continue;
        if (programContext.weekInProgram != null) {
          const prescription = prescribeRir({
            rep_min: repRange.rep_min,
            rep_max: repRange.rep_max,
            is_compound: isCompound,
            weekInProgram: programContext.weekInProgram,
            weeksSinceLastDeload: programContext.weeksSinceLastDeload,
            blockLengthWeeks,
            isDeloadWeek,
          });
          const cand = computeEffortGapCandidate({
            exerciseName: displayName,
            meanTopSetRir: plateau.meanTopSetRir,
            prescribedTargetMax: prescription.max,
          });
          if (cand) effortGapCandidates.push(cand);
        }

        switch (plateau.stage) {
          case 'insufficient_data':
          case 'progressing':
            // Nothing to surface — exercise is either too new or actively
            // progressing.
            break;
          case 'load_progression':
            // ClientA × Wide Row / ClientB × Face Pull pattern: load up,
            // reps down, e1RM ~flat. Positive/hold state — coach should
            // verify the rep-target intent so true e1RM progression can be
            // measured. apply:null per the user's spec.
            out.push({
              id: `loadprog:${cid}:${nameKey}`,
              type: 'load_progression',
              title: `${displayName} — load up, reps down`,
              body: `Load has been climbing while reps drop — net e1RM is flat. That's not a stall and not fatigue; it's a load-rep trade. Confirm with the client whether the rep drop is intentional, or anchor them back to the prescribed rep range so true e1RM progression becomes measurable.`,
              apply: null,
            });
            break;
          case 'high_rir_stall':
            out.push({
              id: `effort:${cid}:${nameKey}`,
              type: 'high_rir_stall',
              title: `${displayName} — audit effort (RIR too high)`,
              body: `Mean top-set RIR ≈ ${plateau.meanTopSetRir?.toFixed(1) ?? '?'} across the recent window while e1RM is flat. Reps are being left on the table — the fix is EFFORT, not volume or a swap. Coach the next session to push closer to the prescribed RIR target before changing anything.`,
              apply: null,
            });
            break;
          case 'fatigue_stall':
            // Gate B's deload suggestion already covers this — don't
            // double-emit. Suppress at the per-exercise level too.
            break;
          case 'watch':
            out.push({
              id: `watch:${cid}:${nameKey}`,
              type: 'watch',
              title: `${displayName} — watching (${plateau.weeksStalled} wk stalled)`,
              body: `${plateau.weeksStalled} weeks without an MDC-clearing e1RM improvement. Don't change yet — confirm RIR + technique are tight, then reassess next week.`,
              apply: null,
            });
            break;
          case 'progress': {
            // Strength-biased (rep_max ≤ STRENGTH_REP_MAX) → load
            // progression cue (NEVER auto-add volume on a strength lift —
            // Pelland 2025 plateau ~4-5 sets/wk).
            // Hypertrophy-biased (rep_max ≥ HYPERTROPHY_REP_MIN) →
            // auto-add a set with volume-ceiling check.
            // Mixed-range → load progression cue (safer default).
            const isStrengthBiased =
              repRange.rep_max != null && repRange.rep_max <= PLATEAU_STRENGTH_REP_MAX;
            const isHypertrophyBiased =
              repRange.rep_max != null && repRange.rep_max >= PLATEAU_HYPERTROPHY_REP_MIN;
            if (isHypertrophyBiased) {
              const wouldExceedMuscleCeiling =
                muscle != null &&
                (setsByMuscle.get(muscle) ?? 0) + 1 > VOLUME_CEILING_SETS_PER_MUSCLE;
              const wouldExceedUntaggedCap =
                muscle == null && currentPrescribedSets + 1 > UNTAGGED_EXERCISE_SET_CEILING;
              if (wouldExceedMuscleCeiling) {
                out.push({
                  id: `adjust:${cid}:${nameKey}`,
                  type: 'adjust',
                  title: `${displayName} — volume ceiling reached, hold sets`,
                  body: `${plateau.weeksStalled} weeks without progression. ${muscle} weekly sets already at ${setsByMuscle.get(muscle ?? '') ?? 0} (ceiling ${VOLUME_CEILING_SETS_PER_MUSCLE}) — adding more volume is past the diminishing-returns zone (Pelland 2025). Try shifting effort/intensity within current volume before structural change.`,
                  apply: null,
                });
              } else if (wouldExceedUntaggedCap) {
                out.push({
                  id: `adjust:${cid}:${nameKey}`,
                  type: 'adjust',
                  title: `${displayName} — at per-exercise set cap`,
                  body: `${plateau.weeksStalled} weeks without progression. Exercise currently prescribed at ${currentPrescribedSets} sets (untagged-exercise cap ${UNTAGGED_EXERCISE_SET_CEILING}). Coach-note: tag this exercise's muscle group so per-muscle volume ceilings apply, then we can decide whether more volume is appropriate.`,
                  apply: null,
                });
              } else {
                out.push({
                  id: `adjust:${cid}:${nameKey}`,
                  type: 'adjust',
                  title: `${displayName} — +1 set/week`,
                  body: `${plateau.weeksStalled} weeks without progression. Hypertrophy-biased (rep_max=${repRange.rep_max}). Volume is the primary lever — add 1 working set/week. Audit RIR + execution alongside.`,
                  apply: { kind: 'add_set', exerciseIds, targetName: displayName },
                });
              }
            } else if (isStrengthBiased) {
              out.push({
                id: `adjust:${cid}:${nameKey}`,
                type: 'adjust',
                title: `${displayName} — load progression (strength-biased)`,
                body: `${plateau.weeksStalled} weeks without progression. Strength-biased (rep_max=${repRange.rep_max}). Volume isn't the lever here (Pelland 2025: strength gains plateau by ~4-5 sets/wk) — bump load 2.5-5%, reset reps to rep_min, retry next session.`,
                apply: null,
              });
            } else {
              out.push({
                id: `adjust:${cid}:${nameKey}`,
                type: 'adjust',
                title: `${displayName} — load progression`,
                body: `${plateau.weeksStalled} weeks without progression. Mixed rep range — default to load progression (small load bump + reset to rep_min) before adding volume. Audit RIR + execution.`,
                apply: null,
              });
            }
            break;
          }
          case 'swap_candidate': {
            const programWeekTooEarly = programWeekNumber < swapMinWeek;
            if (programWeekTooEarly) {
              out.push({
                id: `watch:${cid}:${nameKey}`,
                type: 'watch',
                title: `${displayName} — too early to swap (wk ${programWeekNumber} < ${swapMinWeek})`,
                body: `${plateau.weeksStalled} weeks stalled, but program week ${programWeekNumber} is below the swap gate (${swapMinWeek} for this training_age). Continue the load/volume ladder this block; revisit swap next block.`,
                apply: null,
              });
            } else {
              out.push({
                id: `swap:${cid}:${nameKey}`,
                type: 'swap_candidate',
                title: `${displayName} — swap candidate (${plateau.weeksStalled} wk stalled)`,
                body: `${plateau.weeksStalled} weeks without MDC-clearing progression, RIR + effort already audited. Rotate to a non-redundant same-pattern variation. Hold the replacement ≥4 weeks before re-evaluating (Valério 2026: variation isn't superior when volume + effort are sufficient).`,
                apply: {
                  kind: 'swap_exercise',
                  exerciseIds,
                  targetName: displayName,
                  alternatives: [],
                },
              });
            }
            break;
          }
        }
      }
    }

    // Skipped-day — adherence-first (reworked in Stage 2). Archive is
    // OPT-IN, offered only when:
    //   - the day has been skipped ≥ SKIPPED_ARCHIVE_WEEKS, AND
    //   - overall adherence is healthy (NOT isLow).
    // Below that window, or when adherence is low, the message is pure
    // adherence coaching ("usually a scheduling problem, not the program")
    // and apply: null. This kills the old default-to-archive behaviour
    // that conflated scheduling gaps with program issues.
    if (prog) {
      const dayById = new Map<string, DayRow>();
      for (const d of prog.days ?? []) dayById.set(d.id, d);

      // Last completed-workout timestamp per program day_id.
      const lastTrainedByDay = new Map<string, number>();
      for (const w of completed) {
        const ts = new Date(w.started_at).getTime();
        const prev = lastTrainedByDay.get(w.day_id) ?? -Infinity;
        if (ts > prev) lastTrainedByDay.set(w.day_id, ts);
      }

      const nowMs = thisWeekStart.getTime();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      for (const day of prog.days ?? []) {
        const last = lastTrainedByDay.get(day.id);
        if (last == null) continue; // never trained → not a "skipped" day
        const weeksSince = Math.floor((nowMs - last) / weekMs);
        // weeksSince == 0 → trained this week or last few days; skip.
        if (weeksSince <= 0) continue;

        if (weeksSince === 1) {
          // Skipped just this week — informational only.
          out.push({
            id: `skipped:${cid}:${day.id}`,
            type: 'skipped_day',
            title: `${day.label} — skipped this week`,
            body: `Last logged ${weeksSince} week ago. If one-off, ignore. If it stretches to 2+ weeks, surface the scheduling barrier with the client.`,
            apply: null,
          });
        } else if (weeksSince < SKIPPED_ARCHIVE_WEEKS) {
          // Skipped 2-3 weeks — adherence-first, NO archive offered.
          out.push({
            id: `skipped:${cid}:${day.id}`,
            type: 'skipped_day',
            title: `${day.label} — skipped ${weeksSince} weeks`,
            body: `${day.label} hasn't been trained in ${weeksSince} weeks — usually a scheduling problem, not a program problem. Ask what's blocking it (schedule conflict, energy, recovery) and whether the session can be made up. Don't drop the day yet.`,
            apply: null,
          });
        } else {
          // Skipped SKIPPED_ARCHIVE_WEEKS+ weeks. Offer archive ONLY when
          // overall adherence is healthy — if they're training but
          // abandoned this one day, that's a genuine capacity/schedule
          // signal. Otherwise pure adherence coaching, no archive.
          if (!adherenceSignal.isLow) {
            out.push({
              id: `skipped:${cid}:${day.id}`,
              type: 'skipped_day',
              title: `${day.label} — skipped ${weeksSince}+ weeks`,
              body: `${day.label} hasn't been trained in ${weeksSince} weeks while overall adherence is healthy (${Math.round(adherenceSignal.ratio * 100)}%). This looks like a genuine capacity/schedule reality — consolidating the split may be appropriate. Verify with the client first; archive is a one-way move (logs preserved on archived exercises).`,
              apply: { kind: 'archive_day', dayId: day.id, dayLabel: day.label },
            });
          } else {
            out.push({
              id: `skipped:${cid}:${day.id}`,
              type: 'skipped_day',
              title: `${day.label} — skipped ${weeksSince}+ weeks (adherence low)`,
              body: `${day.label} hasn't been trained in ${weeksSince} weeks AND overall adherence is below ${Math.round(adherenceSignal.gateRatio * 100)}%. This is adherence, not program — surface the scheduling barrier rather than dropping the day. Re-evaluate after adherence recovers.`,
              apply: null,
            });
          }
        }
      }

      // Stage 5 v2 — weekly note emission (always-non-null when reached).
      // Fires when NO per-exercise structural suggestion fired AND no
      // skipped-day suggestion fired AND no pain suggestion fired (pain
      // is pushed earlier in the function before this if-block runs).
      // The check `out.length === 0` covers all three.
      //
      // Picked-from-candidates:
      //   - topPR: weekPRRows-derived, indexed by client
      //   - effortGap: max-gap candidate from this client's per-exercise loop
      //   - untagged: first untagged exercise from the metadata loop
      //   - adherenceRatio: from adherenceSignal.ratio (computed at top of
      //     per-client section)
      //
      // primaryRirTarget tier remains null in v2 — selecting a "primary"
      // lift per client requires either explicit coach designation or an
      // ML pick; deferring to a future enhancement.
      if (out.length === 0) {
        const bestEffortGap = selectBestEffortGap(effortGapCandidates);
        const note = buildWeeklyCoachingNote({
          clientId: cid,
          contextTemplate: directive?.weeklyNoteTemplate ?? null,
          topPR: topPRByClient.get(cid) ?? null,
          effortGap: bestEffortGap
            ? {
                exerciseName: bestEffortGap.exerciseName,
                meanTopSetRir: bestEffortGap.meanTopSetRir,
                targetMax: bestEffortGap.targetMax,
              }
            : null,
          primaryRirTarget: null,
          untaggedExercise: untaggedExerciseName
            ? { exerciseName: untaggedExerciseName }
            : null,
          adherenceRatio: adherenceSignal.ratio,
        });
        out.push(note);
      }
    }
  }

  // ---- Final enrichment pass: attach catalog alternatives + PAIN targets ----
  // 1) Resolve PAIN exerciseIds (every active exercise on the client's
  //    program with the same name as the painful one).
  for (const p of painPending) {
    const prog = programByClient.get(p.clientId);
    if (!prog) continue;
    const matchKey = p.exName.trim().toLowerCase();
    const ids: string[] = [];
    for (const d of prog.days ?? []) {
      for (const e of d.exercises ?? []) {
        if (e.archived_at) continue;
        if (e.name.trim().toLowerCase() === matchKey) ids.push(e.id);
      }
    }
    if (ids.length === 0) continue;
    const arr = result.get(p.clientId)!;
    arr[p.suggestionIndex] = {
      ...arr[p.suggestionIndex],
      apply: {
        kind: 'swap_exercise',
        exerciseIds: ids,
        targetName: p.exName,
        alternatives: [], // filled in next step
      },
    };
  }

  // 2) Batch-match every targetName against the catalog and attach
  //    alternatives for swap_candidate + pain suggestions.
  const namesToMatch = new Set<string>();
  for (const sugs of result.values()) {
    for (const s of sugs) {
      if (s.apply && s.apply.kind === 'swap_exercise') namesToMatch.add(s.apply.targetName);
    }
  }
  if (namesToMatch.size > 0) {
    const matches = await matchCatalogForMany([...namesToMatch]);
    for (const sugs of result.values()) {
      for (const s of sugs) {
        if (!s.apply || s.apply.kind !== 'swap_exercise') continue;
        const m = matches.get(s.apply.targetName);
        if (!m || m.alternatives.length === 0) {
          // No catalog match → drop apply so the UI doesn't render an empty picker.
          s.apply = null;
          continue;
        }
        s.apply.alternatives = m.alternatives.map((c: CatalogEntry) => ({
          name: c.name,
          group_key: c.group_key,
        }));
      }
    }
  } else {
    // No swap_exercise applies — nothing to enrich.
  }

  return result;
}
