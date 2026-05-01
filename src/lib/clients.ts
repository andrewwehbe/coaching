import 'server-only';

import { startOfWeek, formatISO, subDays } from 'date-fns';

import { db } from './supabase';

export type ClientStatus = 'on_track' | 'behind' | 'inactive' | 'pain';

export type ClientSummary = {
  id: string;
  name: string;
  active: boolean;
  weeklyDayTarget: number;
  daysLoggedThisWeek: number;
  lastActivityAt: string | null;
  status: ClientStatus;
  unackPainCount: number;
};

/**
 * Roll up every client into a single summary row for the coach dashboard.
 * Status:
 *   - inactive: not active OR no completed workout in the last 14 days
 *   - pain: has any unacknowledged pain alert
 *   - behind: behind weekly_day_target with <= 1 day remaining in the week
 *             (or no activity in last 7 days while active)
 *   - on_track: everything else
 */
export async function listClientSummaries(): Promise<ClientSummary[]> {
  const supa = db();
  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });
  const fourteenDaysAgo = subDays(now, 14).toISOString();
  const sevenDaysAgo = subDays(now, 7).toISOString();

  const { data: clients } = await supa
    .from('clients')
    .select('id, name, active, weekly_day_target, deactivated_at')
    .order('created_at', { ascending: true });

  if (!clients || clients.length === 0) return [];

  const ids = clients.map((c) => c.id);

  const [{ data: weekWorkouts }, { data: lastWorkouts }, { data: painAlerts }] = await Promise.all([
    supa
      .from('workouts')
      .select('client_id, day_id, completed_at, started_at')
      .in('client_id', ids)
      .gte('week_start', weekStartIso),
    supa
      .from('workouts')
      .select('client_id, started_at, completed_at')
      .in('client_id', ids)
      .order('started_at', { ascending: false }),
    supa
      .from('alerts')
      .select('client_id')
      .in('client_id', ids)
      .eq('type', 'pain')
      .is('acknowledged_at', null),
  ]);

  const daysByClient = new Map<string, Set<string>>();
  for (const w of weekWorkouts ?? []) {
    if (!w.completed_at) continue;
    const set = daysByClient.get(w.client_id) ?? new Set<string>();
    set.add(w.day_id);
    daysByClient.set(w.client_id, set);
  }

  const lastActivityByClient = new Map<string, string>();
  for (const w of lastWorkouts ?? []) {
    if (lastActivityByClient.has(w.client_id)) continue;
    const ts = w.completed_at ?? w.started_at;
    if (ts) lastActivityByClient.set(w.client_id, ts);
  }

  const painCountByClient = new Map<string, number>();
  for (const a of painAlerts ?? []) {
    painCountByClient.set(a.client_id, (painCountByClient.get(a.client_id) ?? 0) + 1);
  }

  // Day-of-week (Mon=0 … Sun=6).
  const dow = (now.getDay() + 6) % 7;
  const daysLeftInWeek = 6 - dow;

  return clients.map((c) => {
    const daysLogged = daysByClient.get(c.id)?.size ?? 0;
    const lastActivityAt = lastActivityByClient.get(c.id) ?? null;
    const painCount = painCountByClient.get(c.id) ?? 0;

    let status: ClientStatus;
    if (!c.active) {
      status = 'inactive';
    } else if (painCount > 0) {
      status = 'pain';
    } else if (!lastActivityAt || lastActivityAt < fourteenDaysAgo) {
      status = 'inactive';
    } else {
      const target = c.weekly_day_target ?? 4;
      const behindByVolume = daysLogged + daysLeftInWeek < target;
      const stale = !lastActivityAt || lastActivityAt < sevenDaysAgo;
      status = behindByVolume || stale ? 'behind' : 'on_track';
    }

    return {
      id: c.id,
      name: c.name,
      active: c.active,
      weeklyDayTarget: c.weekly_day_target,
      daysLoggedThisWeek: daysLogged,
      lastActivityAt,
      status,
      unackPainCount: painCount,
    };
  });
}
