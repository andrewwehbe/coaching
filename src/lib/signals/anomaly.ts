/**
 * Stage 6 Piece 2 — anomaly detection + coach notification.
 * Pure, server-and-client safe.
 *
 * Detect behaviour CHANGES worth a coach's human look. ~19-client
 * roster — keep it tight, no spam. Pushes go to the COACH only.
 * No anomaly ever auto-changes a program; informational only.
 *
 * Four detectors:
 *
 *   adherence_drop      — client who cleared the gate over the PRIOR
 *                         2-week window (≥ ADHERENCE_GATE_RATIO) has
 *                         fallen below it this window. The CHANGE is
 *                         the signal; chronic-low is steady-state and
 *                         stays on Gate A's normal note.
 *
 *   returned_after_gap  — a session logged after ≥ ANOMALY_RETURN_GAP_
 *                         DAYS of no completed-workout activity. The
 *                         ClientD trigger. Q4 (Stage 6 sign-off):
 *                         when this fires, performance_cliff is
 *                         suppressed in the same evaluation — the
 *                         return is the headline, post-gap weakness
 *                         is expected and implied.
 *
 *   performance_cliff   — ≥2 lifts whose best e1RM POST-gap is more
 *                         than mdcForSession(pre.e1RM, pre.topWeightKg)
 *                         below their best e1RM PRE-gap, with the gap
 *                         being a ≥ ANOMALY_RETURN_GAP_DAYS no-workout
 *                         interval immediately before the recent side.
 *                         Distinct from Gate B's countRegressingExercises:
 *                         Gate B catches TRAIN-THROUGH-THE-DROP =
 *                         fatigue. This anomaly is STOPPED-THEN-WEAK =
 *                         life event. The gap requirement is what
 *                         separates them; do not call evaluateFatigueTriggers.
 *                         Reuses progression.mdcForSession — same noise
 *                         model the rest of the system uses.
 *
 *   went_quiet          — no completed workout in ≥ ANOMALY_QUIET_DAYS.
 *                         Q2 carve-out: at_risk context does NOT
 *                         silence this — for an at-risk client,
 *                         continued disengagement is signal. The
 *                         silencing decision is encoded in Piece 1's
 *                         getContextDirective + anomalyIsSilenced; the
 *                         orchestrator just calls it.
 *
 * Orchestrator `evaluateAnomalies` runs all four, then layers:
 *   1. Q4: returned_after_gap → drop performance_cliff (same eval).
 *   2. Context: filter by anomalyIsSilenced(directive, type).
 *   3. Dedup: drop any type already in recentlyAlertedTypes.
 *
 * The orchestrator returns a list of DetectedAnomaly objects with
 * enough diagnostic detail for the caller (cron) to format coach-
 * facing push messages + the alerts row's `data` jsonb. DB writes and
 * push fan-out are NOT this helper's job — keep it pure.
 */
import {
  ADHERENCE_GATE_RATIO,
  ANOMALY_QUIET_DAYS,
  ANOMALY_RETURN_GAP_DAYS,
} from '../config';
import {
  anomalyIsSilenced,
  type ActiveContext,
  type AnomalyType,
  type ContextDirective,
} from './client-context';
import type { AdherenceSignal } from './adherence';
import { mdcForSession, type SessionMetric } from './progression';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CompletedWorkoutTs = {
  /** ISO timestamp. */
  started_at: string;
};

/**
 * Per-anomaly diagnostic payload. The orchestrator carries this through
 * to the caller verbatim so the cron can format coach-facing copy +
 * write alerts.data without re-walking the source data.
 */
export type AnomalyDetail =
  | { type: 'adherence_drop'; priorRatio: number; currentRatio: number; gateRatio: number }
  | { type: 'returned_after_gap'; gapDays: number; latestWorkoutAt: string }
  | {
      type: 'performance_cliff';
      gapDays: number;
      gapEndAt: string;
      regressingExerciseCount: number;
      regressingExerciseIds: string[];
    }
  | { type: 'went_quiet'; quietDays: number; lastWorkoutAt: string | null };

export type DetectedAnomaly = {
  type: AnomalyType;
  detail: AnomalyDetail;
};

// ---------- adherence_drop ----------

export function detectAdherenceDrop(input: {
  prior: AdherenceSignal;
  current: AdherenceSignal;
}): DetectedAnomaly | null {
  const cleared = input.prior.ratio >= ADHERENCE_GATE_RATIO;
  const droppedBelow = input.current.ratio < ADHERENCE_GATE_RATIO;
  if (!cleared || !droppedBelow) return null;
  return {
    type: 'adherence_drop',
    detail: {
      type: 'adherence_drop',
      priorRatio: input.prior.ratio,
      currentRatio: input.current.ratio,
      gateRatio: ADHERENCE_GATE_RATIO,
    },
  };
}

