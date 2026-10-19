/**
 * Auto-finish for sessions nobody closed. Clients (and the coach, on PT
 * sessions) often log every set and never tap Finish. The session then
 * counts for nothing: not in adherence, and not in the progression
 * engine, which reads completed workouts only. Pure so tests can import it.
 */

export type OpenWorkoutActivity = {
  id: string;
  exercise_logs: Array<{
    created_at: string;
    sets: Array<{ created_at: string }> | null;
  }> | null;
};

/**
 * The open workouts to finish now, each stamped at its last logged set
 * (or skip/pain log), so the session keeps its real day and duration.
 * A workout with nothing logged is left alone: there is no session to
 * keep, and the client may be about to start.
 */
export function pickIdleWorkouts(
  rows: OpenWorkoutActivity[],
  nowMs: number,
  idleMs: number
): Array<{ id: string; completedAt: string }> {
  const out: Array<{ id: string; completedAt: string }> = [];
  for (const w of rows) {
    let last = -Infinity;
    for (const l of w.exercise_logs ?? []) {
      last = Math.max(last, Date.parse(l.created_at));
      for (const s of l.sets ?? []) last = Math.max(last, Date.parse(s.created_at));
    }
    if (!Number.isFinite(last) || nowMs - last < idleMs) continue;
    out.push({ id: w.id, completedAt: new Date(last).toISOString() });
  }
  return out;
}
