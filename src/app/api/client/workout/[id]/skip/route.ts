import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/lib/supabase';
import { loadOpenClientWorkout } from '@/lib/workout-guard';

const Body = z.object({
  exerciseId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
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
    .select('id, day_id')
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
        status: 'skipped',
        skip_reason: parsed.data.reason,
      },
      { onConflict: 'workout_id,exercise_id' }
    );
  if (error) {
    return NextResponse.json({ error: 'Failed to skip' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
