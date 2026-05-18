import 'server-only';

import { startOfWeek, formatISO } from 'date-fns';

import { db } from './supabase';

export type CheckInStatus =
  | { enabled: false }
  | {
      enabled: true;
      /** Granularity the client is on. */
      period: 'day' | 'week';
      /** How many check-ins are expected per period. */
      target: number;
      /** How many check-ins were submitted this period. */
      done: number;
      /** True when the client owes another check-in in this period. */
      due: boolean;
      /** Date of the most recent check-in this period, if any. */
      lastDate: string | null;
    };

type ClientFields = {
  id: string;
  body_weight_freq: 'none' | 'daily' | '3x' | 'weekly';
  photo_check_in_enabled: boolean;
};

/**
 * The user wants the weekly check-in CTA visible Sunday → next Sunday so
 * clients who train mid-week still see it (ClientF missed it this Monday).
 * Workout weeks use Monday in schedule.ts; check-ins use Sunday here
 * deliberately — different cadence, different week anchor.
 */
function weekStartSunday(now: Date): Date {
  return startOfWeek(now, { weekStartsOn: 0 });
}

export async function getCheckInStatus(client: ClientFields): Promise<CheckInStatus> {
  const dailyWeight = client.body_weight_freq === 'daily';
  const threeXWeight = client.body_weight_freq === '3x';
  const weeklyWeight = client.body_weight_freq === 'weekly';
  const photoEnabled = client.photo_check_in_enabled;

  if (!dailyWeight && !threeXWeight && !weeklyWeight && !photoEnabled) {
    return { enabled: false };
  }

  const supa = db();
  const now = new Date();

  if (dailyWeight) {
    const todayIso = formatISO(now, { representation: 'date' });
    const { data } = await supa
      .from('check_ins')
      .select('date')
      .eq('client_id', client.id)
      .eq('date', todayIso)
      .maybeSingle();
    return {
      enabled: true,
      period: 'day',
      target: 1,
      done: data ? 1 : 0,
      due: !data,
      lastDate: data?.date ?? null,
    };
  }

  const weekStartIso = formatISO(weekStartSunday(now), { representation: 'date' });
  const { data: rows } = await supa
    .from('check_ins')
    .select('date')
    .eq('client_id', client.id)
    .gte('date', weekStartIso)
    .order('date', { ascending: false });

  const done = rows?.length ?? 0;
  const target = threeXWeight ? 3 : 1;
  return {
    enabled: true,
    period: 'week',
    target,
    done,
    due: done < target,
    lastDate: rows?.[0]?.date ?? null,
  };
}
