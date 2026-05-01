import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

type Params = Promise<{ id: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const supa = db();
  const { data: alert, error } = await supa
    .from('alerts')
    .update({ acknowledged_at: new Date().toISOString() })
    .eq('id', id)
    .is('acknowledged_at', null)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Failed to ack' }, { status: 500 });
  if (!alert) return NextResponse.json({ ok: true, alreadyAcked: true });

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'ack_alert',
    targetType: 'alert',
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
