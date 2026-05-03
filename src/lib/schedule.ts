import 'server-only';

import { startOfWeek, formatISO, differenceInCalendarDays } from 'date-fns';

import { db } from './supabase';

export type ScheduledDay = {
  dayId: string;
  dayIndex: number;
  label: string;
  status: 'done' | 'upcoming' | 'in_progress' | 'missed';
  workoutId?: string;
};

export type TodaySchedule = {
  programId: string | null;
  weekStart: Date;
  days: ScheduledDay[];
  /** The day the app suggests opening when the client taps "Begin". */
  suggested: ScheduledDay | null;
  /** True if the client has logged sessions on each of the prior 2 days. */
  threeInARowWarning: boolean;
};

/**
 * Build the client's "today" view: their program's days, marked done /
 * upcoming / in-progress for the current calendar week, plus a suggestion
 * for which day to open and a 3-in-a-row warning if applicable.
 */
export async function buildTodaySchedule(clientId: string): Promise<TodaySchedule> {
  const supa = db();
  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday

  // thisWeek + recent only depend on clientId + dates, so we can run them
  // in parallel with the program lookup. days needs program.id, so it stays
  // sequential after program.
  const since = new Date(now);
  since.setDate(since.getDate() - 2);

  const [
    { data: program },
    { data: thisWeek },
    { data: recent },
  ] = await Promise.all([
    supa
      .from('programs')
      .select('id')
      .eq('client_id', clientId)
      .eq('active', true)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from('workouts')
      .select('id, day_id, completed_at, started_at, is_missed')
      .eq('client_id', clientId)
      .gte('week_start', formatISO(weekStart, { representation: 'date' })),
    supa
      .from('workouts')
      .select('started_at, completed_at')
      .eq('client_id', clientId)
      .gte('started_at', since.toISOString()),
  ]);

  if (!program) {
    return {
      programId: null,
      weekStart,
      days: [],
      suggested: null,
      threeInARowWarning: false,
    };
  }

  const { data: days } = await supa
    .from('days')
    .select('id, day_index, label')
    .eq('program_id', program.id)
    .order('day_index');

  const trainedDays = new Set<number>();
  for (const w of recent ?? []) {
    if (!w.completed_at) continue;
    const d = differenceInCalendarDays(now, new Date(w.completed_at));
    if (d >= 0 && d <= 2) trainedDays.add(d);
  }
  const threeInARowWarning = trainedDays.has(1) && trainedDays.has(2);

  const byDayId = new Map<string, { id: string; completed_at: string | null; started_at: string; is_missed: boolean | null }>();
  for (const w of thisWeek ?? []) {
    // Keep the latest workout per day.
    const existing = byDayId.get(w.day_id);
    if (!existing || new Date(w.started_at) > new Date(existing.started_at)) {
      byDayId.set(w.day_id, w);
    }
  }

  const scheduled: ScheduledDay[] = (days ?? []).map((d) => {
    const w = byDayId.get(d.id);
    let status: ScheduledDay['status'] = 'upcoming';
    if (w) {
      if (w.is_missed) status = 'missed';
      else if (w.completed_at) status = 'done';
      else status = 'in_progress';
    }
    return {
      dayId: d.id,
      dayIndex: d.day_index,
      label: d.label,
      status,
      workoutId: w?.id,
    };
  });

  // Suggested day: first in_progress, else first upcoming, else null.
  // (Missed days are explicitly *not* suggested — client said they won't do it.)
  const suggested =
    scheduled.find((d) => d.status === 'in_progress') ??
    scheduled.find((d) => d.status === 'upcoming') ??
    null;

  return {
    programId: program.id,
    weekStart,
    days: scheduled,
    suggested,
    threeInARowWarning,
  };
}
