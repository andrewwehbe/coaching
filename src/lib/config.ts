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

// ---------- Progression / noise model (Stage 0 redesign) ----------
/**
 * Load-scaled minimal detectable change in e1RM:
 *   MDC = max(MDC_FLOOR_KG_MIN, MDC_PCT * prior_e1RM, MDC_LOAD_FRACTION * prior_load)
 *
 * Anchored on Grgic et al. 2020 (Sports Med Open 6:31): trained-lifter
 * 1RM CV ≈ 3.3%; LoA ±4–5 kg bench, ±10–15 kg squat. The 5% term
 * dominates for heavy lifts. The LOAD_FRACTION term documents intent /
 * provides a backstop for cases where the e1RM term is small; it rarely
 * binds in current e1RM bands but keeps the formula robust to future
 * tweaks. FLOOR_KG_MIN at 1.0 (was 2.5) is the binding constraint for
 * light isolations — a 7 kg face pull needs to clear ~1 kg, not 2.5 kg
 * (which would be a 36% jump no one is making). The flat 2.5 kg floor
 * mis-flagged whole isolation series as stalled in the Stage-0 audit;
 * see scripts/compare-stalls.ts.
 */
export const MDC_PCT = 0.05;
export const MDC_FLOOR_KG_MIN = 1.0;
export const MDC_LOAD_FRACTION = 0.025;
/**
 * Upper rep ceiling at which the Epley estimated-1RM formula stays
 * trustworthy. e1RM was derived from low-rep maxes and degrades quickly
 * past ~10–12 reps; sessions past this band are flagged low-confidence
 * and excluded from plateau math.
 */
export const E1RM_MAX_REPS_FOR_CONFIDENCE = 12;

/**
 * Cheap guard for unit-log fat-fingers (e.g. a 175 lb working set logged
 * as 175 kg). A session is flagged 'implausible' — and excluded from
 * plateau math — when ALL of:
 *   1. its e1RM is ≥ (1 + IMPLAUSIBLE_E1RM_JUMP_PCT) × trailing median, and
 *   2. there is a follow-up session, and
 *   3. that follow-up's e1RM is ≤ (1 + IMPLAUSIBLE_SUSTAIN_BUFFER) ×
 *      trailing median (i.e. it dropped back into the noise band).
 * The session stays in the series for UI/volume display; only plateau
 * detection ignores it. Tuned conservatively per the coach's note ("only
 * catch obvious corruption, not real PRs"). Stage-0 audit confirmed it
 * fires on ClientA × Wide Row's 2026-05-04 175-kg row and not on a
 * sustained 1.5× PR.
 */
export const IMPLAUSIBLE_E1RM_JUMP_PCT = 0.40;
export const IMPLAUSIBLE_SUSTAIN_BUFFER = 0.10;
export const IMPLAUSIBLE_TRAILING_WINDOW = 5;
export const IMPLAUSIBLE_MIN_BASELINE = 3;

// ---------- Stage 2: per-exercise plateau ladder ----------
// (The old exposures-based STALL_WATCH_MIN / STALL_ADJUST_MIN /
// STALL_SWAP_MIN constants were retired in Stage 4.6 along with
// plateau.ts. The week-based thresholds below replace them.)
/**
 * Week-based thresholds (replaces the old exposure-count
 * SUGGEST_*_MIN). A "stalled week" = a calendar week whose best
 * e1RM did not clear MDC over the prior weeks' best. WATCH at ≥2,
 * PROGRESS (load-bump or +1 set per goal classification) at ≥3,
 * SWAP_CANDIDATE at ≥4. PLATEAU_MIN_SESSIONS gates evaluation
 * entirely — a brand-new exercise can't be "stalled."
 */
