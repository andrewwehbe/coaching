import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { parsePrescription } from '@/lib/sheet-parser';
import { nameKeyFor } from '@/lib/exercise-name';

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
    console.error('program/save: invalid body', parsed.error.flatten());
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
          console.error('day update', error);
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
        console.error('day insert', error);
        return NextResponse.json({ error: 'Failed to create day' }, { status: 500 });
      }
      dayId = row.id;
    }

    const existingExByName = new Map<string, { id: string; name: string; name_key: string }>();
    for (const ex of existingDayById.get(dayId!)?.exercises ?? []) {
      if (ex.archived_at) continue;
      existingExByName.set(ex.id, { id: ex.id, name: ex.name, name_key: ex.name_key });
    }

    for (const [ei, ex] of day.exercises.entries()) {
      const position = ei + 1;
      const rx = parsePrescription(ex.prescription_raw)!;
      const newNameKey = nameKeyFor(dayIndex, ex.name);

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
          console.error('ex update', error);
          return NextResponse.json({ error: 'Failed to update exercise' }, { status: 500 });
        }
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
          console.error('ex insert', error);
          return NextResponse.json({ error: 'Failed to create exercise' }, { status: 500 });
        }
        incomingExerciseIds.add(row.id);
      }
    }
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

  return NextResponse.json({ ok: true });
}
