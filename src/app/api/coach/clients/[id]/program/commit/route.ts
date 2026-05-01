import { NextResponse } from 'next/server';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { parseSheet } from '@/lib/sheet-parser';

type Params = Promise<{ id: string }>;

export async function POST(req: Request, ctx: { params: Params }) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: clientId } = await ctx.params;
  const supa = db();

  const { data: client } = await supa
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

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

  await supa
    .from('programs')
    .update({ active: false })
    .eq('client_id', clientId)
    .eq('active', true);

  const { data: program, error: progErr } = await supa
    .from('programs')
    .insert({
      client_id: clientId,
      source_filename: file.name,
      active: true,
    })
    .select('id')
    .single();
  if (progErr || !program) {
    return NextResponse.json(
      { error: progErr?.message ?? 'Failed to create program' },
      { status: 500 }
    );
  }

  for (const [i, day] of result.program.days.entries()) {
    const { data: dayRow, error: dayErr } = await supa
      .from('days')
      .insert({
        program_id: program.id,
        day_index: i + 1,
        label: day.label,
      })
      .select('id')
      .single();
    if (dayErr || !dayRow) {
      return NextResponse.json(
        { error: dayErr?.message ?? 'Failed to insert day' },
        { status: 500 }
      );
    }

    const exerciseRows = day.exercises.map((ex, j) => ({
      day_id: dayRow.id,
      position: j + 1,
      name: ex.name,
      name_key: ex.name_key,
      prescription_raw: ex.prescription_raw,
      prescribed_sets: ex.prescribed_sets,
      rep_min: ex.rep_min,
      rep_max: ex.rep_max,
      rir_target: ex.rir_target,
      is_cardio: ex.is_cardio,
      cardio_type: ex.cardio_type,
    }));
    if (exerciseRows.length > 0) {
      const { error: exErr } = await supa.from('exercises').insert(exerciseRows);
      if (exErr) {
        return NextResponse.json({ error: exErr.message }, { status: 500 });
      }
    }
  }

  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: user.id,
    action: 'program.upload',
    target_type: 'program',
    target_id: program.id,
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

  return NextResponse.json({ ok: true, program_id: program.id });
}
