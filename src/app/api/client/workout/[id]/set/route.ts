import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/lib/supabase';
import { loadOpenClientWorkout } from '@/lib/workout-guard';
import { upsertBestEffortFromSet } from '@/lib/best-effort';
import { log as logger } from '@/lib/log';

const Body = z.object({
  exerciseId: z.string().uuid(),
  setNumber: z.number().int().min(1).max(20),
  weight: z.number().nullable().optional(),
  unit: z.enum(['kg', 'lb']).nullable().optional(),
  reps: z.number().int().min(1).max(200).nullable().optional(),
  rir: z.number().int().min(0).max(10).nullable().optional(),
  cardioMinutes: z.number().int().min(1).max(180).nullable().optional(),
  // Bucket-relative storage path returned by /api/client/upload-url.
  // Stored as-is in sets.video_url (legacy column name) and signed at read time.
  videoPath: z.string().min(1).max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

type Params = Promise<{ id: string }>;

export async function POST(req: Request, props: { params: Params }) {
  const { id } = await props.params;
  const ctx = await loadOpenClientWorkout(id);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    logger.warn('set.invalid_payload', {
      workoutId: id,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json({ error: 'Invalid set payload' }, { status: 400 });
  }

  const supa = db();

  // Verify the exercise belongs to this workout's day.
  const { data: ex } = await supa
    .from('exercises')
    .select('id, day_id, name_key, is_cardio')
    .eq('id', parsed.data.exerciseId)
    .maybeSingle();
  if (!ex || ex.day_id !== ctx.workout.dayId) {
    return NextResponse.json({ error: 'Exercise not in this workout' }, { status: 400 });
  }

  // Upsert exercise_log (one per workout+exercise).
  const { data: log, error: logErr } = await supa
    .from('exercise_logs')
    .upsert(
      {
        workout_id: ctx.workout.id,
        exercise_id: parsed.data.exerciseId,
        status: 'completed',
      },
      { onConflict: 'workout_id,exercise_id' }
    )
    .select('id, status')
    .single();
  if (logErr || !log) {
    return NextResponse.json({ error: 'Failed to log set' }, { status: 500 });
  }

  // Insert set (or update if same set_number resubmitted — supports edit).
  const { data: setRow, error: setErr } = await supa
    .from('sets')
    .upsert(
      {
        exercise_log_id: log.id,
        set_number: parsed.data.setNumber,
        weight: parsed.data.weight ?? null,
        unit: parsed.data.unit ?? null,
        reps: parsed.data.reps ?? null,
        rir: parsed.data.rir ?? null,
        cardio_minutes: parsed.data.cardioMinutes ?? null,
        video_url: parsed.data.videoPath ?? null,
        notes: parsed.data.notes ?? null,
      },
      { onConflict: 'exercise_log_id,set_number' }
    )
    .select('id, weight, unit, reps')
    .single();

  if (setErr || !setRow) {
    return NextResponse.json({ error: 'Failed to save set' }, { status: 500 });
  }

  // Update best_efforts only for non-cardio sets.
  let prMessage: string | null = null;
  if (!ex.is_cardio) {
    const result = await upsertBestEffortFromSet(
      ctx.user.id,
      ex.name_key,
      setRow.weight,
      setRow.unit,
      setRow.reps,
      setRow.id
    );
    if (result.updated) prMessage = result.prMessage;
  }

  return NextResponse.json({
    ok: true,
    setId: setRow.id,
    logId: log.id,
    pr: prMessage ? { message: prMessage } : null,
  });
}
