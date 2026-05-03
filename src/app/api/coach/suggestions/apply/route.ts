import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { sendPushToClient } from '@/lib/push';

export const dynamic = 'force-dynamic';

type Body =
  | { kind: 'add_set'; clientId: string; exerciseIds: string[] }
  | { kind: 'archive_day'; clientId: string; dayId: string };

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

  return NextResponse.json({ error: 'Unknown kind' }, { status: 400 });
}
