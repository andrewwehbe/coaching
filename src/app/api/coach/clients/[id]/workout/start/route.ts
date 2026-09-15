import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startOfWeek, formatISO } from 'date-fns';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

const Body = z.object({ dayId: z.string().uuid() });

type Params = Promise<{ id: string }>;

/**
 * Coach starts (or resumes) a PT client's session, then drives the normal
 * client logger at /workout/[id]. Mirrors /api/client/workout/start minus
 * the self-alert. Only PT clients: online clients start their own sessions
 * and the workout screen refuses a coach session on them.
 */
export async function POST(req: Request, props: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id: clientId } = await props.params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const [{ data: client }, { data: day }] = await Promise.all([
    supa
      .from('clients')
      .select('id, active, client_type')
      .eq('id', clientId)
      .maybeSingle(),
    supa
      .from('days')
      .select('id, program_id, programs!inner(client_id, active)')
      .eq('id', parsed.data.dayId)
      .maybeSingle(),
  ]);
  if (!client || !client.active || client.client_type !== 'pt') {
    return NextResponse.json({ error: 'Not a PT client' }, { status: 404 });
  }
  // @ts-expect-error supabase nested join typing
  if (!day || day.programs?.client_id !== clientId || !day.programs?.active) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const weekStartIso = formatISO(startOfWeek(new Date(), { weekStartsOn: 1 }), {
    representation: 'date',
  });

  const [{ data: existing }, { data: deload }] = await Promise.all([
    supa
      .from('workouts')
      .select('id, completed_at')
      .eq('client_id', clientId)
      .eq('day_id', parsed.data.dayId)
      .gte('week_start', weekStartIso)
      .order('started_at', { ascending: false })
      .limit(1),
    supa
      .from('client_deload_weeks')
      .select('client_id')
      .eq('client_id', clientId)
      .eq('week_start', weekStartIso)
      .maybeSingle(),
  ]);

  const open = existing?.find((w) => !w.completed_at);
  if (open) {
    return NextResponse.json({ workoutId: open.id, resumed: true });
  }

  const { data: workout, error } = await supa
    .from('workouts')
    .insert({
      client_id: clientId,
      day_id: parsed.data.dayId,
      week_start: weekStartIso,
      is_deload: !!deload,
    })
    .select('id')
    .single();
  if (error || !workout) {
    return NextResponse.json({ error: 'Failed to start workout' }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'pt_workout_started',
    targetType: 'workout',
    targetId: workout.id,
    details: { client_id: clientId, day_id: parsed.data.dayId },
  });

  return NextResponse.json({ workoutId: workout.id, resumed: false });
}
