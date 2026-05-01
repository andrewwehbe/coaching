import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { AlertsList } from './alerts-list';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type SearchParams = Promise<{ offset?: string; unack?: string }>;

export default async function AlertsPage(props: { searchParams: SearchParams }) {
  await requireCoach();
  const sp = await props.searchParams;
  const offset = Math.max(Number(sp.offset ?? '0'), 0);
  const onlyUnack = sp.unack === '1';

  const supa = db();
  let query = supa
    .from('alerts')
    .select('id, client_id, type, message, data, created_at, acknowledged_at, clients(name)')
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (onlyUnack) query = query.is('acknowledged_at', null);

  const { data: alerts } = await query;

  const normalized: AlertRow[] = (alerts ?? []).map((a) => {
    const raw = a.clients as unknown;
    const c = Array.isArray(raw) ? raw[0] : raw;
    return {
      id: a.id,
      client_id: a.client_id,
      type: a.type,
      message: a.message,
      created_at: a.created_at,
      acknowledged_at: a.acknowledged_at,
      clients: c ? { name: (c as { name: string }).name } : null,
    };
  });

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <header className="mb-4">
        <Link href="/coach" className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Alerts</h1>
      </header>

      <div className="flex items-center gap-3 mb-4 text-sm">
        <Link
          href="/coach/alerts"
          className={`px-3 py-1.5 rounded-lg border ${
            !onlyUnack
              ? 'border-neutral-500 bg-neutral-800/60 text-neutral-100'
              : 'border-neutral-800 text-neutral-400 hover:text-neutral-200'
          }`}
        >
          All
        </Link>
        <Link
          href="/coach/alerts?unack=1"
          className={`px-3 py-1.5 rounded-lg border ${
            onlyUnack
              ? 'border-neutral-500 bg-neutral-800/60 text-neutral-100'
              : 'border-neutral-800 text-neutral-400 hover:text-neutral-200'
          }`}
        >
          Unacknowledged
        </Link>
      </div>

      <AlertsList alerts={normalized} />

      <nav className="mt-6 flex items-center justify-between text-sm">
        {offset > 0 ? (
          <Link
            href={buildUrl(Math.max(0, offset - PAGE_SIZE), onlyUnack)}
            className="text-neutral-300 hover:text-neutral-100"
          >
            ← Newer
          </Link>
        ) : (
          <span />
        )}
        {alerts && alerts.length === PAGE_SIZE ? (
          <Link
            href={buildUrl(offset + PAGE_SIZE, onlyUnack)}
            className="text-neutral-300 hover:text-neutral-100"
          >
            Older →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </main>
  );
}

function buildUrl(offset: number, unack: boolean) {
  const params = new URLSearchParams();
  if (offset > 0) params.set('offset', String(offset));
  if (unack) params.set('unack', '1');
  const qs = params.toString();
  return `/coach/alerts${qs ? `?${qs}` : ''}`;
}

type AlertRow = {
  id: string;
  client_id: string;
  type:
    | 'pain'
    | 'stalled'
    | 'missed_workout'
    | 'workout_started'
    | 'workout_completed'
    | 'check_in_due'
    | 'check_in_submitted';
  message: string;
  created_at: string;
  acknowledged_at: string | null;
  clients: { name: string } | null;
};