export const PLATEAU_WATCH_WEEKS = 2;
export const PLATEAU_PROGRESS_WEEKS = 3;
export const PLATEAU_SWAP_WEEKS = 4;
export const PLATEAU_MIN_SESSIONS = 2;
/**
 * Top-set RIR thresholds for branching a non-progressing exercise:
 *   mean top-set RIR ≥ HIGH_RIR_THRESHOLD → "audit effort" cue
 *     (client is leaving reps on the table — fix is EFFORT, not volume).
 *   else if rir-drift signal is firing → defer to Gate B (fatigue).
 *   else → genuine low-RIR stimulus plateau, escalate by weeks.
 */
export const HIGH_RIR_THRESHOLD = 3;
/**
 * Goal classification by prescribed rep_max:
 *   rep_max ≤ STRENGTH_REP_MAX  → strength-biased; prefer load
 *     progression, do NOT auto-add volume.
 *   rep_max ≥ HYPERTROPHY_REP_MIN → hypertrophy-biased; auto-add a
 *     set is appropriate when the volume ceiling allows.
 *   in between → mixed; default to load progression suggestion.
 */
export const PLATEAU_STRENGTH_REP_MAX = 6;
export const PLATEAU_HYPERTROPHY_REP_MIN = 12;
/**
 * Per-muscle weekly working-set ceiling (Pelland et al. 2025 — strength
 * gains plateau ~4–5 sets/wk; hypertrophy keeps responding with
 * diminishing returns up to ~20). Exercises tagged with a muscle_group
 * count toward this ceiling; an add_set is suppressed when crossing it.
 */
export const VOLUME_CEILING_SETS_PER_MUSCLE = 20;
/**
 * Conservative fallback ceiling on a SINGLE exercise's prescribed_sets
 * when the exercise has no muscle_group tag — keeps an untagged
 * exercise from escalating volume indefinitely while the per-muscle
 * ceiling has no muscle to count against. Approved as the
 * graceful-degradation path: allow the add, surface a coach-facing gap
 * note ("tag this exercise's muscle group so volume ceilings apply"),
 * cap at this value.
 */
export const UNTAGGED_EXERCISE_SET_CEILING = 6;
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
// ---------- Stage 1: Gate A — adherence ----------
/**
 * Single gate threshold: a client whose adherence_ratio (distinct days
 * trained ÷ expected days in lookback) falls below this has plateau /
 * add-volume / swap suggestions suppressed and an adherence-coaching
 * note emitted instead. Pain, skipped-day, and Gate-B deload still run.
 *
 * The old code had two bands (0.50 / 0.80) and a "consider a
 * lower-frequency split" body string. Both removed: collapsing low
 * adherence into program changes is a subscriber-loser per the review
 * — missed sessions are an ADHERENCE problem, not evidence the program
 * is too big. The behavioral note replaces it.
 */
export const ADHERENCE_GATE_RATIO = 0.80;
export const ADHERENCE_LOOKBACK_WEEKS = 2;

// ---------- Stage 1: Gate B — fatigue / deload triggers ----------
/**
 * Trigger 2 (e1RM regression). Lookback window for the "recent best"
 * baseline that this-week's-best is compared against; comparing to
 * all-time PR would falsely flag long-term plateaus as fatigue (ClientA
 * × Incline 4-month-old PR shouldn't deload him this week). 3 weeks is
 * a meso-block-aware window — fits inside the typical 4–6 week
 * accumulation block without spilling past a deload week.
 */
export const FATIGUE_E1RM_REGRESSION_LOOKBACK_WEEKS = 3;
/**
 * Trigger 2 requires this many distinct exercises in regression THIS
 * WEEK before firing. Conservative; single-exercise off-days don't
 * count.
 */
export const FATIGUE_E1RM_REGRESSION_LIFTS_MIN = 2;
/**
 * Trigger 3 (soft ceiling). Weeks-since-deload at which the
 * time-based signal augments any other firing trigger. Coleman et al.
 * 2024 (PeerJ e16777) — forced calendar deloads CAN hurt strength;
 * deloads must be performance-gated, never purely time-based.
 */
