/**
 * Normalize an exercise name into the key used to dedupe "the same
 * exercise" across days/programs. Lowercase, trim, collapse internal
 * whitespace, strip trailing punctuation. Persisted to
 * exercises.name_key and used by best_efforts and stalled_history.
 */
export function normalize(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .trim()
    .replace(/[\s\-_.,;:!?'"()[\]{}]+$/g, '');
}
