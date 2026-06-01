/**
 * Pain incident classifier — sole computation site for suggestions.ts.
 * Pure, server-and-client safe. Replaces the old single-shot "any pain
 * → swap + fixed 20% load drop" with a graded traffic-light ladder
 * (Smith et al. 2017 BJSM pain-monitoring framework).
 *
 * Precedence: red_flag > recurring > mild.
 *
 *   mild      → no red-flag keywords AND not recurring on same
 *               exercise. Keep the exercise, reduce load
 *               ~PAIN_LOAD_REDUCTION_FIRST (15%), monitor next session.
 *               apply: null (load-reduction is coach-side for now).
 *
 *   recurring → same exercise flagged pain on ≥2 distinct weeks within
 *               the recent window, AND no red-flag keywords present.
 *               Swap to a same-pattern alternative. apply: swap_exercise.
 *
 *   red_flag  → at least one red-flag keyword in pain_reason or
 *               client_note (case-insensitive). Stop that movement,
 *               refer for coach review; do NOT auto-prescribe around
 *               acute sharp pain. apply: null.
 *
 * Red-flag keyword set (approved by the coach review):
 *   sharp | stab | shoot | pop | tear | tore | snap | acute | severe |
 *   numb | tingl | gave way | gave out | 8/10 | 9/10 | 10/10
 * Rationale for additions over the original list:
 *   - numb / tingl → neuro/radicular signs (should never be loaded
 *     around).
 *   - gave way / gave out → instability or structural failure.
 *   - tore / snap → injury verbs.
 *   - 8-9/10 numeric severity → red-flag tier alongside 10/10.
 */

/** Existing mild-pain matcher, used to confirm a pain-flagged log is
 *  more than noise before classifying. Mirrors the regex that
 *  suggestions.ts has used since v1. */
export const MILD_PAIN_REGEX = /pain|hurt|injur|tweak|sharp|sore.*bad/i;

/**
 * Red-flag matcher. Word-boundaried where reasonable; numeric severity
 * intentionally permissive on whitespace and slash variants.
 */
export const RED_FLAG_PAIN_REGEX =
  /\b(?:sharp|stab\w*|shoot\w*|pop\w*|tear|tore|snap\w*|acute|severe|numb\w*|tingl\w*)\b|gave\s+(?:way|out)|(?:8|9|10)\s*\/\s*10/i;

export type PainStage = 'mild' | 'recurring' | 'red_flag';

export type PainClassification = {
  stage: PainStage;
  /** Short snippet from the original text that triggered the
   *  classification — surface to the coach so they can see WHY the
   *  classifier landed where it did, not just THAT it did. */
  triggerSnippet: string;
};

/**
 * Classify a single pain-flagged exercise_log. Returns null when there
 * is no pain signal at all (the log shouldn't have been considered).
 * Callers decide flagged-ness upstream — usually `pain_reason != null`
 * OR MILD_PAIN_REGEX matches client_note.
 */
export function classifyPainIncident(input: {
  painReason: string | null;
  clientNote: string | null;
  /** True when the same exercise_id has flagged pain on ≥2 distinct
   *  calendar weeks within the recent window. Caller computes this
   *  from the pain history. */
  recurringOnSameExercise: boolean;
}): PainClassification | null {
  const combined = `${input.painReason ?? ''} ${input.clientNote ?? ''}`.trim();
  if (combined.length === 0 && !input.recurringOnSameExercise) return null;

  // 1. Red-flag wins regardless of recurrence.
  const redMatch = combined.match(RED_FLAG_PAIN_REGEX);
  if (redMatch) {
    return {
      stage: 'red_flag',
      triggerSnippet: redMatch[0],
    };
  }

  // 2. Recurring (same exercise, 2+ weeks) — swap-track.
  if (input.recurringOnSameExercise) {
    return {
      stage: 'recurring',
      triggerSnippet: combined.slice(0, 80),
    };
  }

  // 3. Mild — only if there's an actual pain signal in the text.
  if (combined.length > 0 && (input.painReason || MILD_PAIN_REGEX.test(combined))) {
    return {
      stage: 'mild',
      triggerSnippet: combined.slice(0, 80),
    };
  }

  return null;
}