// ---------- gap detection (shared by returned_after_gap + performance_cliff) ----------

/**
 * Find the LARGEST contiguous no-workout gap ending at the most recent
 * completed workout. Returns null when there are <2 workouts or when
 * the latest gap is below `minGapDays`.
 *
 * "Ending at the most recent workout" matters for both detectors: we
 * care about a gap immediately before the latest activity. Older gaps
 * with subsequent training don't qualify — that's not a return event.
 */
export function findLatestQualifyingGap(
  workouts: CompletedWorkoutTs[],
  at: Date,
  minGapDays: number,
): { gapDays: number; gapEndAt: string; gapStartAt: string } | null {
  if (workouts.length < 2) return null;
  // Sort ascending so [n-1] = latest. Defensive — caller may pass any order.
  const sorted = [...workouts].sort((a, b) =>
    a.started_at.localeCompare(b.started_at),
  );
  const latest = sorted[sorted.length - 1];
  const priorToLatest = sorted[sorted.length - 2];
  const gapMs =
    new Date(latest.started_at).getTime() -
    new Date(priorToLatest.started_at).getTime();
  const gapDays = gapMs / MS_PER_DAY;
  if (gapDays < minGapDays) return null;
  // Also gate: the latest workout itself must be within a reasonable
  // window relative to `at`. If the "latest" is months ago, this isn't
  // a return event — it's a gone-client (went_quiet's job).
  const ageOfLatestMs = at.getTime() - new Date(latest.started_at).getTime();
  if (ageOfLatestMs > ANOMALY_QUIET_DAYS * MS_PER_DAY) return null;
  return {
    gapDays,
    gapEndAt: latest.started_at,
    gapStartAt: priorToLatest.started_at,
  };
}

// ---------- returned_after_gap ----------

export function detectReturnedAfterGap(input: {
  workouts: CompletedWorkoutTs[];
  at: Date;
}): DetectedAnomaly | null {
  const gap = findLatestQualifyingGap(
    input.workouts,
    input.at,
    ANOMALY_RETURN_GAP_DAYS,
  );
  if (!gap) return null;
  return {
    type: 'returned_after_gap',
    detail: {
      type: 'returned_after_gap',
      gapDays: Math.round(gap.gapDays),
      latestWorkoutAt: gap.gapEndAt,
    },
  };
}

// ---------- performance_cliff ----------

/**
 * For each exercise's SessionMetric series, partition into PRE-gap and
 * POST-gap by the supplied `gapEndAt` cutoff (the timestamp of the
 * first POST-gap workout). Count exercises whose best post-gap e1RM is
 * more than MDC below the best pre-gap e1RM.
 *
 * Only 'ok'-confidence sessions count. Series with no pre-gap OR no
 * post-gap session are skipped (can't compare).
 */
export function countCliffRegressions(input: {
  perExerciseSeries: Map<string, SessionMetric[]>;
  gapEndAt: string;
}): { count: number; exerciseIds: string[] } {
  const gapEndMs = new Date(input.gapEndAt).getTime();
  const exerciseIds: string[] = [];
  for (const [exerciseId, series] of input.perExerciseSeries) {
    const valid = series.filter((s) => s.e1RMConfidence === 'ok');
    let preBest: SessionMetric | null = null;
    let postBest: SessionMetric | null = null;
    for (const s of valid) {
      const t = new Date(s.workoutStartedAt).getTime();
      if (t < gapEndMs) {
        if (!preBest || s.e1RM > preBest.e1RM) preBest = s;
      } else {
        if (!postBest || s.e1RM > postBest.e1RM) postBest = s;
      }
    }
    if (!preBest || !postBest) continue;
    const mdc = mdcForSession(preBest.e1RM, preBest.topWeightKg);
    if (preBest.e1RM - postBest.e1RM > mdc) {
      exerciseIds.push(exerciseId);
    }
  }
  return { count: exerciseIds.length, exerciseIds };
}

export function detectPerformanceCliff(input: {
  workouts: CompletedWorkoutTs[];
  perExerciseSeries: Map<string, SessionMetric[]>;
  at: Date;
}): DetectedAnomaly | null {
  // Same gap definition as returned_after_gap — the distinguishing
  // feature vs Gate B is the "stopped training" interval.
  const gap = findLatestQualifyingGap(
    input.workouts,
    input.at,
    ANOMALY_RETURN_GAP_DAYS,
  );
  if (!gap) return null;
  const { count, exerciseIds } = countCliffRegressions({
    perExerciseSeries: input.perExerciseSeries,
    gapEndAt: gap.gapEndAt,
  });
  if (count < 2) return null;
  return {
    type: 'performance_cliff',
    detail: {
      type: 'performance_cliff',
      gapDays: Math.round(gap.gapDays),
      gapEndAt: gap.gapEndAt,
      regressingExerciseCount: count,
      regressingExerciseIds: exerciseIds,
    },
  };
}

