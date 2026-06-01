/**
 * Per-exercise plateau classification — sole computation site for
 * suggestions.ts. Pure, server-and-client safe.
 *
 * Replaces the old "count consecutive non-improving exposures" model
 * with a week-based RIR-branched ladder, plus an explicit
 * load-progression positive/hold state for the load-up/reps-down trade
 * (the ClientA × Wide Row / ClientB × Face Pull pattern — multiple
 * roster clients land here, and the model would falsely escalate them
 * to "swap candidate" if we treated flat e1RM with rising load as a
 * stall).
 *
 * Stage decision tree (in order):
 *   1. series < PLATEAU_MIN_SESSIONS                      → insufficient_data
 *   2. most recent week cleared MDC over prior best       → progressing
 *   3. load↑ reps↓ pattern this block                     → load_progression
 *   4. genuine stall (no MDC-passing week recently):
 *      4a. mean top-set RIR ≥ HIGH_RIR_THRESHOLD          → high_rir_stall
 *          (client is leaving reps on the table; fix is EFFORT)
 *      4b. rir-drift signal firing                        → fatigue_stall
 *          (defer to Gate B; this is recovery, not a stimulus issue)
 *      4c. else escalate by weeksStalled:
 *          ≥ PLATEAU_SWAP_WEEKS                           → swap_candidate
 *          ≥ PLATEAU_PROGRESS_WEEKS                       → progress
 *          ≥ PLATEAU_WATCH_WEEKS                          → watch
 */
import { startOfWeek, formatISO } from 'date-fns';

import {
  DELOAD_RIR_DRIFT,
  HIGH_RIR_THRESHOLD,
  PLATEAU_MIN_SESSIONS,
  PLATEAU_PROGRESS_WEEKS,
  PLATEAU_SWAP_WEEKS,
  PLATEAU_WATCH_WEEKS,
} from '../config';
import { mdcForSession, type SessionMetric } from './progression';

export type PlateauStage =
  | 'insufficient_data'
  | 'progressing'
  | 'load_progression'
  | 'high_rir_stall'
  | 'fatigue_stall'
  | 'watch'
  | 'progress'
  | 'swap_candidate';

export type PlateauResult = {
  stage: PlateauStage;
  /** Count of trailing calendar weeks whose best e1RM did not clear
   *  MDC over the prior weeks' best. 0 when most recent week did
   *  improve. */
  weeksStalled: number;
  /** Mean RIR of the top-set across the stall window. null when no
   *  RIR-logged sessions in window. */
  meanTopSetRir: number | null;
  /** True when the most recent session's top-set went UP in load and
   *  DOWN in reps vs the window-start session — the intentional load
   *  progression case. */
  isLoadProgressing: boolean;
  /** Most recent prior-best e1RM, in kg, for rendering / debugging. */
  priorBestE1RM: number | null;
  /** Most recent session's top e1RM, in kg. */
  latestE1RM: number | null;
};

function weekKey(iso: string): string {
  return formatISO(startOfWeek(new Date(iso), { weekStartsOn: 1 }), {
    representation: 'date',
  });
}

/**
 * Group `series` by ISO week, take each week's best e1RM session,
 * then count trailing weeks whose best e1RM did NOT exceed the
 * running prior-best by MDC. Low-confidence and implausible
 * sessions are filtered out by buildProgressionSeries upstream, so
 * `series` is assumed pre-filtered to e1RMConfidence==='ok'.
 *
 * Returns 0 when the most recent week improved; otherwise the count
 * of trailing non-improving weeks (≥1).
 */
