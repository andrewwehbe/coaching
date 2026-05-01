import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { listClientSummaries } from '@/lib/clients';
import { db } from '@/lib/supabase';

export async function GET() {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  const supa = db();
  const [{ data: alerts }, clients] = await Promise.all([
    supa
      .from('alerts')
      .select('id, client_id, type, message, data, created_at, acknowledged_at')
      .is('acknowledged_at', null)
      .order('created_at', { ascending: false })
      .limit(100),
    listClientSummaries(),
  ]);

  // Pain first, then most recent.
  const sortedAlerts = (alerts ?? []).slice().sort((a, b) => {
    if (a.type === 'pain' && b.type !== 'pain') return -1;
    if (b.type === 'pain' && a.type !== 'pain') return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return NextResponse.json({ alerts: sortedAlerts, clients });
}
