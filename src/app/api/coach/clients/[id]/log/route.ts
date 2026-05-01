import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startOfWeek, formatISO } from 'date-fns';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { upsertBestEffortFromSet } from '@/lib/best-effort';

type Params = Promise<{ id: string }>;

const SetInput = z.object({
  set_number: z.number().int().min(1).max(20),
  weight: z.number().nullish(),
  unit: z.enum(['kg', 'lb']).nullish(),
  reps: z.number().int().min(0).max(200).nullish(),
  rir: z.number().int().min(0).max(10).nullish(),
  cardio_minutes: z.number().int().min(0).max(600).nullish(),
  notes: z.string().max(500).nullish(),
});

const ExerciseEntry = z.object({
  exercise_id: z.string().uuid(),
  status: z.enum(['completed', 'skipped', 'pain']).default('completed'),
  skip_reason: z.string().max(500).nullish(),
  pain_reason: z.string().max(500).nullish(),
  client_note: z.string().max(500).nullish(),
  sets: z.array(SetInput).default([]),
});

const Body = z.object({
  day_id: z.string().uuid(),
  completed: z.boolean().default(true),
  exercises: z.array(ExerciseEntry).min(1),
});

export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id: clientId } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const supa = db();

  const { data: day } = await supa
    .from('days')
    .select('id, program_id, programs!inner(client_id)')
    .eq('id', parsed.data.day_id)
    .maybeSingle();
  // @ts-expect-error supabase nested join typing
  if (!day || day.programs?.client_id !== clientId) {
    return NextResponse.json({ error: 'Day not found for this client' }, { status: 404 });
  }

  const exerciseIds = parsed.data.exercises.map((e) => e.exercise_id);
  const { data: exerciseRows } = await supa
    .from('exercises')
    .select('id, day_id, name_key')
    .in('id', exerciseIds);

  const validIds = new Set(
    (exerciseRows ?? []).filter((e) => e.day_id === parsed.data.day_id).map((e) => e.id),
  );
  for (const e of parsed.data.exercises) {
    if (!validIds.has(e.exercise_id)) {
      return NextResponse.json(
        { error: `Exercise ${e.exercise_id} not on this day` },
        { status: 400 },
      );
    }
  }
  const nameKeyById = new Map(
    (exerciseRows ?? []).map((e) => [e.id as string, e.name_key as string]),
  );

  const now = new Date();
  const weekStart = formatISO(startOfWeek(now, { weekStartsOn: 1 }), {
    representation: 'date',
  });

  const { data: workout, error: wErr } = await supa
    .from('workouts')
    .insert({
      client_id: clientId,
      day_id: parsed.data.day_id,
      week_start: weekStart,
      started_at: now.toISOString(),
      completed_at: parsed.data.completed ? now.toISOString() : null,
    })
    .select('id')
    .single();

  if (wErr || !workout) {
    return NextResponse.json({ error: 'Failed to create workout' }, { status: 500 });
  }

  for (const entry of parsed.data.exercises) {
    const { data: log, error: lErr } = await supa
      .from('exercise_logs')
      .insert({
        workout_id: workout.id,
        exercise_id: entry.exercise_id,
        status: entry.status,
        skip_reason: entry.skip_reason ?? null,
        pain_reason: entry.pain_reason ?? null,
        client_note: entry.client_note ?? null,
      })
      .select('id')
      .single();
    if (lErr || !log) continue;

    if (entry.status !== 'completed' || entry.sets.length === 0) continue;

    const rows = entry.sets.map((s) => ({
      exercise_log_id: log.id,
      set_number: s.set_number,
      weight: s.weight ?? null,
      unit: s.unit ?? null,
      reps: s.reps ?? null,
      rir: s.rir ?? null,
      cardio_minutes: s.cardio_minutes ?? null,
      notes: s.notes ?? null,
    }));
    const { data: insertedSets } = await supa.from('sets').insert(rows).select('id, set_number');

    const nameKey = nameKeyById.get(entry.exercise_id);
    if (nameKey) {
      for (const s of entry.sets) {
        const inserted = insertedSets?.find((r) => r.set_number === s.set_number);
        if (!inserted) continue;
        await upsertBestEffortFromSet(
          clientId,
          nameKey,
          s.weight ?? null,
          s.unit ?? null,
          s.reps ?? null,
          inserted.id,
        );
      }
    }
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'log_on_behalf',
    targetType: 'workout',
    targetId: workout.id,
    details: {
      client_id: clientId,
      day_id: parsed.data.day_id,
      exercise_count: parsed.data.exercises.length,
    },
  });

  return NextResponse.json({ workoutId: workout.id });
}
