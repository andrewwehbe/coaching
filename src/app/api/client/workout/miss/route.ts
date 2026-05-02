import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startOfWeek, formatISO } from 'date-fns';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { insertAlert } from '@/lib/notify';

const Body = z.object({ dayId: z.string().uuid() });

/**
 * Mark a day as missed for this calendar week. Inserts a workout row with
 * is_missed=true so the day no longer shows as upcoming on /today and the
 * coach sees a "missed" indicator in history.
 */
export async function POST(req: Request) {
  const user = await readSession();
  if (!user || user.type !== 'client' || !user.active) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const { data: day } = await supa
    .from('days')
    .select('id, label, programs!inner(client_id)')
    .eq('id', parsed.data.dayId)
    .maybeSingle();
  // @ts-expect-error nested join typing
  if (!day || day.programs?.client_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });

  // If they already have a workout for this day this week (in-progress or
  // skeleton), just flip is_missed and stamp completed_at. Don't create a
  // duplicate row.
  const { data: existing } = await supa
    .from('workouts')
    .select('id')
    .eq('client_id', user.id)
    .eq('day_id', parsed.data.dayId)
    .eq('week_start', weekStartIso)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = new Date();
  if (existing) {
    await supa
      .from('workouts')
      .update({ is_missed: true, completed_at: now.toISOString() })
      .eq('id', existing.id);
  } else {
    await supa.from('workouts').insert({
      client_id: user.id,
      day_id: parsed.data.dayId,
      started_at: now.toISOString(),
      completed_at: now.toISOString(),
      week_start: weekStartIso,
      is_missed: true,
      is_deload: false,
    });
  }

  await insertAlert({
    clientId: user.id,
    type: 'missed_workout',
    message: `${user.name} marked ${day.label} as missed.`,
    data: { day_id: parsed.data.dayId },
  });

  return NextResponse.json({ ok: true });
}
