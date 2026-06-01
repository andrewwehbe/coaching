/**
 * Fatigue / deload signal — the sole computation site for both
 * suggestions.ts and recommender.ts. Pure, server-and-client safe.
 *
 * Four triggers, ≥1 of T1/T2/T4 fires Gate B:
 *   T1 (rir_drift)       — RIR drift up across the block at matched
 *                          load (rir-drift.ts). Unavailable when the
 *                          client has < 3 RIR-logged exposures →
 *                          graceful skip, NOT a blocker.
 *   T2 (e1rm_regression) — ≥FATIGUE_E1RM_REGRESSION_LIFTS_MIN exercises
 *                          this week show this-week-best e1RM <
 *                          last-3-weeks-best e1RM by more than MDC.
 *                          EXPLICITLY EXCLUDES the load-up/reps-down
 *                          trade (load went up, reps came down — that's
 *                          intentional progression, not fatigue; the
 *                          ClientA × Wide Row / ClientB × Face Pull
 *                          pattern that hits multiple clients).
 *   T3 (soft_ceiling)    — weeks_since_last_deload ≥
 *                          DELOAD_SOFT_CEILING_WEEKS. Augments other
 *                          firing triggers; never fires on its own
 *                          (Coleman 2024 — forced calendar deloads can
 *                          hurt strength).
 *   T4 (recurring_pain)  — any exercise shows joint or tendon pain
 *                          across ≥FATIGUE_PAIN_RECURRING_WEEKS distinct
 *                          weeks within the window.
 *
 * Gate B fires when T1 || T2 || T4. T3 alone never fires.
 */
import { startOfWeek } from 'date-fns';

import {
  DELOAD_RIR_DRIFT,
  DELOAD_SOFT_CEILING_WEEKS,
  FATIGUE_E1RM_REGRESSION_LIFTS_MIN,
  FATIGUE_E1RM_REGRESSION_LOOKBACK_WEEKS,
} from '../config';
import { mdcForSession, type SessionMetric } from './progression';

export type FatigueTriggerName =
  | 'rir_drift'
  | 'e1rm_regression'
  | 'soft_ceiling'
  | 'recurring_pain';

export type FatigueSignal = {
  /** True when Gate B should fire — i.e. when any of T1/T2/T4 fires. */
  shouldDeload: boolean;
  /** Ordered list of triggers that fired. UI surfaces these so the
   *  coach sees WHY a deload was recommended, not just THAT one was. */
  firedTriggers: FatigueTriggerName[];
  /** T1 diagnostic — null `value` means "insufficient RIR data, signal
   *  unavailable; treat as not firing". */
  rirDrift: {
    value: number | null;
    threshold: number;
    fired: boolean;
    available: boolean;
  };
  /** T2 diagnostic — count of exercises this week with regression
   *  beyond MDC vs the 3-week recent baseline. */
  e1rmRegression: {
    regressingExerciseCount: number;
    threshold: number;
    fired: boolean;
  };
  /** T3 diagnostic — informational only, never independently fires. */
  softCeiling: {
    weeksSinceLastDeload: number | null;
    ceiling: number;
    fired: boolean;
  };
  /** T4 diagnostic. */
  recurringPain: {
    painfulExerciseCount: number;
    fired: boolean;
  };
};

export type RecurringPainExercise = {
  exerciseId: string;
  distinctWeeksWithJointOrTendonPain: number;
};

export type FatigueInput = {
  /** Client-level RIR drift across the block, or null when insufficient
   *  (< 3 RIR-logged exposures across at least 2 exercises). Comes from
   *  rir-drift.computeClientRirDrift. */
  rirDriftAcrossBlock: number | null;
  /** Per-exercise progression series, scoped to a window that includes
   *  at least the FATIGUE_E1RM_REGRESSION_LOOKBACK_WEEKS preceding
   *  weeks plus the current week. */
  perExerciseSeries: Map<string, SessionMetric[]>;
  /** From program-week.computeProgramContext. */
  weeksSinceLastDeload: number | null;
  /** Exercises with joint/tendon pain across the recent window, with
   *  the distinct-week count. Caller (suggestions.ts /
   *  recommend-for-client.ts) computes this from exercise_logs.pain_type. */
  recurringPain: RecurringPainExercise[];
  /** Evaluation timestamp — used to compute "this week" start. */
  at: Date;
};