export function countWeeksStalled(series: SessionMetric[]): number {
  if (series.length === 0) return 0;
  const valid = series.filter((s) => s.e1RMConfidence === 'ok');
  if (valid.length === 0) return 0;

  // Best session per ISO week, in chronological order.
  const bestByWeek = new Map<string, SessionMetric>();
  for (const s of valid) {
    const wk = weekKey(s.workoutStartedAt);
    const cur = bestByWeek.get(wk);
    if (!cur || s.e1RM > cur.e1RM) bestByWeek.set(wk, s);
  }
  const weekKeys = [...bestByWeek.keys()].sort();
  const weekly = weekKeys.map((k) => bestByWeek.get(k)!);

  if (weekly.length === 1) return 1;

  // priorBest at each index = best of all earlier weeks.
  const priorBest: (SessionMetric | null)[] = new Array(weekly.length);
  priorBest[0] = null;
  for (let i = 1; i < weekly.length; i++) {
    const last = priorBest[i - 1];
    const prev = weekly[i - 1];
    priorBest[i] = !last || prev.e1RM > last.e1RM ? prev : last;
  }

  let stalled = 0;
  for (let i = weekly.length - 1; i >= 0; i--) {
    const best = priorBest[i];
    if (!best) {
      stalled++;
      break;
    }
    const mdc = mdcForSession(best.e1RM, best.topWeightKg);
    if (weekly[i].e1RM - best.e1RM > mdc) break;
    stalled++;
  }
  return stalled;
}

/**
 * "Load up, reps down" detector. Compares the most recent session's
 * top-set load+reps against the first session in the recent window.
 * Returns true when load went UP and reps went DOWN — the intentional
 * load-progression trade that the ClientA/ClientB roster pattern
 * exhibits, and that must NOT be flagged as a stall or fatigue.
 */
export function detectLoadProgression(series: SessionMetric[]): boolean {
  const valid = series.filter((s) => s.e1RMConfidence === 'ok');
  if (valid.length < 2) return false;
  const latest = valid[valid.length - 1];
  const cutoffMs =
    new Date(latest.workoutStartedAt).getTime() -
    PLATEAU_SWAP_WEEKS * 7 * 24 * 60 * 60 * 1000;
  // Find the earliest session in the recent window that ISN'T the
  // latest. If none (recent window has only the latest), fall back to
  // the most recent session BEFORE the window so we still have a real
  // comparison point.
  let windowStart: SessionMetric | null = null;
  for (const s of valid) {
    if (s.workoutId === latest.workoutId) continue;
    const t = new Date(s.workoutStartedAt).getTime();
    if (t >= cutoffMs) {
      windowStart = s;
      break;
    }
  }
  if (!windowStart) windowStart = valid[valid.length - 2];
  return (
    latest.topWeightKg > windowStart.topWeightKg && latest.topReps < windowStart.topReps
  );
}

/**
 * Mean RIR of the top-set across sessions in the recent stall window
 * (last PLATEAU_SWAP_WEEKS). Returns null when no session in window
 * has RIR logged — caller should treat this as "RIR signal
 * unavailable; can't branch on it."
 */
export function computeMeanTopSetRir(
  series: SessionMetric[],
  at: Date,
): number | null {
  const cutoffMs =
    at.getTime() - PLATEAU_SWAP_WEEKS * 7 * 24 * 60 * 60 * 1000;
  const rirs: number[] = [];
  for (const s of series) {
    if (s.e1RMConfidence !== 'ok') continue;
    if (new Date(s.workoutStartedAt).getTime() < cutoffMs) continue;
    if (s.topSetRir == null) continue;
    rirs.push(s.topSetRir);
  }
  if (rirs.length === 0) return null;
  return rirs.reduce((a, b) => a + b, 0) / rirs.length;
}

export type ClassifyExerciseInput = {
  series: SessionMetric[];
  /** Client-level RIR drift from rir-drift.computeClientRirDrift. */
  rirDriftAcrossBlock: number | null;
  at: Date;
};

