/**
 * Cue computation. Runs server-side; produces a structured object the UI
 * renders (rather than the string-only "← GOAL: …" from the Apps Script).
 *
 * Best-set rule: max weight; on ties, max reps.
 * Cue rule:
 *   - No prior best  → "Log your first set."
 *   - Last reps < top of prescribed range → KEEP the weight, BEAT the last reps.
 *   - Last reps ≥ top of prescribed range → BEAT the weight, hit at least bottom reps.
 */
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

export function buildCue(best: Best | null, rx: Prescription): Cue {
  if (!best || best.weight == null || best.reps == null) {
    return { kind: 'first' };
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