/** Count of exercises whose this-week-best e1RM regressed beyond MDC vs
 *  the prior-N-weeks-best, excluding the load-up/reps-down trade. */
export function countRegressingExercises(
  perExerciseSeries: Map<string, SessionMetric[]>,
  at: Date,
): number {
  const thisWeekStart = startOfWeek(at, { weekStartsOn: 1 });
  const thisWeekStartMs = thisWeekStart.getTime();
  const recentStartMs =
    thisWeekStartMs - FATIGUE_E1RM_REGRESSION_LOOKBACK_WEEKS * 7 * 24 * 60 * 60 * 1000;

  let count = 0;
  for (const series of perExerciseSeries.values()) {
    const valid = series.filter((s) => s.e1RMConfidence === 'ok');
    if (valid.length === 0) continue;

    let thisWeekBest: SessionMetric | null = null;
    let recentBest: SessionMetric | null = null;
    for (const s of valid) {
      const t = new Date(s.workoutStartedAt).getTime();
      if (t >= thisWeekStartMs) {
        if (!thisWeekBest || s.e1RM > thisWeekBest.e1RM) thisWeekBest = s;
      } else if (t >= recentStartMs) {
        if (!recentBest || s.e1RM > recentBest.e1RM) recentBest = s;
      }
    }
    if (!thisWeekBest || !recentBest) continue;

    // Load-up/reps-down: intentional progression attempt, not fatigue.
    if (
      thisWeekBest.topWeightKg > recentBest.topWeightKg &&
      thisWeekBest.topReps < recentBest.topReps
    ) {
      continue;
    }

    const mdc = mdcForSession(recentBest.e1RM, recentBest.topWeightKg);
    if (recentBest.e1RM - thisWeekBest.e1RM > mdc) count++;
  }
  return count;
}

export function evaluateFatigueTriggers(input: FatigueInput): FatigueSignal {
  // T1 — RIR drift.
  const rirAvailable = input.rirDriftAcrossBlock != null;
  const rirFired =
    rirAvailable && (input.rirDriftAcrossBlock as number) >= DELOAD_RIR_DRIFT;

  // T2 — e1RM regression.
  const regressingCount = countRegressingExercises(input.perExerciseSeries, input.at);
  const regressionFired = regressingCount >= FATIGUE_E1RM_REGRESSION_LIFTS_MIN;

  // T4 — recurring joint/tendon pain.
  const painfulExerciseCount = input.recurringPain.length;
  const painFired = painfulExerciseCount > 0;

  // T3 — soft ceiling. Only "fires" when at least one other trigger is
  // already firing AND we're at-or-past the ceiling.
  const anyPrimaryFired = rirFired || regressionFired || painFired;
  const ceilingFired =
    anyPrimaryFired &&
    input.weeksSinceLastDeload != null &&
    input.weeksSinceLastDeload >= DELOAD_SOFT_CEILING_WEEKS;

  const fired: FatigueTriggerName[] = [];
  if (rirFired) fired.push('rir_drift');
  if (regressionFired) fired.push('e1rm_regression');
  if (painFired) fired.push('recurring_pain');
  if (ceilingFired) fired.push('soft_ceiling');

  return {
    shouldDeload: anyPrimaryFired,
    firedTriggers: fired,
    rirDrift: {
      value: input.rirDriftAcrossBlock,
      threshold: DELOAD_RIR_DRIFT,
      fired: rirFired,
      available: rirAvailable,
    },
    e1rmRegression: {
      regressingExerciseCount: regressingCount,
      threshold: FATIGUE_E1RM_REGRESSION_LIFTS_MIN,
      fired: regressionFired,
    },
    softCeiling: {
      weeksSinceLastDeload: input.weeksSinceLastDeload,
      ceiling: DELOAD_SOFT_CEILING_WEEKS,
      fired: ceilingFired,
    },
    recurringPain: {
      painfulExerciseCount,
      fired: painFired,
    },
  };
}
