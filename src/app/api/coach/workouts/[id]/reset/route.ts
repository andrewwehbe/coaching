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
    .select('id, client_id')
    .eq('id', id)
    .maybeSingle();
  if (!workout) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await supa.from('workouts').delete().eq('id', id);
  return NextResponse.json({ ok: true });
}
