/**
 * Normalize a raw exercise name. Lowercase, collapse whitespace, strip
 * trailing punctuation. Used as the building block for scoped name_keys.
 */
export function normalize(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .trim()
    .replace(/[\s\-_.,;:!?'"()[\]{}]+$/g, '');
}

/**
 * Per-day scoped key used for `exercises.name_key`, `best_efforts.exercise_name_key`,
 * and `stalled_history.exercise_name_key`. Same exercise name on different days
 * (e.g. SLDL on Day 2 vs Day 4) tracks bests + plateau independently — different
 * fatigue contexts produce different rep counts, so they shouldn't share a "beat
 * X reps" target. Day_index is the scope so re-uploading a sheet with the same
 * day order preserves history.
 */
export function nameKeyFor(dayIndex: number, exerciseName: string): string {
  return `d${dayIndex}::${normalize(exerciseName)}`;
}
