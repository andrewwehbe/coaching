import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

const Body = z
  .object({ ids: z.array(z.string().uuid()).optional() })
  .optional();

export async function POST(req: Request) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const ids = parsed.success ? parsed.data?.ids : undefined;

  const supa = db();
  const now = new Date().toISOString();
  const builder = supa.from('alerts').update({ acknowledged_at: now }).is('acknowledged_at', null);
  const finalQuery = ids && ids.length > 0 ? builder.in('id', ids) : builder;
  const { data, error } = await finalQuery.select('id');

  if (error) return NextResponse.json({ error: 'Failed to ack' }, { status: 500 });

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'ack_alerts_bulk',
    targetType: 'alert',
    details: { count: data?.length ?? 0, scope: ids ? 'selected' : 'all' },
  });

  return NextResponse.json({ count: data?.length ?? 0 });
}
