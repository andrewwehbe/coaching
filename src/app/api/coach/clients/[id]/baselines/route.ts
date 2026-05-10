import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { log } from '@/lib/log';

type Params = Promise<{ id: string }>;

const Body = z.object({
  // Optional: when the client actually started this mesocycle. Used by the
  // plateau / suggestion engine to know they're not on week 1 of the
  // program even though uploaded_at is recent.
  training_start_at: z.string().datetime().nullable().optional(),
  // Per-name_key starting bests. Each row writes a best_efforts entry
  // with source_set_id = null so the cue picks it up immediately. Sets
  // logged afterwards beat or fail to beat the imported number.
  bests: z
    .array(
      z.object({
        name_key: z.string().min(1).max(200),
        weight: z.number().min(0).max(2000),
        unit: z.enum(['kg', 'lb']),
        reps: z.number().int().min(1).max(200),
      }),
    )
    .max(200),
});

export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id: clientId } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    log.warn('baselines.invalid_payload', {
      coachId: guard.user.id,
      clientId,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();

  // Verify client exists.
  const { data: client } = await supa
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  // Optional training_start_at on the active program.
  if (parsed.data.training_start_at !== undefined) {
    const { error: pErr } = await supa
      .from('programs')
      .update({ training_start_at: parsed.data.training_start_at })
      .eq('client_id', clientId)
      .eq('active', true);
    if (pErr) {
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }
  }

  // Upsert one best_efforts row per name_key. source_set_id stays null —
  // there's no in-app set to point at, but the row still feeds the cue.
  const rows = parsed.data.bests.map((b) => ({
    client_id: clientId,
    exercise_name_key: b.name_key,
    best_weight: b.weight,
    best_unit: b.unit,
    best_reps: b.reps,
    source_set_id: null,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length > 0) {
    const { error: bErr } = await supa
      .from('best_efforts')
      .upsert(rows, { onConflict: 'client_id,exercise_name_key' });
    if (bErr) {
      return NextResponse.json({ error: bErr.message }, { status: 500 });
    }
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'baselines.import',
    targetType: 'client',
    targetId: clientId,
    details: {
      best_count: rows.length,
      training_start_at: parsed.data.training_start_at ?? null,
    },
  });

  return NextResponse.json({ ok: true, written: rows.length });
}
