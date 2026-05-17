/**
 * Pure: per-exercise and per-client RIR-drift signal across a training
 * block. Feeds the deload gate in lib/recommender (Gate 2).
 *
 * Definition. "Drift" = mean RIR in the early half of the block MINUS
 * mean RIR in the late half. Positive number = RIR fell over time =
 * sets felt closer to failure as the block progressed = fatigue signal.
 *
 * Load control. The brief specifies "at fixed prescribed load" because
 * RIR will naturally fall as the lifter pushes weight up — that's
 * progressive overload, not fatigue. So an exercise's drift is only
 * trusted when its top-set weight is non-decreasing across the block.
 * If the lifter (or a deload week) cut weight mid-block, we return null
 * for that exercise rather than producing a misleading signal.
 *
 * Aggregation. Client-level drift = mean of per-exercise drifts. We
 * require at least 2 exercises to have a valid signal — a single
 * exercise's drift is noisy enough that one bad day can flip the gate.
 *
 * This is a practitioner heuristic, NOT validated by literature. The
 * brief is explicit about that — surface the caveat in the UI.
 *
 * Server-and-client safe — no node-only imports.
 */

const WEIGHT_TIE_EPSILON = 0.001;
const MIN_EXPOSURES_FOR_DRIFT = 3;
const MIN_EXERCISES_FOR_CLIENT_DRIFT = 2;

/** One workout's top-set summary for a given exercise. */
export type RirExposure = {
  workoutStartedAt: string; // ISO timestamp
  topWeight: number;
  topRir: number | null;
};

export type ClientRirDrift = {
  /** Mean per-exercise drift across exercises with a valid signal, or null
   *  when fewer than 2 exercises qualified. */
  drift: number | null;
  /** Number of exercises that contributed (had ≥3 RIR-logged exposures and
   *  non-decreasing weight across the block). */
  exerciseCount: number;
};

/**
 * Per-exercise drift. Returns null when:
 *   - fewer than 3 RIR-logged exposures, or
 *   - top-set weight decreased anywhere in the sequence (load isn't fixed)
 *
 * Exported for tests.
 */
export function computePerExerciseDrift(exposures: RirExposure[]): number | null {
  const valid = exposures
    .filter((e) => e.topRir != null)
    .slice()
    .sort((a, b) => a.workoutStartedAt.localeCompare(b.workoutStartedAt));

  if (valid.length < MIN_EXPOSURES_FOR_DRIFT) return null;

  // Load must be non-decreasing across the block. Any cut → uninterpretable.
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].topWeight < valid[i - 1].topWeight - WEIGHT_TIE_EPSILON) {
      return null;
    }
  }

  const mid = Math.floor(valid.length / 2);
  const earlyLen = mid;
  const lateLen = valid.length - mid;
  let earlySum = 0;
  let lateSum = 0;
  for (let i = 0; i < mid; i++) earlySum += valid[i].topRir!;
  for (let i = mid; i < valid.length; i++) lateSum += valid[i].topRir!;
  return earlySum / earlyLen - lateSum / lateLen;
}

/**
 * Client-level aggregation. Skips exercises where computePerExerciseDrift
 * returned null. Returns drift=null when fewer than 2 exercises contributed.
 *
 * Exported for tests.
 */
export function computeClientRirDrift(
  perExerciseExposures: Array<{ exerciseId: string; exposures: RirExposure[] }>,
): ClientRirDrift {
  const drifts: number[] = [];
  for (const { exposures } of perExerciseExposures) {
    const d = computePerExerciseDrift(exposures);
    if (d != null) drifts.push(d);
  }
  if (drifts.length < MIN_EXERCISES_FOR_CLIENT_DRIFT) {
    return { drift: null, exerciseCount: drifts.length };
  }
  const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  return { drift: mean, exerciseCount: drifts.length };
}

/**
 * Helper: distill a workout's per-set logs into the single (top weight,
 * RIR of top set) pair that drives drift. Picks the heaviest set; ties go
 * to higher reps (matches lib/session-summary topSetOf semantics so the
 * same exposure is what the cue treats as "the top set").
 *
 * Returns null when no set has both weight and reps logged.
 * Exported for tests.
 */
export function pickTopSetRir(
  sets: Array<{ weight: number | null; reps: number | null; rir: number | null }>,
): { topWeight: number; topRir: number | null } | null {
  let best: { weight: number; reps: number; rir: number | null } | null = null;
  for (const s of sets) {
    if (s.weight == null || s.reps == null) continue;
    if (
      best == null ||
      s.weight > best.weight + WEIGHT_TIE_EPSILON ||
      (Math.abs(s.weight - best.weight) <= WEIGHT_TIE_EPSILON && s.reps > best.reps)
    ) {
      best = { weight: s.weight, reps: s.reps, rir: s.rir };
    }
  }
  if (!best) return null;
  return { topWeight: best.weight, topRir: best.rir };
}
