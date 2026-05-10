import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';

type Params = Promise<{ id: string }>;

/**
 * Coach-side reset: hard-delete a workout that the client started by
 * mistake. Cascade drops exercise_logs + sets so the day shows as
 * upcoming again on the client's /today.
 */
export async function POST(_req: Request, props: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await props.params;

  const supa = db();
  const { data: workout } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at')
    .eq('id', id)
    .maybeSingle();
  if (!workout) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Snapshot the row into the audit details before we delete — destructive
  // and irreversible, so we want a record of what was wiped and when.
  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: guard.user.id,
    action: 'workout.reset',
    target_type: 'workout',
    target_id: workout.id,
    details: {
      client_id: workout.client_id,
      day_id: workout.day_id,
      started_at: workout.started_at,
      completed_at: workout.completed_at,
    },
  });

  await supa.from('workouts').delete().eq('id', id);
  return NextResponse.json({ ok: true });
}
