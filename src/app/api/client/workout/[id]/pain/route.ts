import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/lib/supabase';
import { loadOpenClientWorkout } from '@/lib/workout-guard';
import { insertAlert } from '@/lib/notify';

const Body = z.object({
  exerciseId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  // false (default): pain == skip the exercise; status becomes 'pain' and the
  // workout advances. true: client chose to continue logging this exercise
  // anyway. Status stays 'completed' so the regular /set route can keep
  // upserting sets, but pain_reason is still recorded and the coach is
  // alerted just the same.
  proceed: z.boolean().optional(),
});

type Params = Promise<{ id: string }>;

export async function POST(req: Request, props: { params: Params }) {
  const { id } = await props.params;
  const ctx = await loadOpenClientWorkout(id);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const { data: ex } = await supa
    .from('exercises')
    .select('id, day_id, name')
    .eq('id', parsed.data.exerciseId)
    .maybeSingle();
  if (!ex || ex.day_id !== ctx.workout.dayId) {
    return NextResponse.json({ error: 'Exercise not in this workout' }, { status: 400 });
  }

  const { error } = await supa
    .from('exercise_logs')
    .upsert(
      {
        workout_id: ctx.workout.id,
        exercise_id: parsed.data.exerciseId,
        status: parsed.data.proceed ? 'completed' : 'pain',
        pain_reason: parsed.data.reason,
      },
      { onConflict: 'workout_id,exercise_id' }
    );
  if (error) {
    return NextResponse.json({ error: 'Failed to log pain' }, { status: 500 });
  }

  await insertAlert({
    clientId: ctx.user.id,
    type: 'pain',
    message: `${ctx.user.name} reported pain on ${ex.name}.`,
    data: {
      workout_id: ctx.workout.id,
      exercise_id: parsed.data.exerciseId,
      exercise_name: ex.name,
      reason: parsed.data.reason,
    },
  });

  return NextResponse.json({ ok: true });
}
