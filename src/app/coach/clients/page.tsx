import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries, type ClientStatus } from '@/lib/clients';

export const dynamic = 'force-dynamic';

export default async function ClientsPage() {
  await requireCoach();
  const clients = await listClientSummaries();

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-3xl w-full mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <Link
          href="/coach/clients/new"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-primary hover:bg-primary-hi text-bg px-4 py-2.5 text-sm font-semibold transition-colors shadow-[0_8px_24px_-10px_rgba(34,197,94,0.6)]"
        >
          <span className="text-base leading-none">+</span> New
        </Link>
      </header>

      {clients.length === 0 ? (
        <p className="text-muted text-sm">
          No clients yet.{' '}
          <Link
            href="/coach/clients/new"
            className="text-primary-hi hover:text-primary underline transition-colors"
          >
            Add one
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {clients.map((c) => (
            <li key={c.id}>
              <Link
                href={`/coach/clients/${c.id}`}
                prefetch={false}
                className="block rounded-2xl px-4 py-3.5 border border-border bg-surface/60 hover:border-border-strong hover:bg-surface transition-all"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-text truncate">{c.name}</p>
                    <p className="text-xs text-faint mt-0.5">
                      {c.daysLoggedThisWeek}/{c.weeklyDayTarget} this week
                      {c.lastActivityAt && (
                        <>
                          {' · last '}
                          {formatDistanceToNow(new Date(c.lastActivityAt), {
                            addSuffix: true,
                          })}
                        </>
                      )}
                    </p>
                  </div>
                  <StatusChip status={c.status} />
                </div>
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
      className: 'bg-primary/15 text-primary-hi border-primary/30',
    },
    behind: {
      label: 'Behind',
      className: 'bg-warn/10 text-warn border-warn/30',
    },
    inactive: {
      label: 'Inactive',
      className: 'bg-surface-2 text-muted border-border',
    },
    pain: {
      label: 'Pain',
      className: 'bg-danger/10 text-danger border-danger/35',
    },
  };
  const cfg = map[status];
  return (
    <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}
