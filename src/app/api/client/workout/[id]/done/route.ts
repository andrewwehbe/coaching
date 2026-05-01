import { NextResponse } from 'next/server';

import { db } from '@/lib/supabase';
import { loadOpenClientWorkout } from '@/lib/workout-guard';
import { insertAlert } from '@/lib/notify';

type Params = Promise<{ id: string }>;

export async function POST(_req: Request, props: { params: Params }) {
  const { id } = await props.params;
  const ctx = await loadOpenClientWorkout(id);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supa = db();

  const { count } = await supa
    .from('exercise_logs')
    .select('id', { count: 'exact', head: true })
    .eq('workout_id', ctx.workout.id);

  const { error } = await supa
    .from('workouts')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', ctx.workout.id);
  if (error) {
    return NextResponse.json({ error: 'Failed to complete' }, { status: 500 });
  }

  await insertAlert({
    clientId: ctx.user.id,
    type: 'workout_completed',
    message: `${ctx.user.name} finished a workout (${count ?? 0} exercises).`,
    data: { workout_id: ctx.workout.id },
  });

  return NextResponse.json({ ok: true });
}
