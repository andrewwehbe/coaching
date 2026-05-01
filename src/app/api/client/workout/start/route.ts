import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startOfWeek, formatISO } from 'date-fns';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

const Body = z.object({ dayId: z.string().uuid() });

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

  // Verify the day belongs to a program owned by this client.
  const { data: day } = await supa
    .from('days')
    .select('id, program_id, programs!inner(client_id)')
    .eq('id', parsed.data.dayId)
    .maybeSingle();
  // @ts-expect-error supabase nested join typing
  if (!day || day.programs?.client_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

  // Resume in-progress workout for the same day this week if one exists.
  const { data: existing } = await supa
    .from('workouts')
    .select('id, completed_at')
    .eq('client_id', user.id)
    .eq('day_id', parsed.data.dayId)
    .gte('week_start', formatISO(weekStart, { representation: 'date' }))
    .order('started_at', { ascending: false })
    .limit(1);

  const open = existing?.find((w) => !w.completed_at);
  if (open) {
    return NextResponse.json({ workoutId: open.id, resumed: true });
  }

  const { data: workout, error } = await supa
    .from('workouts')
    .insert({
      client_id: user.id,
      day_id: parsed.data.dayId,
      week_start: formatISO(weekStart, { representation: 'date' }),
    })
    .select('id')
    .single();
  if (error) {
    return NextResponse.json({ error: 'Failed to start workout' }, { status: 500 });
  }

  // Fire a coach alert (workout_started).
  await supa.from('alerts').insert({
    client_id: user.id,
    type: 'workout_started',
    message: `${user.name} started a workout.`,
    data: { workout_id: workout.id, day_id: parsed.data.dayId },
  });

  return NextResponse.json({ workoutId: workout.id, resumed: false });
}