// ---------- went_quiet ----------

export function detectWentQuiet(input: {
  workouts: CompletedWorkoutTs[];
  at: Date;
}): DetectedAnomaly | null {
  if (input.workouts.length === 0) {
    // No history at all is the synthesized-onboarding case (Piece 1
    // catches it via getActiveClientContext). Don't fire went_quiet
    // on brand-new clients — they're already covered by onboarding
    // suppression at the consumer.
    return null;
  }
  const sorted = [...input.workouts].sort((a, b) =>
    a.started_at.localeCompare(b.started_at),
  );
  const lastWorkoutAt = sorted[sorted.length - 1].started_at;
  const ageMs = input.at.getTime() - new Date(lastWorkoutAt).getTime();
  const ageDays = ageMs / MS_PER_DAY;
  if (ageDays < ANOMALY_QUIET_DAYS) return null;
  return {
    type: 'went_quiet',
    detail: {
      type: 'went_quiet',
      quietDays: Math.round(ageDays),
      lastWorkoutAt,
    },
  };
}

// ---------- orchestrator ----------

export type AnomalyEvaluationInput = {
  at: Date;
  clientId: string;
  /** Completed workouts in a window wide enough to cover the largest
   *  threshold (ANOMALY_QUIET_DAYS + ANOMALY_RETURN_GAP_DAYS, ~17d
   *  minimum — caller picks the actual fetch window). */
  completedWorkouts: CompletedWorkoutTs[];
  perExerciseSeries: Map<string, SessionMetric[]>;
  /** Adherence over the prior 2-week window — computeAdherence called
   *  with at = thisWeekStart minus ADHERENCE_LOOKBACK_WEEKS weeks. */
  priorAdherence: AdherenceSignal;
  /** Adherence over the current 2-week window — the same value
   *  Gate A reads. */
  currentAdherence: AdherenceSignal;
  /** From signals/client-context.getActiveClientContext. null when no
   *  active context applies. */
  activeContext: ActiveContext | null;
  /** Anomaly types that already have a matching alert in the last
   *  ANOMALY_DEDUP_DAYS for this client. Caller queries the alerts
   *  table: `SELECT DISTINCT type FROM alerts WHERE client_id = $1
   *  AND created_at >= now() - ANOMALY_DEDUP_DAYS days AND type IN
   *  ('adherence_drop','returned_after_gap','performance_cliff',
   *  'went_quiet')`. */
  recentlyAlertedTypes: ReadonlySet<AnomalyType>;
  /** From client-context.getContextDirective(activeContext.reasonCode).
   *  Required when activeContext != null. */
  contextDirective: ContextDirective | null;
};

export function evaluateAnomalies(
  input: AnomalyEvaluationInput,
): DetectedAnomaly[] {
  // Run all four detectors.
  const detected: DetectedAnomaly[] = [];
  const adherence = detectAdherenceDrop({
    prior: input.priorAdherence,
    current: input.currentAdherence,
  });
  if (adherence) detected.push(adherence);
  const returned = detectReturnedAfterGap({
    workouts: input.completedWorkouts,
    at: input.at,
  });
  if (returned) detected.push(returned);
  const cliff = detectPerformanceCliff({
    workouts: input.completedWorkouts,
    perExerciseSeries: input.perExerciseSeries,
    at: input.at,
  });
  if (cliff) detected.push(cliff);
  const quiet = detectWentQuiet({
    workouts: input.completedWorkouts,
    at: input.at,
  });
  if (quiet) detected.push(quiet);

  // Q4 suppression (Stage 6 sign-off): when returned_after_gap fires
  // for a client, suppress performance_cliff for that same client in
  // the same evaluation. One return → one notification.
  const returnedFired = detected.some((d) => d.type === 'returned_after_gap');
  let filtered = returnedFired
    ? detected.filter((d) => d.type !== 'performance_cliff')
    : detected;

  // Context silencing — directives encode per-code policy including
  // the at_risk carve-out (Piece 1 Q2). The orchestrator just consults
  // anomalyIsSilenced; it does not re-decide.
  if (input.activeContext && input.contextDirective) {
    filtered = filtered.filter(
      (d) => !anomalyIsSilenced(input.contextDirective!, d.type),
    );
  }

  // Dedup — drop types already alerted in the dedup window.
  filtered = filtered.filter(
    (d) => !input.recentlyAlertedTypes.has(d.type),
  );

  return filtered;
}
