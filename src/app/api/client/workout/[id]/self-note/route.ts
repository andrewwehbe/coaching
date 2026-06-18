import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/lib/supabase';
import { loadClientWorkout } from '@/lib/workout-guard';

const Body = z.object({
  exerciseId: z.string().uuid(),
  // null / empty clears the note.
  note: z.string().max(2000).nullable(),
});

type Params = Promise<{ id: string }>;

export async function POST(req: Request, props: { params: Params }) {
  const { id } = await props.params;
  // A note to self is harmless to record regardless of completion state, so we
  // only require that the workout belongs to this client (not that it's open).
  const ctx = await loadClientWorkout(id);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();

  // Resolve the exercise to its movement key and confirm it belongs to this
  // workout's day before letting the client attach a note to it.
  const { data: ex } = await supa
    .from('exercises')
    .select('id, day_id, name_key')
    .eq('id', parsed.data.exerciseId)
    .maybeSingle();
  if (!ex || ex.day_id !== ctx.workout.dayId) {
    return NextResponse.json({ error: 'Exercise not in this workout' }, { status: 400 });
  }

  const trimmed = parsed.data.note?.trim() || null;

  if (trimmed === null) {
    // Clearing the note removes the row entirely.
    const { error } = await supa
      .from('exercise_self_notes')
      .delete()
      .eq('client_id', ctx.user.id)
      .eq('exercise_name_key', ex.name_key);
    if (error) {
      return NextResponse.json({ error: 'Failed to clear note' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, note: null });
  }

  const { error } = await supa.from('exercise_self_notes').upsert(
    {
      client_id: ctx.user.id,
      exercise_name_key: ex.name_key,
      note: trimmed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'client_id,exercise_name_key' }
  );
  if (error) {
    return NextResponse.json({ error: 'Failed to save note' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, note: trimmed });
}