export function classifyExercisePlateau(input: ClassifyExerciseInput): PlateauResult {
  const valid = input.series.filter((s) => s.e1RMConfidence === 'ok');
  const latest = valid[valid.length - 1] ?? null;
  const meanTopSetRir = computeMeanTopSetRir(input.series, input.at);
  const isLoadProgressing = detectLoadProgression(input.series);
  const weeksStalled = countWeeksStalled(input.series);

  const baseResult: Omit<PlateauResult, 'stage'> = {
    weeksStalled,
    meanTopSetRir,
    isLoadProgressing,
    priorBestE1RM:
      valid.length > 1
        ? Math.max(...valid.slice(0, -1).map((s) => s.e1RM))
        : null,
    latestE1RM: latest?.e1RM ?? null,
  };

  if (valid.length < PLATEAU_MIN_SESSIONS) {
    return { ...baseResult, stage: 'insufficient_data' };
  }

  // Did the most recent week clear MDC over prior best?
  // weeksStalled === 0 means the latest week improved.
  if (weeksStalled === 0) {
    return { ...baseResult, stage: 'progressing' };
  }

  // Load↑ reps↓ — distinct positive/hold state. Checked BEFORE stall
  // branches so we never label this pattern as a stall.
  if (isLoadProgressing) {
    return { ...baseResult, stage: 'load_progression' };
  }

  // Genuine non-progress. Branch on RIR.
  if (meanTopSetRir != null && meanTopSetRir >= HIGH_RIR_THRESHOLD) {
    return { ...baseResult, stage: 'high_rir_stall' };
  }
  if (
    input.rirDriftAcrossBlock != null &&
    input.rirDriftAcrossBlock >= DELOAD_RIR_DRIFT
  ) {
    return { ...baseResult, stage: 'fatigue_stall' };
  }

  // Pure stimulus plateau — escalate by weeks.
  if (weeksStalled >= PLATEAU_SWAP_WEEKS) {
    return { ...baseResult, stage: 'swap_candidate' };
  }
  if (weeksStalled >= PLATEAU_PROGRESS_WEEKS) {
    return { ...baseResult, stage: 'progress' };
  }
  if (weeksStalled >= PLATEAU_WATCH_WEEKS) {
    return { ...baseResult, stage: 'watch' };
  }
  // weeksStalled === 1 and no earlier branch — too short to flag.
  return { ...baseResult, stage: 'progressing' };
}

// ============================================================
// Stage 4.6 — persisted stalled_history + cron alert mapping.
// ============================================================
// The daily-analysis cron writes a row to stalled_history per (client,
// exercise_name_key) using buildStalledHistoryRow below, and decides
// whether to fire an alert via decideStalledAlert. Both helpers are
// pure — DB calls live in the cron, classification logic lives here —
// so the cross-surface agreement test can assert the persisted row's
// stage matches the classifier's output without touching Supabase.

/**
 * Concern rank for cron alert escalation. Three structural-stall
 * stages get an increasing rank (watch=2 < progress=3 < swap_candidate=4)
 * so within-type alerts only refire on escalation. high_rir_stall and
 * fatigue_stall share rank 1 — they're "not a structural stall, route
 * elsewhere" states. The positive/neutral stages
 * (insufficient_data / progressing / load_progression) sit at 0.
 *
 * Exported for the alert-decision tests; the cron itself uses
 * decideStalledAlert.
 */
export function concernRank(stage: PlateauStage): number {
  switch (stage) {
    case 'insufficient_data':
    case 'progressing':
    case 'load_progression':
      return 0;
    case 'high_rir_stall':
    case 'fatigue_stall':
      return 1;
    case 'watch':
      return 2;
    case 'progress':
      return 3;
    case 'swap_candidate':
      return 4;
  }
}

/**
 * Alert type that the cron emits for a given current stage. The 8-stage
 * ladder fans out to two outcomes:
 *
 *   watch / progress / swap_candidate → 'stalled'
 *     The historical alert type — coach review of a structural stall.
 *
 *   high_rir_stall → null (channel-boundary call; weekly note owns it)
 *     Stage 5 channel-boundary: effort-gap is COACHING framing, not a
 *     time-sensitive emergency. Surfacing it once a week via the
 *     buildWeeklyCoachingNote synthesis is the right cadence. The cron
 *     stops firing 'effort_gap' alerts; the alerts.type enum still
 *     accepts the value (migration 0025) so a future weekly-note path
 *     can write to alerts if needed.
 *
 *   fatigue_stall → null (suppressed)
 *     This is the daily-cron, not the deload path. Gate B's deload
 *     suggestion in suggestions.ts already owns this transition; firing
 *     a separate 'deload' alert here would double-ping for the same
 *     event. Suppress.
 *
 *   insufficient_data / progressing / load_progression → null
 *     Positive / neutral states. Nothing to alert on.
 */
export function alertTypeForStage(
  stage: PlateauStage,
): 'stalled' | null {
  switch (stage) {
    case 'watch':
    case 'progress':
    case 'swap_candidate':
      return 'stalled';
    case 'high_rir_stall':
    case 'fatigue_stall':
    case 'insufficient_data':
    case 'progressing':
    case 'load_progression':
      return null;
  }
}

