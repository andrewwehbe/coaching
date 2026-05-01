import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';

export async function GET(req: Request) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'), 0);
  const onlyUnack = url.searchParams.get('unack') === '1';

  const supa = db();
  let query = supa
    .from('alerts')
    .select('id, client_id, type, message, data, created_at, acknowledged_at, clients(name)')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (onlyUnack) query = query.is('acknowledged_at', null);

  const { data: alerts, error } = await query;
  if (error) return NextResponse.json({ error: 'Failed to load alerts' }, { status: 500 });

  return NextResponse.json({ alerts: alerts ?? [], limit, offset });
}
