import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

/**
 * Manually pin a logged set as the client's best effort for its movement.
 *
 * The automatic best_efforts machinery only ever moves UP (a set has to beat
 * the stored PR), so a stale peak or a mis-entered weight can get stuck as the
 * cue target with no way to correct it. This lets the client browse their full
 * history and say "THIS set is my real best" — an unconditional overwrite of
 * best_efforts for that name_key.
 *
 * Security: the set must belong to one of the caller's own workouts. We resolve
 * set → exercise_log → workout (ownership) and → exercise (name_key) server-side
 * and never trust a name_key from the client.
 */
const Body = z.object({
  setId: z.string().uuid(),
});

export async function POST(req: Request) {
  const user = await readSession();
  if (!user || user.type !== 'client') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!user.active) {
    return NextResponse.json({ error: 'Inactive' }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();

  // set -> exercise_log
  const { data: set } = await supa
    .from('sets')
    .select('id, weight, unit, reps, exercise_log_id')
    .eq('id', parsed.data.setId)
    .maybeSingle();
  if (!set) {
    return NextResponse.json({ error: 'Set not found' }, { status: 404 });
  }
  if (set.weight == null || set.reps == null) {
    // Cardio / weightless sets can't be a best effort.
    return NextResponse.json({ error: 'Set has no weight to pin' }, { status: 400 });
  }

  // exercise_log -> workout (ownership) + exercise (name_key)
  const { data: log } = await supa
    .from('exercise_logs')
    .select('id, workout_id, exercise_id')
    .eq('id', set.exercise_log_id)
    .maybeSingle();
  if (!log) {
    return NextResponse.json({ error: 'Set not found' }, { status: 404 });
  }

  const [{ data: workout }, { data: exercise }] = await Promise.all([
    supa.from('workouts').select('id, client_id').eq('id', log.workout_id).maybeSingle(),
    supa.from('exercises').select('id, name_key').eq('id', log.exercise_id).maybeSingle(),
  ]);

  // The set must be the caller's own, and the exercise must resolve to a key.
  if (!workout || workout.client_id !== user.id || !exercise?.name_key) {
    return NextResponse.json({ error: 'Not your set' }, { status: 403 });
  }

  const { error: writeErr } = await supa.from('best_efforts').upsert(
    {
      client_id: user.id,
      exercise_name_key: exercise.name_key,
      best_weight: set.weight,
      best_unit: set.unit,
      best_reps: set.reps,
      source_set_id: set.id,
      // Explicit override: wins over the computed current-block best.
      pinned: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'client_id,exercise_name_key' },
  );
  if (writeErr) {
    return NextResponse.json({ error: 'Failed to set best' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    best: { weight: set.weight, unit: set.unit, reps: set.reps, sourceSetId: set.id },
  });
}
