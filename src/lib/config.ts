/**
 * Central tuning knobs. Anything that's a literal threshold, lookback,
 * or rate cap should live here so we can audit + adjust them in one place.
 *
 * Server-and-client safe (no node-only imports).
 */

// ---------- Auth / sessions ----------
export const SESSION_TTL_DAYS = 365;
export const MAX_PIN_ATTEMPTS = 10;
export const PIN_LOCKOUT_HOURS = 1;
export const RATE_LIMIT_15M = 5;
export const RATE_LIMIT_24H = 20;

// ---------- Workout / schedule ----------
export const STALE_WORKOUT_AFTER_HOURS = 2;
export const STALE_WORKOUT_LOOKBACK_HOURS = 24;
export const LIVE_LOOKBACK_HOURS = 6;
export const THREE_IN_A_ROW_DAYS = 2;

// ---------- Plateau detection ----------
// Stage thresholds — see lib/plateau.ts stageFor()
export const STALL_WATCH_MIN = 4;
export const STALL_ADJUST_MIN = 6;
export const STALL_SWAP_MIN = 8;
// Suggestion thresholds — see lib/suggestions.ts (different from cron stages)
export const SUGGEST_WATCH_MIN = 2;
export const SUGGEST_ADJUST_MIN = 3;
export const SUGGEST_SWAP_MIN = 4;
/**
 * Earliest program-week at which a stall is allowed to escalate to
 * "swap_candidate" instead of "adjust". Coach can effectively never swap a
 * novice (a novice stall is almost always a loading/technique/adherence
 * issue, per the research brief); advanced lifters can swap sooner because
 * staleness and joint wear accumulate faster. Intermediate is the default
 * for clients with no training_age set.
 *   Number.POSITIVE_INFINITY → "never escalate to swap"
 */
export const SUGGEST_SWAP_MIN_PROGRAM_WEEK_BY_AGE = {
  novice: Number.POSITIVE_INFINITY,
  intermediate: 6,
  advanced: 4,
} as const;
export const SUGGEST_SWAP_MIN_PROGRAM_WEEK_DEFAULT =
  SUGGEST_SWAP_MIN_PROGRAM_WEEK_BY_AGE.intermediate;
/** @deprecated Use SUGGEST_SWAP_MIN_PROGRAM_WEEK_BY_AGE. Retained for callers
 *  that don't yet pass training_age. */
export const SUGGEST_SWAP_MIN_PROGRAM_WEEK = SUGGEST_SWAP_MIN_PROGRAM_WEEK_DEFAULT;

export type TrainingAge = keyof typeof SUGGEST_SWAP_MIN_PROGRAM_WEEK_BY_AGE;

/**
 * Pure: pick the program-week at which a stalled exercise is allowed to
 * escalate to "swap_candidate." Novices effectively never swap (their stalls
 * are almost always a loading / technique / adherence issue); advanced
 * lifters swap earlier because staleness accumulates faster. Falls back to
 * the intermediate default when training_age is not set.
 */
export function swapMinProgramWeekFor(
  trainingAge: TrainingAge | null | undefined,
): number {
  if (!trainingAge) return SUGGEST_SWAP_MIN_PROGRAM_WEEK_DEFAULT;
  return SUGGEST_SWAP_MIN_PROGRAM_WEEK_BY_AGE[trainingAge];
}
export const ADHERENCE_LOOKBACK_WEEKS = 2;
export const ADHERENCE_MIN_DAYS = 4;

// ---------- Recommender (slice 4) ----------
// All thresholds here are practitioner heuristics per the research brief
// (Appendix C). Edit freely as the recommender's behavior is tuned against
// real client outcomes. None of these are RCT-derived.

/** Accumulation-block length in weeks, by training age. End-of-block is
 *  what fires Gate 4 (phase transition) when no other early-exit gate
 *  has triggered. */
export const BLOCK_LENGTH_BY_AGE = {
  novice: 7,        // 6–8 wk band, midpoint
  intermediate: 5,  // 4–6 wk band, midpoint
  advanced: 4,      // 3–5 wk band, midpoint
} as const;
export const BLOCK_LENGTH_DEFAULT = BLOCK_LENGTH_BY_AGE.intermediate;

/** Gate 0 — Adherence bands. Below LOW: REFER_ADHERENCE. Between LOW and
 *  OK: plateau-driven gates are suppressed but pain/deload still run. */
export const ADHERENCE_FLOOR_LOW = 0.5;
export const ADHERENCE_FLOOR_OK = 0.8;
export const ADHERENCE_WINDOW_WEEKS = 3;

/** Gate 1 — Pain. Without a structured pain_type column we apply the
 *  conservative joint-pain rule to every pain incident: 2 incidents on the
 *  same exercise within a 2-week window → mandatory swap. */
export const PAIN_INCIDENT_THRESHOLD = 2;
export const PAIN_INCIDENT_WINDOW_DAYS = 14;

/** Gate 2 — Deload triggers. Fire when ≥2 of these co-occur, or any one
 *  strongly: (a) weeks_since_deload ≥ BLOCK_LENGTH, (b) ≥50% of primary
 *  lifts stalled this week, (c) RIR drift ≥ DELOAD_RIR_DRIFT, (d) ≥2
 *  distinct exercises with new pain. Subjective-fatigue trigger is not
 *  yet captured. */
export const DELOAD_STALL_FRACTION = 0.5;
export const DELOAD_RIR_DRIFT = 1.5; // points RIR rose at fixed load across block
export const DELOAD_TRIGGERS_REQUIRED = 2;

/** Gate 3 — Bodyweight × strength.
 *  bw_slope ≤ this (negative) AND strength flat/down → expected stall in
 *  deficit; if it's the client's goal, HOLD; otherwise REFER_RECOVERY. */
export const BW_DEFICIT_SLOPE_PCT_PER_WEEK = -0.5;
export const BW_AGGRESSIVE_LOSS_PCT_PER_WEEK = -1.0;

/** Gate 5b — Systemic stall threshold.
 *  Number of distinct days that must contain stalled exercises before we
 *  call it a systemic (recovery/volume) problem, vs. a swap candidate. */
export const SYSTEMIC_STALL_DAY_COUNT = 3;
export const DAY_LEVEL_STALL_COUNT = 2; // ≥2 stalled compounds on same day → reorder/rotate

/** Gate 6 — Split rotation cadence. Per the research this is a
 *  stress-management / variety tool, not a hypertrophy lever. Slow. */
export const SPLIT_ROTATION_CADENCE_WEEKS = 14;

// ---------- Cron idempotency ----------
export const REMINDER_DEDUP_HOURS = 20;

// ---------- Media ----------
export const SIGNED_URL_TTL_SECONDS = 60 * 60;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
