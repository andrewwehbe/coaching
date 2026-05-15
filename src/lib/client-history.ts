import 'server-only';

import { startOfWeek, formatISO, addWeeks, isBefore, isEqual } from 'date-fns';

import { db } from './supabase';

export type WeekRow = {
  weekStart: string;
  daysDone: number;
  daysTarget: number;
  totalSets: number;
  prCount: number;
  painCount: number;
  hasWorkouts: boolean;
};

/**
 * Pure: enumerate every ISO Monday (yyyy-mm-dd) from `startIso` through
 * `endIso` inclusive. Inputs are snapped to the Monday of their week
 * (weekStartsOn: 1). Returns [] when start > end. Exported for tests.
 */
export function enumerateMondaysBetween(startIso: string, endIso: string): string[] {
  const start = startOfWeek(new Date(`${startIso}T00:00:00Z`), { weekStartsOn: 1 });
  const end = startOfWeek(new Date(`${endIso}T00:00:00Z`), { weekStartsOn: 1 });
  if (isBefore(end, start)) return [];
  const out: string[] = [];
  let cur = start;
  while (isBefore(cur, end) || isEqual(cur, end)) {
    out.push(formatISO(cur, { representation: 'date' }));
    cur = addWeeks(cur, 1);
  }
  return out;
}

/**
 * Returns one row per ISO week from the client's program training_start_at
 * (or uploaded_at fallback) through the current ISO Monday. Empty weeks
 * appear with hasWorkouts=false. Returns null when the client doesn't exist.
 */
export async function listClientWeeks(
  clientId: string,
  at: Date = new Date(),
): Promise<WeekRow[] | null> {
  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, weekly_day_target')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return null;

  const { data: program } = await supa
    .from('programs')
    .select('uploaded_at, training_start_at')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!program) return [];

  const anchorIso = (program.training_start_at ?? program.uploaded_at).slice(0, 10);
  const todayIso = formatISO(at, { representation: 'date' });
  const weeks = enumerateMondaysBetween(anchorIso, todayIso);
  if (weeks.length === 0) return [];

  // Pull every completed workout in range (cap at first week start).
  const rangeStart = weeks[0];
  const [{ data: workouts }, { data: prs }] = await Promise.all([
    supa
      .from('workouts')
      .select('id, week_start, completed_at')
      .eq('client_id', clientId)
      .gte('week_start', rangeStart)
      .not('completed_at', 'is', null),
    supa
      .from('best_efforts')
      .select('updated_at')
      .eq('client_id', clientId)
      .gte('updated_at', `${rangeStart}T00:00:00Z`)
      .not('source_set_id', 'is', null),
  ]);

  const workoutIds = (workouts ?? []).map((w) => w.id);
  const { data: logs } = workoutIds.length
    ? await supa
        .from('exercise_logs')
        .select('id, workout_id, pain_reason')
        .in('workout_id', workoutIds)
    : { data: [] as Array<{ id: string; workout_id: string; pain_reason: string | null }> };

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa.from('sets').select('exercise_log_id').in('exercise_log_id', logIds)
    : { data: [] as Array<{ exercise_log_id: string }> };

  // Aggregate by week_start.
  type Bucket = { daysDone: number; totalSets: number; prCount: number; painCount: number };
  const byWeek = new Map<string, Bucket>();
  for (const wk of weeks) {
    byWeek.set(wk, { daysDone: 0, totalSets: 0, prCount: 0, painCount: 0 });
  }
  const workoutToWeek = new Map<string, string>();
  for (const w of workouts ?? []) {
    workoutToWeek.set(w.id, w.week_start);
    const b = byWeek.get(w.week_start);
    if (b) b.daysDone++;
  }
  const logToWorkout = new Map<string, string>();
  for (const l of logs ?? []) {
    logToWorkout.set(l.id, l.workout_id);
    if (l.pain_reason) {
      const wk = workoutToWeek.get(l.workout_id);
      const b = wk ? byWeek.get(wk) : null;
      if (b) b.painCount++;
    }
  }
  for (const s of sets ?? []) {
    const wkid = logToWorkout.get(s.exercise_log_id);
    const wk = wkid ? workoutToWeek.get(wkid) : null;
    const b = wk ? byWeek.get(wk) : null;
    if (b) b.totalSets++;
  }
  for (const pr of prs ?? []) {
    // Bucket the PR into the week containing pr.updated_at (Monday-of-week).
    const wk = formatISO(startOfWeek(new Date(pr.updated_at), { weekStartsOn: 1 }), {
      representation: 'date',
    });
    const b = byWeek.get(wk);
    if (b) b.prCount++;
  }

  const result: WeekRow[] = [];
  // Newest first.
  for (let i = weeks.length - 1; i >= 0; i--) {
    const wk = weeks[i];
    const b = byWeek.get(wk)!;
    result.push({
      weekStart: wk,
      daysDone: b.daysDone,
      daysTarget: client.weekly_day_target,
      totalSets: b.totalSets,
      prCount: b.prCount,
      painCount: b.painCount,
      hasWorkouts: b.daysDone > 0,
    });
  }
  return result;
}

