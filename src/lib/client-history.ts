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

export type SetDetail = {
  setNumber: number;
  weight: number | null;
  unit: 'kg' | 'lb' | null;
  reps: number | null;
  rir: number | null;
  videoUrl: string | null;
  notes: string | null;
  isPR: boolean;
};

export type ExerciseLogDetail = {
  exerciseId: string;
  name: string;
  prescribedSets: number | null;
  prescriptionRaw: string | null;
  painReason: string | null;
  clientNote: string | null;
  sets: SetDetail[];
};

export type WorkoutDetail = {
  workout: {
    id: string;
    clientId: string;
    dayLabel: string;
    startedAt: string;
    completedAt: string | null;
    weekStart: string;
  };
  exercises: ExerciseLogDetail[];
};

/**
 * Full per-set workout log. Returns null when the workout doesn't exist or
 * doesn't belong to the given client/week.
 */
export async function getWorkoutDetail(
  clientId: string,
  weekStart: string,
  workoutId: string,
): Promise<WorkoutDetail | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  const supa = db();

  const { data: workout } = await supa
    .from('workouts')
    .select(
      'id, client_id, day_id, started_at, completed_at, week_start, days(label)',
    )
    .eq('id', workoutId)
    .maybeSingle();
  if (!workout) return null;
  if (workout.client_id !== clientId) return null;
  if (workout.week_start !== weekStart) return null;

  const { data: logs } = await supa
    .from('exercise_logs')
    .select(
      'id, exercise_id, pain_reason, client_note, exercises(name, prescribed_sets, prescription_raw, position)',
    )
    .eq('workout_id', workoutId);

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('id, exercise_log_id, set_number, weight, unit, reps, rir, video_url, notes')
        .in('exercise_log_id', logIds)
        .order('set_number', { ascending: true })
    : { data: [] as Array<{
        id: string;
        exercise_log_id: string;
        set_number: number;
        weight: number | string | null;
        unit: string | null;
        reps: number | null;
        rir: number | null;
        video_url: string | null;
        notes: string | null;
      }> };

  // PR set ids for this client.
  const { data: prs } = await supa
    .from('best_efforts')
    .select('source_set_id')
    .eq('client_id', clientId)
    .not('source_set_id', 'is', null);

  const prSetIds = new Set<string>();
  for (const p of prs ?? []) if (p.source_set_id) prSetIds.add(p.source_set_id);

  const setsByLog = new Map<string, SetDetail[]>();
  for (const s of sets ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      setNumber: s.set_number,
      weight: s.weight === null ? null : Number(s.weight),
      unit: s.unit === 'kg' || s.unit === 'lb' ? s.unit : null,
      reps: s.reps,
      rir: s.rir,
      videoUrl: s.video_url,
      notes: s.notes,
      isPR: prSetIds.has(s.id),
    });
    setsByLog.set(s.exercise_log_id, arr);
  }

  const exercises: ExerciseLogDetail[] = (logs ?? [])
    .map((l) => {
      const exRaw = l.exercises as unknown;
      const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as
        | { name?: string; prescribed_sets?: number | null; prescription_raw?: string | null; position?: number }
        | null;
      return {
        exerciseId: l.exercise_id,
        name: ex?.name ?? '—',
        prescribedSets: ex?.prescribed_sets ?? null,
        prescriptionRaw: ex?.prescription_raw ?? null,
        painReason: l.pain_reason,
        clientNote: l.client_note,
        sets: setsByLog.get(l.id) ?? [],
        _position: ex?.position ?? 0,
      };
    })
    .sort((a, b) => a._position - b._position)
    .map(({ _position, ...rest }) => rest);

  const daysRaw = workout.days as unknown;
  const day = (Array.isArray(daysRaw) ? daysRaw[0] : daysRaw) as { label?: string } | null;

  return {
    workout: {
      id: workout.id,
      clientId: workout.client_id,
      dayLabel: day?.label ?? '—',
      startedAt: workout.started_at,
      completedAt: workout.completed_at,
      weekStart: workout.week_start,
    },
    exercises,
  };
}
