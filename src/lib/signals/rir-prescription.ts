/**
 * Dynamic RIR prescription — sole computation site for cue.ts.
 * Pure, server-and-client safe.
 *
 * Replaces the manual "3-6 first 2 weeks → 0-2" sheet convention with
 * a computed target that ramps across the block by goal classification,
 * with a compound floor and a deload backoff. Evidence anchors:
 *
 *   - Robinson / Pelland et al. 2024 (Sports Med 54:2209): hypertrophy
 *     band 0-3 RIR; gains decline past ~5 RIR.
 *   - Martikainen 2025: progressive 3→1 RIR ≈ constant 1 RIR for
 *     hypertrophy gains BUT lower session RPE — use the ramp for
 *     fatigue management without sacrificing stimulus.
 *   - Compounds: floor at ~1 RIR (rarely 0). Heavy compounds + worse
 *     RIR-estimation accuracy + skill cost of a missed rep all push
 *     away from "to failure" on free-weight multi-joint movements.
 *   - Coleman 2024 (PeerJ e16777): deloads must NOT be complete
 *     cessation — back off ~2 RIR (load held), don't drop to zero.
 *
 * Goal classification (matches the plateau ladder's rep-range buckets):
 *   rep_max ≤ PLATEAU_STRENGTH_REP_MAX (6)        → 'strength'
 *   rep_max ≥ PLATEAU_HYPERTROPHY_REP_MIN (12)    → 'hypertrophy'
 *   else (or rep_max unknown)                     → 'mixed'
 *
 * Ramp model: linear from band-top (block start) → band-bottom (block
 * end). The block week is derived from weeksSinceLastDeload + 1; if
 * that signal is null, fall back to weekInProgram capped at block
 * length.
 */
import {
  BLOCK_LENGTH_BY_AGE,
  BLOCK_LENGTH_DEFAULT,
  COMPOUND_RIR_FLOOR,
  DELOAD_RIR_BACKOFF,
  PLATEAU_HYPERTROPHY_REP_MIN,
  PLATEAU_STRENGTH_REP_MAX,
  RIR_BAND_HYPERTROPHY,
  RIR_BAND_MIXED,
  RIR_BAND_STRENGTH,
  type TrainingAge,
} from '../config';

export type Goal = 'strength' | 'hypertrophy' | 'mixed';

export type RirPrescription = {
  /** Target band low end, in RIR. */
  min: number;
  /** Target band high end, in RIR. */
  max: number;
  /** 0..1 — 0 at block start, 1 at block end. Surfaced in coach view
   *  so the position-in-block is auditable. */
  rampPosition: number;
  /** Inferred goal from rep range. */
  goal: Goal;
  /** True when the compound floor pulled `min` up to COMPOUND_RIR_FLOOR. */
  compoundFloorApplied: boolean;
  /** True when this is a deload week — the +DELOAD_RIR_BACKOFF shift
   *  was applied to both min and max. */
  isDeload: boolean;
};

const GOAL_BAND: Record<Goal, { bottom: number; top: number }> = {
  hypertrophy: RIR_BAND_HYPERTROPHY,
  strength: RIR_BAND_STRENGTH,
  mixed: RIR_BAND_MIXED,
};

export function classifyGoal(
  rep_min: number | null,
  rep_max: number | null,
): Goal {
  if (rep_max != null && rep_max <= PLATEAU_STRENGTH_REP_MAX) return 'strength';
  if (rep_max != null && rep_max >= PLATEAU_HYPERTROPHY_REP_MIN) return 'hypertrophy';
  return 'mixed';
}

export function blockLengthForAge(
  trainingAge: TrainingAge | null | undefined,
): number {
  if (!trainingAge) return BLOCK_LENGTH_DEFAULT;
  return BLOCK_LENGTH_BY_AGE[trainingAge];
}

export type PrescribeRirInput = {
  rep_min: number | null;
  rep_max: number | null;
  is_compound: boolean | null;
  /** 1-indexed program week (program-week.ts). */
  weekInProgram: number;
  /** From program-week.ts; null when no deload has happened yet in
   *  this program — fall back to weekInProgram modulo block length. */
  weeksSinceLastDeload: number | null;
  /** From blockLengthForAge(client.training_age). */
  blockLengthWeeks: number;
  /** True when THIS calendar week is marked as a deload for the
   *  client (client_deload_weeks). */
  isDeloadWeek: boolean;
};

export function prescribeRir(input: PrescribeRirInput): RirPrescription {
  const goal = classifyGoal(input.rep_min, input.rep_max);
  const band = GOAL_BAND[goal];

  // Position in current block. weeksSinceLastDeload=0 means CURRENT week
  // is a deload, so the ramp is irrelevant (deload branch below
  // overwrites anyway); for the non-deload weeks, blockWeek = ws + 1.
  const wsld = input.weeksSinceLastDeload;
  const rawBlockWeek =
    wsld != null
      ? Math.max(1, wsld + 1)
      : Math.max(1, ((input.weekInProgram - 1) % input.blockLengthWeeks) + 1);
  const blockWeek = Math.min(rawBlockWeek, input.blockLengthWeeks);
  const rampPosition =
    input.blockLengthWeeks <= 1
      ? 0
      : (blockWeek - 1) / (input.blockLengthWeeks - 1);

  // Center ramps band.top → band.bottom across the block.
  const center = band.top - rampPosition * (band.top - band.bottom);
  let min = Math.max(band.bottom, Math.floor(center));
  let max = Math.min(band.top, Math.ceil(center));
  // Guarantee min ≤ max even when rounding diverges at integer centers.
  if (max < min) max = min;

  let compoundFloorApplied = false;
  if (input.is_compound === true && min < COMPOUND_RIR_FLOOR) {
    min = COMPOUND_RIR_FLOOR;
    if (max < min) max = min;
    compoundFloorApplied = true;
  }

  if (input.isDeloadWeek) {
    min += DELOAD_RIR_BACKOFF;
    max += DELOAD_RIR_BACKOFF;
  }

  return {
    min,
    max,
    rampPosition,
    goal,
    compoundFloorApplied,
    isDeload: input.isDeloadWeek,
  };
}
