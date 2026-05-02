import { NextResponse } from 'next/server';

import { db } from '@/lib/supabase';
import { loadOpenClientWorkout } from '@/lib/workout-guard';

type Params = Promise<{ id: string }>;

/**
 * Cancel an open workout — deletes the row entirely along with any logged
 * sets / exercise_logs (cascade). Treats the session as if it never
 * happened. Used when a client tapped "Begin" just to peek and now wants
 * to back out, even after logging something.
 */
export async function POST(_req: Request, props: { params: Params }) {
  const { id } = await props.params;
  const ctx = await loadOpenClientWorkout(id);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supa = db();
  await supa.from('workouts').delete().eq('id', id);
  return NextResponse.json({ ok: true });
}