export const DELOAD_SOFT_CEILING_WEEKS = 6;
/**
 * Trigger 4 (recurring pain). Number of distinct weeks within the
 * recent window during which the same exercise must flag joint/tendon
 * pain to count as recurring.
 */
export const FATIGUE_PAIN_RECURRING_WEEKS = 2;

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

/** Gate 1 — Pain. Without a structured pain_type column we apply the
 *  conservative joint-pain rule to every pain incident: 2 incidents on the
 *  same exercise within a 2-week window → mandatory swap. */
export const PAIN_INCIDENT_THRESHOLD = 2;
export const PAIN_INCIDENT_WINDOW_DAYS = 14;

/**
 * Stage 2: graded-pain ladder (signals/pain.ts).
 *   mild     → keep exercise, reduce load ~15%, monitor.
 *   recurring → swap to same-pattern alternative (existing apply).
 *   red_flag → stop, refer for coach review (apply:null).
 * Precedence: red_flag > recurring > mild (a red-flag keyword always
 * wins, even if the exercise also has recurring history).
 * Smith et al. 2017 BJSM pain-monitoring traffic-light model — load
 * reduction first, swap on recurrence, stop on red-flag.
 */
export const PAIN_LOAD_REDUCTION_FIRST = 0.15;

/**
 * Stage 2: skipped-day archive offer requires this many consecutive
 * weeks of no sessions on a given program day before consolidation
 * (archive_day) is even offered — and only when overall adherence is
 * still healthy. Below this window or with low adherence, surface as
 * pure adherence coaching (the day might still come back next week).
 */
export const SKIPPED_ARCHIVE_WEEKS = 4;

/**
 * How far back the suggestions/analysis engines fetch workout history.
 * Every analysis window above fits comfortably inside it (largest is
 * SPLIT_ROTATION_CADENCE_WEEKS = 14; plateau ladder ≤ 4; adherence 2).
 * Without a bound these fetches scan a client's entire lifetime history
 * on every coach page view and grow forever. 26 weeks = two full
 * macro-blocks of slack over the widest window. Pre-app history stays
 * available through historical_exposures, which is imported once and
 * already bounded.
 */
export const ANALYSIS_LOOKBACK_WEEKS = 26;

// ---------- Stage 3: dynamic RIR prescription ----------
/**
 * Per-goal RIR target bands. Hypertrophy declines past ~5 RIR
 * (Robinson/Pelland 2024 Sports Med 54:2209) — the old "3-6 RIR
 * early phase" sheet convention under-stimulates; start at the top
 * of band, ramp down through the block toward the bottom (Martikainen
 * 2025: progressive 3→1 ≈ constant 1 RIR for gains but with lower
 * session RPE, useful for fatigue management).
 *
 *   Hypertrophy: 0-3
 *   Strength:    1-4
 *   Mixed range: 1-3  (defaults to strength behavior, slightly tighter top)
 */
export const RIR_BAND_HYPERTROPHY = { bottom: 0, top: 3 } as const;
export const RIR_BAND_STRENGTH = { bottom: 1, top: 4 } as const;
export const RIR_BAND_MIXED = { bottom: 1, top: 3 } as const;
/**
 * Compounds (free-weight or machine multi-joint) get a floor of 1 RIR
 * regardless of goal band — heavy compounds + worse RIR accuracy on
 * lower-body / free-weight + skill cost of a missed rep all push
 * toward "never quite to 0." Isolations / machines may run to 0.
 */
export const COMPOUND_RIR_FLOOR = 1;
/**
 * Deload week: back the RIR target off by this many RIR. Coleman 2024
 * (PeerJ e16777) — complete cessation hurts strength; the deload-week
 * cue should still hit the floor (load held) but with reps further
 * from failure.
 */
