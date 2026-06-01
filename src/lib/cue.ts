/**
 * Cue computation. Runs server-side; produces a structured object the UI
 * renders (rather than the string-only "← GOAL: …" from the Apps Script).
 *
 * Best-set rule: max weight; on ties, max reps.
 * Cue rule:
 *   - No prior best  → "Log your first set."
 *   - Last reps < top of prescribed range → KEEP the weight, BEAT the last reps.
 *   - Last reps ≥ top of prescribed range → BEAT the weight, hit at least bottom reps.
 *
 * RIR target (Stage 3): surfaced separately via buildRirTargetForCue.
 * The coach can pin a manual override (rir_target_min/max on the
 * exercises row); if either bound is null the computed prescription
 * from signals/rir-prescription takes over.
 */
import { DELOAD_VOLUME_REDUCTION } from './config';
import {
  prescribeRir,
  type RirPrescription,
} from './signals/rir-prescription';

export type Cue =
  | { kind: 'first' }
  | {
      kind: 'keep';
      weight: number;
      unit: string;
      repsToBeat: number;
    }
  | {
      kind: 'beat';
      weight: number;
      unit: string;
      repFloor: number;
    }
  | {
      // Prior best has weight but no reps recorded (legacy weight-only logs).
      // Tell the client to keep the weight and start tracking reps.
      kind: 'log_reps';
      weight: number;
      unit: string;
    };

export type Best = {
  weight: number | null;
  unit: string | null;
  reps: number | null;
};

export type Prescription = {
  setsPrescribed: number | null;
  repMin: number | null;
  repMax: number | null;
};

export type RirCueContext = {
  /** Optional coach override pinned on the exercises row. When both
   *  fields are set, that's the target — no computation. */
  rirTargetMinOverride: number | null;
  rirTargetMaxOverride: number | null;
  /** Per-exercise inputs to the prescriber. */
  isCompound: boolean | null;
  /** Per-client / program context. */
  weekInProgram: number;
  weeksSinceLastDeload: number | null;
  blockLengthWeeks: number;
  isDeloadWeek: boolean;
};

export type RirCueResult = {
  /** Source of the surfaced target — manual override or computed. */
  source: 'override' | 'computed' | 'unavailable';
  min: number;
  max: number;
  /** Full prescription object when source === 'computed'; null for
   *  override or unavailable. Surfaced for UI/diagnostic display. */
  prescription: RirPrescription | null;
};

export function buildCue(best: Best | null, rx: Prescription): Cue {
  if (!best || best.weight == null) {
    return { kind: 'first' };
  }
  if (best.reps == null) {
    return { kind: 'log_reps', weight: best.weight, unit: best.unit ?? '' };
  }
  const top = rx.repMax ?? rx.repMin ?? null;
  const bottom = rx.repMin ?? rx.repMax ?? null;
  const hitTop = top != null && best.reps >= top;

  if (!hitTop) {
    return {
      kind: 'keep',
      weight: best.weight,
      unit: best.unit ?? '',
      repsToBeat: best.reps,
    };
  }

  return {
    kind: 'beat',
    weight: best.weight,
    unit: best.unit ?? '',
    repFloor: bottom ?? top ?? best.reps,
  };
}

/**
 * Deload-week volume overlay. NON-DESTRUCTIVE — does NOT mutate
 * exercises.prescribed_sets in the DB. cue.ts and /today call this
 * at render time; the next non-deload week reverts cleanly with no
 * counter-update needed.
 *
 *   deload sets = max(1, ceil(prescribed_sets * DELOAD_VOLUME_REDUCTION))
 *   non-deload  = prescribed_sets unchanged
 *
 * Intensity is held — only volume drops (Coleman 2024 PeerJ e16777:
 * complete cessation can hurt strength). RIR backoff is surfaced
 * separately by buildRirTargetForCue when isDeloadWeek=true.
 */
export function applyDeloadOverlay(
  prescribedSets: number | null,
  isDeloadWeek: boolean,
): { sets: number | null; isDeload: boolean; overlayApplied: boolean } {
  if (!isDeloadWeek) {
    return { sets: prescribedSets, isDeload: false, overlayApplied: false };
  }
  if (prescribedSets == null) {
    // Nothing to halve. Caller still flags isDeload so the UI can show
    // the deload badge / RIR backoff without claiming a set count.
    return { sets: null, isDeload: true, overlayApplied: false };
  }
  return {
    sets: Math.max(1, Math.ceil(prescribedSets * DELOAD_VOLUME_REDUCTION)),
    isDeload: true,
    overlayApplied: true,
  };
}

/**
 * RIR target surfaced alongside the per-set cue. Coach override wins
 * when both rirTargetMin/Max are pinned on the exercise; otherwise the
 * prescriber computes from goal + block position + compound floor +
 * deload backoff.
 *
 * Returns source='unavailable' when neither override nor computation
 * inputs are sufficient (e.g. weekInProgram is 0 or blockLength <= 0).
 */
export function buildRirTargetForCue(
  rx: Prescription,
  context: RirCueContext,
): RirCueResult {
  if (
    context.rirTargetMinOverride != null &&
    context.rirTargetMaxOverride != null
  ) {
    return {
      source: 'override',
      min: context.rirTargetMinOverride,
      max: context.rirTargetMaxOverride,
      prescription: null,
    };
  }
  if (context.weekInProgram < 1 || context.blockLengthWeeks < 1) {
    return { source: 'unavailable', min: 0, max: 0, prescription: null };
  }
  const prescription = prescribeRir({
    rep_min: rx.repMin,
    rep_max: rx.repMax,
    is_compound: context.isCompound,
    weekInProgram: context.weekInProgram,
    weeksSinceLastDeload: context.weeksSinceLastDeload,
    blockLengthWeeks: context.blockLengthWeeks,
    isDeloadWeek: context.isDeloadWeek,
  });
  return {
    source: 'computed',
    min: prescription.min,
    max: prescription.max,
    prescription,
  };
}
