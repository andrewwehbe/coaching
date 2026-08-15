import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { parseSheet } from '@/lib/sheet-parser';
import { sendPushToClient } from '@/lib/push';
import { recordProgramRevision } from '@/lib/program-revision';
import { log } from '@/lib/log';

type Params = Promise<{ id: string }>;

export async function POST(req: Request, ctx: { params: Params }) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: clientId } = await ctx.params;
  const supa = db();

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const result = parseSheet(buf);
  if (!result.ok) {
    return NextResponse.json(
      { error: 'Sheet failed to parse', details: result.errors },
      { status: 400 }
    );
  }

  // Deactivate-old + insert program/days/exercises runs inside the
  // commit_program Postgres function (0039) as ONE transaction. The old
  // sequential version deactivated the previous program before inserting
  // the new one, so a mid-sequence failure left the client with no active
  // program at all — the enabler of the historical duplicate-days mess.
  const programId = randomUUID();
  const daysPayload = result.program.days.map((day) => ({
    label: day.label,
    exercises: day.exercises.map((ex) => ({
      name: ex.name,
      name_key: ex.name_key,
      prescription_raw: ex.prescription_raw,
      prescribed_sets: ex.prescribed_sets,
      rep_min: ex.rep_min,
      rep_max: ex.rep_max,
      rir_target: ex.rir_target,
      is_cardio: ex.is_cardio,
      cardio_type: ex.cardio_type,
    })),
  }));

  const { data, error } = await supa.rpc('commit_program', {
    p_client_id: clientId,
    p_program_id: programId,
    p_source_filename: file.name,
    p_days: daysPayload,
  });
  if (error) {
    log.error('program.commit.rpc_failed', error, { clientId });
    return NextResponse.json({ error: 'Failed to save program' }, { status: 500 });
  }
  const rpcResult = data as { ok?: true; error?: string } | null;
  if (rpcResult?.error === 'client_not_found') {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }
  if (!rpcResult?.ok) {
    log.error('program.commit.rpc_result', rpcResult?.error ?? 'unknown', { clientId });
    return NextResponse.json({ error: 'Failed to save program' }, { status: 500 });
  }

  // Snapshot the freshly-uploaded program as revision 1. Best-effort —
  // a snapshot failure is logged but does not fail the upload.
  await recordProgramRevision({
    programId,
    editedBy: user.id,
    reason: 'sheet_upload',
  });

  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: user.id,
    action: 'program.upload',
    target_type: 'program',
    target_id: programId,
    details: {
      client_id: clientId,
      filename: file.name,
      day_count: result.program.days.length,
      exercise_count: result.program.days.reduce(
        (n, d) => n + d.exercises.length,
        0
      ),
    },
  });

  void sendPushToClient(clientId, {
    title: 'New program ready',
    body: 'Your coach uploaded a fresh program — open the app to see it.',
    url: '/today',
  }).catch(() => {});

  return NextResponse.json({ ok: true, program_id: programId });
}