export const DELOAD_RIR_BACKOFF = 2;
/**
 * Deload week: working-set volume multiplier. cue.applyDeloadOverlay
 * applies this NON-DESTRUCTIVELY at render time — exercises.prescribed_sets
 * stays untouched in the DB, so the next non-deload week reverts cleanly
 * without a counter-update. Within the brief's "~40-60% reduction" band
 * (Coleman 2024 — keep intensity, drop volume). Floor of 1 set always
 * applies in the helper so a single-set lift doesn't disappear.
 */
export const DELOAD_VOLUME_REDUCTION = 0.5;
/**
 * "Effort gap" surface: when the client's reported top-set RIR has
 * sat persistently this many RIR ABOVE the prescribed target across
 * the recent window, surface a coaching cue ("you're leaving more reps
 * than the program calls for; push closer to the target"). Lifters
 * systematically under-predict reps-in-reserve (especially on heavy
 * compounds), so this is a coaching nudge — never treated as ground
 * truth, never auto-mutates anything.
 */
export const RIR_EFFORT_GAP_THRESHOLD = 2;

// ---------- Stage 6 — client context + anomaly detection ----------
/**
 * Onboarding window. A client whose created_at is within this many
 * weeks ago AND has zero logged workouts gets a SYNTHESIZED onboarding
 * context — no DB row, computed at read time by
 * signals/client-context.getActiveClientContext. After the window
 * expires (or logs start arriving), the synthesis stops and normal
 * handling resumes naturally — auto-resolve by criteria, not by a
 * timer or a background job.
 */
export const CONTEXT_ONBOARDING_WEEKS = 2;
/**
 * Detraining gap threshold for the `health` context. When a client
 * returns from a health hold, any lift whose e1RM dropped across a
 * session-time gap of at least this many days is filtered OUT of the
 * stall counter — detraining ≠ plateau.
 *
 * Why 14 not 7: ~7-day gaps are a normal rest week / deload / short
 * trip and don't meaningfully detrain a trained lifter. Strength
 * detraining surfaces at ~2+ weeks off (Bosquet 2013; Coleman 2023).
 * Reusing the 7-day ANOMALY_RETURN_GAP_DAYS here would wave off
 * legitimate post-rest stalls. Two different numbers because they
 * answer two different questions: "ping me to check in" (7) vs
 * "should this lift's drop count against the client" (14).
 */
export const DETRAINING_GAP_DAYS = 14;
/**
 * Stage 6 Piece 2 — anomaly notifications. Anti-spam dedup window:
 * the orchestrator suppresses a given (client, anomaly_type) pair if
 * a matching alert was written in the last this-many days. ~Half the
 * weekly cadence so a Monday-triggered alert can't refire Tuesday.
 */
export const ANOMALY_DEDUP_DAYS = 7;
/**
 * Anomaly: a session logged after this many days of no completed-
 * workout activity counts as a "return after gap." Same number used
 * by performance_cliff to detect the stopped-then-weak pattern that
 * distinguishes it from Gate B's train-through fatigue.
 *
 * NOT the same as DETRAINING_GAP_DAYS (14) — that one is the
 * physiological-detraining-shows-up threshold used to FILTER post-gap
 * drops out of stall counting on a `health` context. This one is the
 * "ping me to check in" threshold for the coach. Two different numbers
 * because they answer two different questions (Stage 6 Q3 sign-off).
 */
export const ANOMALY_RETURN_GAP_DAYS = 7;
/**
 * Anomaly: a client who'd been logging consistently stops for this
 * many days. went_quiet fires once per dedup window. Not silenced
 * by an active at_risk context — for an at-risk client, continued
 * disengagement IS the signal the coach is watching for (Stage 6 Q2
 * carve-out, encoded in client-context.getContextDirective).
 */
export const ANOMALY_QUIET_DAYS = 10;

/** Gate B (fatigue) — RIR drift threshold. Points RIR rose at fixed
 *  load across the block before counting as a fatigue signal. Kept
 *  from the original gate; Trigger 1 in signals/fatigue.ts. */
export const DELOAD_RIR_DRIFT = 1.5;

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
