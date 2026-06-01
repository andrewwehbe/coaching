/**
 * Adherence signal — the sole computation site for both suggestions.ts
 * and recommender.ts. Pure, server-and-client safe.
 *
 * adherence_ratio = distinct_calendar_days_completed_in_window
 *                 / (weekly_day_target * ADHERENCE_LOOKBACK_WEEKS)
 *
 * When ratio < ADHERENCE_GATE_RATIO, callers suppress plateau / add-
 * volume / swap suggestions and emit a behavioral coaching note that
 * names the % and which program days are being missed. NEVER suggest
 * reducing the program — that is explicitly the behavior we're killing
 * (review note: collapsing low adherence into program shrinkage is a
 * subscriber-loser; missed sessions are an adherence problem, not
 * evidence the program is too big).
 */
import { startOfWeek } from 'date-fns';

import { ADHERENCE_GATE_RATIO, ADHERENCE_LOOKBACK_WEEKS } from '../config';

export type CompletedWorkout = {
  day_id: string;
  started_at: string; // ISO timestamp
};

export type ScheduledDay = {
  id: string;
  day_index: number;
  label: string;
};

export type AdherenceSignal = {
  /** 0..1 — distinct-days-completed ÷ expected-days-in-window. */
  ratio: number;
  /** Count of distinct calendar dates with at least one completed workout. */
  daysCompletedInWindow: number;
  /** weekly_day_target × lookback_weeks. */
  daysExpectedInWindow: number;
  /** True when ratio < ADHERENCE_GATE_RATIO — Gate A trips. */
  isLow: boolean;
  /** Program days (by label) that had ZERO completed workouts in the
   *  window. Surface to the coach: shows which day is being skipped so
   *  the conversation is concrete, not "do better." Empty when the
   *  client trained every program day at least once. */
  missingDayLabels: string[];
  /** Echoed back so the rationale string can reference the threshold
   *  the gate was evaluated at. */
  gateRatio: number;
  lookbackWeeks: number;
};

export function computeAdherence(input: {
  completedWorkouts: CompletedWorkout[];
  scheduledDays: ScheduledDay[];
  weeklyDayTarget: number;
  at: Date;
}): AdherenceSignal {
  const thisWeekStart = startOfWeek(input.at, { weekStartsOn: 1 });
  const windowStartMs =
    thisWeekStart.getTime() - ADHERENCE_LOOKBACK_WEEKS * 7 * 24 * 60 * 60 * 1000;

  const inWindow = input.completedWorkouts.filter(
    (w) => new Date(w.started_at).getTime() >= windowStartMs,
  );
  const distinctDays = new Set(inWindow.map((w) => w.started_at.slice(0, 10)));
  const daysCompletedInWindow = distinctDays.size;
  const daysExpectedInWindow = Math.max(
    1,
    input.weeklyDayTarget * ADHERENCE_LOOKBACK_WEEKS,
  );
  const ratio = daysCompletedInWindow / daysExpectedInWindow;

  // Days in the program that had ZERO sessions in the window.
  const trainedDayIds = new Set(inWindow.map((w) => w.day_id));
  const missingDayLabels = input.scheduledDays
    .filter((d) => !trainedDayIds.has(d.id))
    .map((d) => d.label);

  return {
    ratio,
    daysCompletedInWindow,
    daysExpectedInWindow,
    isLow: ratio < ADHERENCE_GATE_RATIO,
    missingDayLabels,
    gateRatio: ADHERENCE_GATE_RATIO,
    lookbackWeeks: ADHERENCE_LOOKBACK_WEEKS,
  };
}