export type WorkoutRow = {
  id: string;
  dayLabel: string;
  startedAt: string;
  completedAt: string | null;
  isMissed: boolean;
  setCount: number;
  prCount: number;
  painCount: number;
};

/**
 * Returns workouts in a given ISO week for a client, sorted by started_at
 * ascending. Returns null when:
 *   - The client doesn't exist.
 *   - `weekStart` is not a valid YYYY-MM-DD Monday.
 *   - `weekStart` falls outside the program's range.
 */
export async function getWeekWorkouts(
  clientId: string,
  weekStart: string,
  at: Date = new Date(),
): Promise<WorkoutRow[] | null> {
  // Validate format + ISO-Monday + within program range.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  const wkDate = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(wkDate.getTime())) return null;
  // ISO Monday: getUTCDay() === 1.
  if (wkDate.getUTCDay() !== 1) return null;

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return null;

  const { data: program } = await supa
    .from('programs')
    .select('uploaded_at, training_start_at')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!program) return null;

  const anchorIso = (program.training_start_at ?? program.uploaded_at).slice(0, 10);
  const todayIso = formatISO(at, { representation: 'date' });
  const allowed = enumerateMondaysBetween(anchorIso, todayIso);
  if (!allowed.includes(weekStart)) return null;

  const { data: workouts } = await supa
    .from('workouts')
    .select('id, day_id, started_at, completed_at, is_missed, days(label)')
    .eq('client_id', clientId)
    .eq('week_start', weekStart)
    .order('started_at', { ascending: true });

  if (!workouts || workouts.length === 0) return [];

  const ids = workouts.map((w) => w.id);
  const { data: logs } = await supa
    .from('exercise_logs')
    .select('id, workout_id, pain_reason')
    .in('workout_id', ids);

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('id, exercise_log_id')
        .in('exercise_log_id', logIds)
    : { data: [] as Array<{ id: string; exercise_log_id: string }> };

  // PRs for this week (best_efforts updated within the week).
  const nextMonday = formatISO(addWeeks(new Date(`${weekStart}T00:00:00Z`), 1), {
    representation: 'date',
  });
  const { data: prs } = await supa
    .from('best_efforts')
    .select('source_set_id, updated_at')
    .eq('client_id', clientId)
    .gte('updated_at', `${weekStart}T00:00:00Z`)
    .lt('updated_at', `${nextMonday}T00:00:00Z`)
    .not('source_set_id', 'is', null);

  const setIdToWorkout = new Map<string, string>();
  const logToWorkout = new Map<string, string>();
  for (const l of logs ?? []) logToWorkout.set(l.id, l.workout_id);
  for (const s of sets ?? []) {
    const wid = logToWorkout.get(s.exercise_log_id);
    if (wid) setIdToWorkout.set(s.id, wid);
  }

  const setCount = new Map<string, number>();
  for (const s of sets ?? []) {
    const wid = logToWorkout.get(s.exercise_log_id);
    if (!wid) continue;
    setCount.set(wid, (setCount.get(wid) ?? 0) + 1);
  }

  const painCount = new Map<string, number>();
  for (const l of logs ?? []) {
    if (l.pain_reason) painCount.set(l.workout_id, (painCount.get(l.workout_id) ?? 0) + 1);
  }

  const prCount = new Map<string, number>();
  for (const pr of prs ?? []) {
    if (!pr.source_set_id) continue;
    const wid = setIdToWorkout.get(pr.source_set_id);
    if (!wid) continue;
    prCount.set(wid, (prCount.get(wid) ?? 0) + 1);
  }

  return workouts.map((w) => {
    const daysRaw = w.days as unknown;
    const day = (Array.isArray(daysRaw) ? daysRaw[0] : daysRaw) as { label?: string } | null;
    return {
      id: w.id,
      dayLabel: day?.label ?? '—',
      startedAt: w.started_at,
      completedAt: w.completed_at,
      isMissed: !!w.is_missed,
      setCount: setCount.get(w.id) ?? 0,
      prCount: prCount.get(w.id) ?? 0,
      painCount: painCount.get(w.id) ?? 0,
    };
  });
}
