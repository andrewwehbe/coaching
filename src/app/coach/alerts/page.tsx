import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import type { AlertType } from '@/lib/alert-types';
import { PageHeader, PaginationLink, Pill } from '../ui';
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
      // Supabase returns `type` as string; the DB CHECK constraint
      // guarantees it's one of the AlertType literals. Cast at the
      // boundary; the runtime fallback in alerts-list.tsx covers any
      // value the bundle doesn't recognize (e.g. mid-rollback).
      type: a.type as AlertType,
      message: a.message,
      created_at: a.created_at,
      acknowledged_at: a.acknowledged_at,
      clients: c ? { name: (c as { name: string }).name } : null,
    };
  });

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <PageHeader eyebrow="The wire" title="Alerts" />

      <div className="flex items-center gap-2 mb-5">
        <Pill href="/coach/alerts" active={!onlyUnack}>
          All
        </Pill>
        <Pill href="/coach/alerts?unack=1" active={onlyUnack}>
          Unacknowledged
        </Pill>
      </div>

      <AlertsList alerts={normalized} />

      <nav className="mt-7 flex items-center justify-between">
        {offset > 0 ? (
          <PaginationLink href={buildUrl(Math.max(0, offset - PAGE_SIZE), onlyUnack)}>
            ← Newer
          </PaginationLink>
        ) : (
          <span />
        )}
        {alerts && alerts.length === PAGE_SIZE ? (
          <PaginationLink href={buildUrl(offset + PAGE_SIZE, onlyUnack)}>
            Older →
          </PaginationLink>
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
  type: AlertType;
  message: string;
  created_at: string;
  acknowledged_at: string | null;
  clients: { name: string } | null;
};
