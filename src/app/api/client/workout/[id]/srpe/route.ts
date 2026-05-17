import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/lib/supabase';
import { loadClientWorkout } from '@/lib/workout-guard';

type Params = Promise<{ id: string }>;

/**
 * Session RPE is rated AFTER the session, so this route deliberately uses
 * loadClientWorkout (not loadOpenClientWorkout) — the workout will already
 * be completed when the summary screen shows the prompt. We just verify
 * the workout belongs to the requesting client.
 *
 * `rpe: null` clears a previously-set rating, in case the client mis-taps
 * and wants to reset.
 */
const Body = z.object({
  rpe: z.number().int().min(1).max(10).nullable(),
});

export async function POST(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  const ctx = await loadClientWorkout(id);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const { error } = await supa
    .from('workouts')
    .update({ session_rpe: parsed.data.rpe })
    .eq('id', ctx.workout.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
