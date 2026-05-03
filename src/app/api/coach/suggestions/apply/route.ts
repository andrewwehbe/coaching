import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { sendPushToClient } from '@/lib/push';

export const dynamic = 'force-dynamic';

type Body =
  | { kind: 'add_set'; clientId: string; exerciseIds: string[] }
  | { kind: 'archive_day'; clientId: string; dayId: string }
  | { kind: 'swap_exercise'; clientId: string; exerciseIds: string[]; replacementName: string };

export async function POST(req: Request) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!body || !('kind' in body) || !body.clientId) {
    return NextResponse.json({ error: 'Missing kind or clientId' }, { status: 400 });
  }

  const supa = db();

  if (body.kind === 'add_set') {
    const ids = (body.exerciseIds ?? []).filter((s) => typeof s === 'string');
    if (ids.length === 0) {
      return NextResponse.json({ error: 'exerciseIds required' }, { status: 400 });
    }

    // Fetch current values, increment each by 1.
    const { data: rows, error: re } = await supa
      .from('exercises')
      .select('id, name, prescribed_sets')
      .in('id', ids);
    if (re) return NextResponse.json({ error: re.message }, { status: 500 });

    const updates = (rows ?? []).map((r) => {
      const next = (r.prescribed_sets ?? 2) + 1;
      return supa.from('exercises').update({ prescribed_sets: next }).eq('id', r.id);
    });
    const results = await Promise.all(updates);
    for (const r of results) {
      if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    }

    void sendPushToClient(body.clientId, {
      title: 'Program updated',
      body: `Coach added a set to ${rows?.[0]?.name ?? 'an exercise'}.`,
      url: '/today',
    }).catch(() => {});

    return NextResponse.json({ ok: true, updated: rows?.length ?? 0 });
  }

  if (body.kind === 'archive_day') {
    if (!body.dayId) {
      return NextResponse.json({ error: 'dayId required' }, { status: 400 });
    }
    // Soft-delete: set archived_at on every exercise in that day. The day
    // row itself stays so historical workouts still link.
    const { error: ee } = await supa
      .from('exercises')
      .update({ archived_at: new Date().toISOString() })
      .eq('day_id', body.dayId)
      .is('archived_at', null);
    if (ee) return NextResponse.json({ error: ee.message }, { status: 500 });

    void sendPushToClient(body.clientId, {
      title: 'Program updated',
      body: 'Coach removed an inactive day from your split.',
      url: '/today',
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  }

  if (body.kind === 'swap_exercise') {
    const ids = (body.exerciseIds ?? []).filter((s) => typeof s === 'string');
    if (ids.length === 0 || !body.replacementName) {
      return NextResponse.json(
        { error: 'exerciseIds and replacementName required' },
        { status: 400 },
      );
    }

    // Pull the rows we're replacing so we can keep position + prescription
    // continuity for the new exercise on each day.
    const { data: rows, error: re } = await supa
      .from('exercises')
      .select('id, day_id, position, prescription_raw, prescribed_sets, rep_min, rep_max, rir_target')
      .in('id', ids)
      .is('archived_at', null);
    if (re) return NextResponse.json({ error: re.message }, { status: 500 });
    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'No active exercises matched' }, { status: 404 });
    }

    // Day-scoped name_key so the same name on different days tracks bests
    // independently. Need each row's day_index, which lives on days.
    const dayIds = Array.from(new Set(rows.map((r) => r.day_id)));
    const { data: days, error: de } = await supa
      .from('days')
      .select('id, day_index')
      .in('id', dayIds);
    if (de) return NextResponse.json({ error: de.message }, { status: 500 });
    const dayIdxById = new Map<string, number>();
    for (const d of days ?? []) dayIdxById.set(d.id, d.day_index);

    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const newRows = rows.map((r) => {
      const idx = dayIdxById.get(r.day_id) ?? 1;
      return {
        day_id: r.day_id,
        position: r.position,
        name: body.replacementName,
        name_key: `d${idx}::${normalize(body.replacementName)}`,
        prescription_raw: r.prescription_raw,
        prescribed_sets: r.prescribed_sets,
        rep_min: r.rep_min,
        rep_max: r.rep_max,
        rir_target: r.rir_target,
        is_cardio: false,
        cardio_type: null,
      };
    });

    // Archive the originals; insert replacements. Old logs stay attached
    // to the archived rows so history is preserved.
    const { error: arErr } = await supa
      .from('exercises')
      .update({ archived_at: new Date().toISOString() })
      .in('id', ids);
    if (arErr) return NextResponse.json({ error: arErr.message }, { status: 500 });

    const { error: insErr } = await supa.from('exercises').insert(newRows);
    if (insErr) {
      // best-effort revert if insert fails
      await supa.from('exercises').update({ archived_at: null }).in('id', ids);
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    void sendPushToClient(body.clientId, {
      title: 'Program updated',
      body: `Coach swapped in ${body.replacementName}.`,
      url: '/today',
    }).catch(() => {});

    return NextResponse.json({ ok: true, replaced: rows.length });
  }

  return NextResponse.json({ error: 'Unknown kind' }, { status: 400 });
}
