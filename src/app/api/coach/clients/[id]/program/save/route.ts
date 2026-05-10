import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { parsePrescription } from '@/lib/sheet-parser';
import { nameKeyFor, normalize } from '@/lib/exercise-name';
import { sendPushToClient } from '@/lib/push';
import { log } from '@/lib/log';

type Params = Promise<{ id: string }>;

const Body = z.object({
  days: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        label: z.string().trim().min(1).max(120),
        exercises: z.array(
          z.object({
            id: z.string().uuid().optional(),
            name: z.string().trim().min(1).max(200),
            prescription_raw: z.string().trim().min(1).max(120),
            coach_note: z.string().trim().max(2000).nullable().optional(),
          })
        ),
      })
    )
    .min(1),
});

export async function POST(req: Request, ctx: { params: Params }) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id: clientId } = await ctx.params;
  const supa = db();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    log.warn('program.save.invalid_body', {
      coachId: user.id,
      clientId,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json({ error: 'Invalid program payload' }, { status: 400 });
  }
  const payload = parsed.data;

  // Validate every prescription up front so we don't half-write a broken program.
  for (const [di, day] of payload.days.entries()) {
    for (const [ei, ex] of day.exercises.entries()) {
      if (!parsePrescription(ex.prescription_raw)) {
        return NextResponse.json(
          {
            error: `Day ${di + 1} "${day.label}", exercise ${ei + 1} "${ex.name}": prescription "${ex.prescription_raw}" is invalid. Use a format like "3x5-8" or "2x20 min".`,
          },
          { status: 400 }
        );
      }
    }
  }

  const { data: program } = await supa
    .from('programs')
    .select('id')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!program) {
    return NextResponse.json({ error: 'No active program for this client' }, { status: 404 });
  }

  const { data: existingDays } = await supa
    .from('days')
    .select('id, day_index, label, exercises(id, position, name, name_key, prescription_raw, coach_note, archived_at)')
    .eq('program_id', program.id)
    .order('day_index');

  const existingDayById = new Map<string, NonNullable<typeof existingDays>[number]>();
  for (const d of existingDays ?? []) existingDayById.set(d.id, d);

  const incomingDayIds = new Set<string>();
  const incomingExerciseIds = new Set<string>();

  // Mirrors payload.days shape and is returned to the client so it can merge
  // newly-issued ids back into editor state. Without this, re-saving after a
  // successful insert tries to insert the same row again and hits the
  // (day_id, position) unique constraint with a 409.
  const savedDays: Array<{ id: string; exercises: Array<{ id: string }> }> = [];

  // When the same exercise appears on multiple days, reuse the first day's
  // name_key on every later occurrence so bests collate across days. Without
  // this an A/B split tracks each day's "Hack squat" independently and the
  // client sees "Log first set" on Day 4 even after logging Day 2.
  const nameToFirstKey = new Map<string, string>();

  for (const [di, day] of payload.days.entries()) {
    const dayIndex = di + 1;
    let dayId = day.id;

    if (dayId && existingDayById.has(dayId)) {
      incomingDayIds.add(dayId);
      const existing = existingDayById.get(dayId)!;
      if (existing.label !== day.label || existing.day_index !== dayIndex) {
        const { error } = await supa
          .from('days')
          .update({ label: day.label, day_index: dayIndex })
          .eq('id', dayId);
        if (error) {
          log.error('program.save.day_update', error, { dayId, clientId });
          return NextResponse.json({ error: 'Failed to update day' }, { status: 500 });
        }
      }
    } else {
      const { data: row, error } = await supa
        .from('days')
        .insert({ program_id: program.id, day_index: dayIndex, label: day.label })
        .select('id')
        .single();
      if (error || !row) {
        log.error('program.save.day_insert', error, { clientId, dayIndex });
        return NextResponse.json({ error: 'Failed to create day' }, { status: 500 });
      }
      dayId = row.id;
    }

    const existingExByName = new Map<string, { id: string; name: string; name_key: string }>();
    for (const ex of existingDayById.get(dayId!)?.exercises ?? []) {
      if (ex.archived_at) continue;
      existingExByName.set(ex.id, { id: ex.id, name: ex.name, name_key: ex.name_key });
    }

    const savedExercises: Array<{ id: string }> = [];

    for (const [ei, ex] of day.exercises.entries()) {
      const position = ei + 1;
      const rx = parsePrescription(ex.prescription_raw)!;
      const dedupeKey = normalize(ex.name);
      let newNameKey = nameToFirstKey.get(dedupeKey);
      if (!newNameKey) {
        newNameKey = nameKeyFor(dayIndex, ex.name);
        nameToFirstKey.set(dedupeKey, newNameKey);
      }

      if (ex.id && existingExByName.has(ex.id)) {
        incomingExerciseIds.add(ex.id);
        // Regenerate name_key whenever the name changes; that's how a "swap"
        // resets the cue to "Log first set" without touching best_efforts.
        const { error } = await supa
          .from('exercises')
          .update({
            position,
            name: ex.name,
            name_key: newNameKey,
            prescription_raw: ex.prescription_raw,
            prescribed_sets: rx.sets,
            rep_min: rx.rep_min,
            rep_max: rx.rep_max,
            rir_target: rx.rir,
            is_cardio: rx.is_cardio,
            coach_note: ex.coach_note?.trim() || null,
            archived_at: null,
          })
          .eq('id', ex.id);
        if (error) {
          log.error('program.save.ex_update', error, { exerciseId: ex.id, clientId });
          return NextResponse.json({ error: 'Failed to update exercise' }, { status: 500 });
        }
        savedExercises.push({ id: ex.id });
      } else {
        const { data: row, error } = await supa
          .from('exercises')
          .insert({
            day_id: dayId!,
            position,
            name: ex.name,
            name_key: newNameKey,
            prescription_raw: ex.prescription_raw,
            prescribed_sets: rx.sets,
            rep_min: rx.rep_min,
            rep_max: rx.rep_max,
            rir_target: rx.rir,
            is_cardio: rx.is_cardio,
            coach_note: ex.coach_note?.trim() || null,
          })
          .select('id')
          .single();
        if (error || !row) {
          log.error('program.save.ex_insert', error, { clientId, dayId });
          return NextResponse.json({ error: 'Failed to create exercise' }, { status: 500 });
        }
        incomingExerciseIds.add(row.id);
        savedExercises.push({ id: row.id });
      }
    }

    savedDays.push({ id: dayId!, exercises: savedExercises });
  }

  // Archive (soft-delete) exercises that were removed. Keep the row so old
  // exercise_logs stay queryable; they just stop showing up in the program.
  for (const day of existingDays ?? []) {
    for (const ex of day.exercises ?? []) {
      if (ex.archived_at) continue;
      if (!incomingExerciseIds.has(ex.id)) {
        await supa
          .from('exercises')
          .update({ archived_at: new Date().toISOString() })
          .eq('id', ex.id);
      }
    }
  }

  // Days are not deleted in this editor — workouts reference them by FK,
  // so removing one would orphan history. Days only ever get added or renamed.
  // (To "delete" a day, the coach can re-upload the program from scratch.)

  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: user.id,
    action: 'program.edit',
    target_type: 'program',
    target_id: program.id,
    details: {
      client_id: clientId,
      day_count: savedDays.length,
      exercise_count: savedDays.reduce((n, d) => n + d.exercises.length, 0),
    },
  });

  void sendPushToClient(clientId, {
    title: 'Program updated',
    body: 'Your coach made changes to your program.',
    url: '/today',
  }).catch(() => {});

  return NextResponse.json({ ok: true, days: savedDays });
}
