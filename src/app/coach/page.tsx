import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries, type ClientStatus } from '@/lib/clients';
import { db } from '@/lib/supabase';
import { LogoutButton } from '@/components/logout-button';
import { NotificationsToggle } from '@/components/notifications-toggle';
import { AlertsStrip } from './alerts-strip';

export const dynamic = 'force-dynamic';

export default async function CoachHome() {
  const user = await requireCoach();

  const supa = db();
  const [{ data: alerts }, clients] = await Promise.all([
    supa
      .from('alerts')
      .select('id, client_id, type, message, data, created_at, clients(name)')
      .is('acknowledged_at', null)
      .order('created_at', { ascending: false })
      .limit(20),
    listClientSummaries(),
  ]);

  const normalized = (alerts ?? []).map((a) => {
    const raw = a.clients as unknown;
    const c = Array.isArray(raw) ? raw[0] : raw;
    return { ...a, clients: c ? { name: (c as { name: string }).name } : null };
  });
  const sortedAlerts = normalized.slice().sort((a, b) => {
    if (a.type === 'pain' && b.type !== 'pain') return -1;
    if (b.type === 'pain' && a.type !== 'pain') return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <header className="mb-7">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">Coach</p>
            <h1 className="text-2xl font-semibold tracking-tight truncate">{user.name}</h1>
          </div>
          <NotificationsToggle />
          <Link
            href="/coach/clients/new"
            className="shrink-0 text-sm rounded-xl bg-primary hover:bg-primary-hi text-bg px-3.5 py-1.5 font-semibold transition-colors shadow-[0_8px_24px_-10px_rgba(34,197,94,0.6)]"
          >
            + Client
          </Link>
        </div>
        <div className="mt-3 flex items-center justify-end gap-4">
          <Link
            href="/coach/sessions"
            className="text-sm text-muted hover:text-text transition-colors"
          >
            Sessions
          </Link>
          <Link
            href="/coach/alerts"
            className="text-sm text-muted hover:text-text transition-colors"
          >
            Alerts
          </Link>
          <LogoutButton />
        </div>
      </header>

      <AlertsStrip alerts={sortedAlerts} />

      <section className="mt-7">
        <h2 className="text-xs uppercase tracking-[0.18em] text-faint mb-3">Clients</h2>
        {clients.length === 0 ? (
          <p className="text-muted text-sm">
            No clients yet.{' '}
            <Link href="/coach/clients/new" className="text-primary-hi hover:text-primary underline transition-colors">
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
                  className="block rounded-2xl px-4 py-3.5 border border-border bg-surface/60 hover:border-border-strong hover:bg-surface transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-text">{c.name}</p>
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
      </section>
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
    <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${cfg.className}`}>{cfg.label}</span>
  );
}
