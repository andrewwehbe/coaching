import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries, type ClientStatus } from '@/lib/clients';
import { Chip, PageHeader } from '../ui';

export const dynamic = 'force-dynamic';

export default async function ClientsPage() {
  await requireCoach();
  const clients = await listClientSummaries();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <PageHeader
        eyebrow="Roster"
        title="Clients"
        meta={
          clients.length > 0 ? (
            <span>
              {clients.filter((c) => c.active).length} active · {clients.length} total
            </span>
          ) : null
        }
        trailing={
          <Link
            href="/coach/clients/new"
            prefetch={false}
            className="inline-flex items-center gap-2 rounded-sm border border-primary bg-primary/10 hover:bg-primary/20 text-primary-hi px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium transition-colors"
          >
            New client
            <span aria-hidden className="font-display text-base leading-none">
              +
            </span>
          </Link>
        }
      />

      {clients.length === 0 ? (
        <div className="border-t border-border pt-10 text-center">
          <p className="font-display text-2xl text-muted mb-2">No one on the roster yet.</p>
          <Link
            href="/coach/clients/new"
            prefetch={false}
            className="text-[11px] uppercase tracking-[0.22em] text-primary-hi hover:text-primary transition-colors border-b border-primary/40 hover:border-primary pb-0.5"
          >
            Add the first
          </Link>
        </div>
      ) : (
        <ul className="border-t border-border">
          {clients.map((c) => (
            <li key={c.id} className="border-b border-border">
              <Link
                href={`/coach/clients/${c.id}`}
                prefetch={false}
                className="group flex items-center justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-display text-2xl sm:text-3xl tracking-tight leading-none truncate group-hover:text-primary-hi transition-colors">
                    {c.name}
                  </p>
                  <p className="mt-1.5 text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-faint">
                    <span className="tabular-nums text-muted">
                      {c.daysLoggedThisWeek}/{c.weeklyDayTarget}
                    </span>{' '}
                    this week
                    {c.lastActivityAt && (
                      <>
                        <span className="mx-2 text-border-strong">·</span>
                        last{' '}
                        {formatDistanceToNow(new Date(c.lastActivityAt), { addSuffix: true })}
                      </>
                    )}
                  </p>
                </div>
                <StatusChip status={c.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function StatusChip({ status }: { status: ClientStatus }) {
  const map: Record<ClientStatus, { label: string; className: string }> = {
    on_track: {
      label: 'On track',
      className: 'border-primary/30 bg-primary/10 text-primary-hi',
    },
    behind: {
      label: 'Behind',
      className: 'border-warn/35 bg-warn/10 text-warn',
    },
    inactive: {
      label: 'Inactive',
      className: 'border-border bg-surface-2 text-muted',
    },
    pain: {
      label: 'Pain',
      className: 'border-danger/40 bg-danger/10 text-danger',
    },
  };
  const cfg = map[status];
  return <Chip className={cfg.className}>{cfg.label}</Chip>;
}
