import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries, type ClientStatus } from '@/lib/clients';
import { db } from '@/lib/supabase';
import { LogoutButton } from '@/components/logout-button';
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
      <header className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-neutral-400">Coach</p>
          <h1 className="text-2xl font-semibold">{user.name}</h1>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/coach/alerts"
            className="text-sm text-neutral-300 hover:text-neutral-100"
          >
            Alerts
          </Link>
          <Link
            href="/coach/clients/new"
            className="text-sm rounded-lg bg-emerald-700/80 hover:bg-emerald-700 px-3 py-1.5 font-medium"
          >
            + Client
          </Link>
          <LogoutButton />
        </div>
      </header>

      <AlertsStrip alerts={sortedAlerts} />

      <section className="mt-6">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500 mb-2">Clients</h2>
        {clients.length === 0 ? (
          <p className="text-neutral-400 text-sm">
            No clients yet.{' '}
            <Link href="/coach/clients/new" className="text-emerald-400 underline">
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
                  className="block rounded-xl px-4 py-3 border border-neutral-800 bg-neutral-900/40 hover:border-neutral-700 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{c.name}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">
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
      label: '✅ On track',
      className: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/40',
    },
    behind: {
      label: '⚠️ Behind',
      className: 'bg-amber-900/60 text-amber-200 border-amber-700/40',
    },
    inactive: {
      label: '⛔ Inactive',
      className: 'bg-neutral-800 text-neutral-400 border-neutral-700',
    },
    pain: {
      label: '🔴 Pain',
      className: 'bg-red-900/60 text-red-200 border-red-700/40',
    },
  };
  const cfg = map[status];
  return (
    <span className={`text-xs px-2 py-1 rounded-full border ${cfg.className}`}>{cfg.label}</span>
  );
}
