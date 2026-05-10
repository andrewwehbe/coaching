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
export const SUGGEST_SWAP_MIN_PROGRAM_WEEK = 6;
export const ADHERENCE_LOOKBACK_WEEKS = 2;
export const ADHERENCE_MIN_DAYS = 4;

// ---------- Cron idempotency ----------
export const REMINDER_DEDUP_HOURS = 20;

// ---------- Media ----------
export const SIGNED_URL_TTL_SECONDS = 60 * 60;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
