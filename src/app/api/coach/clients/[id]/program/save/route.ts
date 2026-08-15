import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { parsePrescription } from '@/lib/sheet-parser';
import { nameKeyFor, normalize } from '@/lib/exercise-name';
import { sendPushToClient } from '@/lib/push';
import { log } from '@/lib/log';
import { migrateBestEffortKey } from '@/lib/best-effort';
import { recordProgramRevision } from '@/lib/program-revision';

type Params = Promise<{ id: string }>;

const MUSCLE_GROUPS = [
  'chest',
  'back',
  'quads',
  'hamstrings',
  'glutes',
  'shoulders',
  'biceps',
  'triceps',
  'calves',
  'abs',
  'other',
] as const;

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
            muscle_group: z.enum(MUSCLE_GROUPS).nullable().optional(),
          })
        ),
      })
    )
    .min(1),
});

/**
 * Program edit. This route PLANS the change (validation, id issuance,
 * name_key collation, best-effort-migration list, archive list) and the
 * save_program_edit Postgres function (0039) EXECUTES it in one
 * transaction — the old version was a loop of single-row writes where a
 * mid-loop error half-wrote the program, and direct position updates
 * could trip the (day_id, position) partial unique index on reorders.
 */
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

  // Best-effort key migrations to run AFTER the transaction commits.
  // migrateBestEffortKey copies (never deletes), so it's safe post-commit
  // and a failure there can't corrupt the program itself.
  const keyMigrations: Array<{ oldKey: string; newKey: string }> = [];

  type DayOp = {
    id: string;
    is_new: boolean;
    day_index: number;
    label: string;
    exercises: Array<{
      id: string;
      is_new: boolean;
      position: number;
      name: string;
      name_key: string;
      prescription_raw: string;
      prescribed_sets: number | null;
      rep_min: number | null;
      rep_max: number | null;
      rir_target: string | null;
      is_cardio: boolean;
      coach_note: string | null;
      muscle_group: string | null;
    }>;
  };
  const daysPayload: DayOp[] = [];

  for (const [di, day] of payload.days.entries()) {
    const dayIndex = di + 1;
    const isNewDay = !(day.id && existingDayById.has(day.id));
    const dayId = isNewDay ? randomUUID() : day.id!;

    const existingExById = new Map<string, { id: string; name_key: string }>();
    for (const ex of existingDayById.get(dayId)?.exercises ?? []) {
      if (ex.archived_at) continue;
      existingExById.set(ex.id, { id: ex.id, name_key: ex.name_key });
    }

    const exOps: DayOp['exercises'] = [];
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

      const isNewEx = !(ex.id && existingExById.has(ex.id));
      const exId = isNewEx ? randomUUID() : ex.id!;
      if (!isNewEx) {
        incomingExerciseIds.add(exId);
        // Regenerate name_key whenever the name changes; that's how a "swap"
        // resets the cue to "Log first set". The post-commit migrate copies
        // (without deleting) the existing best_efforts row to the new key so
        // a rename doesn't visually erase the client's PR.
        const oldNameKey = existingExById.get(exId)!.name_key;
        if (oldNameKey !== newNameKey) {
          keyMigrations.push({ oldKey: oldNameKey, newKey: newNameKey });
        }
      }

      exOps.push({
        id: exId,
        is_new: isNewEx,
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
        muscle_group: ex.muscle_group ?? null,
      });
      savedExercises.push({ id: exId });
    }

    daysPayload.push({
      id: dayId,
      is_new: isNewDay,
      day_index: dayIndex,
      label: day.label,
      exercises: exOps,
    });
    savedDays.push({ id: dayId, exercises: savedExercises });
  }

  // Exercises that were removed get archived (soft-delete) inside the same
  // transaction. Rows stay so old exercise_logs remain queryable.
  const archiveIds: string[] = [];
  for (const day of existingDays ?? []) {
    for (const ex of day.exercises ?? []) {
      if (ex.archived_at) continue;
      if (!incomingExerciseIds.has(ex.id)) archiveIds.push(ex.id);
    }
  }

  // Days are not deleted in this editor — workouts reference them by FK,
  // so removing one would orphan history. Days only ever get added or renamed.
  // (To "delete" a day, the coach can re-upload the program from scratch.)

  const { data, error } = await supa.rpc('save_program_edit', {
    p_client_id: clientId,
    p_program_id: program.id,
    p_days: daysPayload,
    p_archive_ids: archiveIds,
  });
  if (error) {
    log.error('program.save.rpc_failed', error, { clientId, programId: program.id });
    return NextResponse.json({ error: 'Failed to save program' }, { status: 500 });
  }
  const rpcResult = data as { ok?: true; error?: string } | null;
  if (rpcResult?.error === 'program_not_found') {
    return NextResponse.json({ error: 'No active program for this client' }, { status: 404 });
  }
  if (!rpcResult?.ok) {
    log.error('program.save.rpc_result', rpcResult?.error ?? 'unknown', {
      clientId,
      programId: program.id,
    });
    return NextResponse.json({ error: 'Failed to save program' }, { status: 500 });
  }

  for (const m of keyMigrations) {
    await migrateBestEffortKey(clientId, m.oldKey, m.newKey);
  }

  // Snapshot the post-edit state for the revision history. Best-effort —
  // a snapshot failure is logged but does not fail the save (history is
  // additional context, not load-bearing).
  await recordProgramRevision({
    programId: program.id,
    editedBy: user.id,
    reason: 'edit',
  });

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