export type StalledHistoryRow = {
  client_id: string;
  exercise_name_key: string;
  weeks_stalled: number;
  plateau_stage: PlateauStage;
  weekly_exposures: {
    weight: number;
    reps: number;
    workout_id: string;
    started_at: string;
  }[];
  computed_at: string;
};

/**
 * Build the persisted stalled_history row for one (client, exercise)
 * pair. Calls classifyExercisePlateau internally so the persisted
 * stage MUST equal the live classifier's output for the same input —
 * single source of truth. Cross-surface agreement test asserts this
 * directly.
 *
 * The cron passes rirDriftAcrossBlock: null deliberately. fatigue_stall
 * is owned by Gate B / suggestions.ts on the weekly path; the daily
 * cron's job is structural stall tracking + effort-gap surfacing. With
 * null drift, classifyExercisePlateau cannot return fatigue_stall —
 * structurally impossible by the helper's branching.
 */
export function buildStalledHistoryRow(input: {
  clientId: string;
  exerciseNameKey: string;
  series: SessionMetric[];
  at: Date;
}): StalledHistoryRow {
  const result = classifyExercisePlateau({
    series: input.series,
    rirDriftAcrossBlock: null,
    at: input.at,
  });
  return {
    client_id: input.clientId,
    exercise_name_key: input.exerciseNameKey,
    weeks_stalled: result.weeksStalled,
    plateau_stage: result.stage,
    weekly_exposures: input.series.map((s) => ({
      weight: s.topWeightKg,
      reps: s.topReps,
      workout_id: s.workoutId,
      started_at: s.workoutStartedAt,
    })),
    computed_at: input.at.toISOString(),
  };
}

export type StalledAlertDecision = {
  type: 'stalled';
  message: string;
  data: {
    exercise_name_key: string;
    plateau_stage: PlateauStage;
    previous_stage: PlateauStage | null;
    weeks_stalled: number;
  };
};

/**
 * Decide whether the cron should fire an alert for a stage transition.
 *
 *   No prior row (prev === null):
 *     Fire when the CURRENT stage has a non-null alert type. First
 *     classification entering a concerning state is news.
 *
 *   prev.alertType !== curr.alertType (and curr non-null):
 *     Fire. The classification changed buckets — structural → effort,
 *     or effort → structural, etc. Worth surfacing.
 *
 *   prev.alertType === curr.alertType === 'stalled':
 *     Fire only on concern-rank escalation (watch → progress → swap).
 *     Same-stage and within-type downgrade do NOT refire.
 *
 *   prev.alertType === curr.alertType === 'effort_gap':
 *     Don't refire. high_rir_stall is single-valued; staying there
 *     isn't news after the initial ping.
 *
 *   curr.alertType === null:
 *     Never fire. Improvements / null states don't alert.
 */
export function decideStalledAlert(input: {
  previousStage: PlateauStage | null;
  currentStage: PlateauStage;
  exerciseNameKey: string;
  weeksStalled: number;
}): StalledAlertDecision | null {
  const currType = alertTypeForStage(input.currentStage);
  if (!currType) return null;

  const prevType = input.previousStage
    ? alertTypeForStage(input.previousStage)
    : null;

  let shouldFire: boolean;
  if (prevType === null) {
    shouldFire = true;
  } else if (prevType !== currType) {
    shouldFire = true;
  } else if (currType === 'stalled') {
    shouldFire =
      concernRank(input.currentStage) >
      concernRank(input.previousStage!);
  } else {
    // effort_gap → effort_gap: stay quiet after the initial ping.
    shouldFire = false;
  }

  if (!shouldFire) return null;

  const stageLabel = input.currentStage.replace(/_/g, ' ');
  return {
    type: 'stalled',
    message: `${input.exerciseNameKey} entered ${stageLabel} (${input.weeksStalled} wk stalled).`,
    data: {
      exercise_name_key: input.exerciseNameKey,
      plateau_stage: input.currentStage,
      previous_stage: input.previousStage,
      weeks_stalled: input.weeksStalled,
    },
  };
}
