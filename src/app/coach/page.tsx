import Link from 'next/link';
import { formatDistanceToNow, getISOWeek, getISOWeekYear } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries, type ClientSummary, type ClientStatus } from '@/lib/clients';
import { db } from '@/lib/supabase';
import { Badge, type BadgeTone } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Home is the roster.
 *
 * It used to open on four stat tiles (sessions left / now training / done
 * this week / clients) with a "needs attention" list underneath. The numbers
 * answered "how was the week" when the actual first question is "who needs
 * me". Those four destinations still exist and are reachable from the
 * Sessions nav tab; they're just no longer what greets you.
 *
 * The old triage list is folded in rather than kept alongside: it was the
 * same people rendered twice. Flagged clients sort to the top and keep the
 * richer caption ("2 pain reports to review"); on-track clients fall below
 * with a plain session count.
 */

// Pain outranks silence outranks schedule slippage; on-track sinks.
const STATUS_RANK: Record<ClientStatus, number> = {
  pain: 0,
  inactive: 1,
  behind: 2,
  on_track: 3,
};

export default async function CoachHome() {
  const user = await requireCoach();
  const supa = db();

  const now = new Date();
  const [summaries, alertsRes] = await Promise.all([
    listClientSummaries(),
    supa
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .is('acknowledged_at', null),
  ]);

  const roster = summaries
    .filter((c) => c.active)
    .sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (byStatus !== 0) return byStatus;
      return a.name.localeCompare(b.name);
    });

  const unackAlerts = alertsRes.count ?? 0;
  const flagged = roster.filter((c) => c.status !== 'on_track').length;
  const isoWeek = getISOWeek(now);
  const isoWeekYear = getISOWeekYear(now);

  return (
    <main className="flex flex-1 flex-col max-w-5xl w-full mx-auto">
      {/* Editorial masthead */}
      <div className="px-5 sm:px-8 pt-6 pb-5 flex items-end justify-between gap-6 shrink-0">
        <div className="min-w-0 editorial-reveal">
          <p className="text-[10px] uppercase tracking-[0.28em] text-faint">Welcome back</p>
          <h1 className="mt-1 font-display text-4xl sm:text-6xl leading-[0.9] tracking-tight truncate">
            {user.name}
          </h1>
        </div>
        <div
          className="flex flex-col items-end gap-1.5 shrink-0 editorial-reveal"
          style={{ animationDelay: '60ms' }}
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-faint">
            WK {String(isoWeek).padStart(2, '0')} · {isoWeekYear}
          </p>
          <div className="flex items-center gap-5 text-[10px] uppercase tracking-[0.18em]">
            <MastheadLink href="/coach/sessions/all">All history</MastheadLink>
            <MastheadLink href="/coach/status">Status</MastheadLink>
          </div>
        </div>
      </div>

      <section
        aria-label="Clients"
        className="border-t border-border editorial-reveal"
        style={{ animationDelay: '120ms' }}
      >
        <div className="px-5 sm:px-8 pt-5 pb-2 flex items-baseline justify-between gap-4">
          <p className="text-[10px] uppercase tracking-[0.28em] text-faint">
            Clients
            {flagged > 0 && (
              <span className="ml-2 text-warn">· {flagged} need{flagged === 1 ? 's' : ''} you</span>
            )}
          </p>
          {unackAlerts > 0 && (
            <Link
              href="/coach/alerts"
              prefetch={false}
              className="text-[10px] uppercase tracking-[0.18em] text-warn hover:text-text transition-colors"
            >
              {unackAlerts} unread alert{unackAlerts === 1 ? '' : 's'} →
            </Link>
          )}
        </div>

        {roster.length === 0 ? (
          <div className="px-5 sm:px-8 py-10 text-center border-t border-border">
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
            {roster.map((c) => (
              <li key={c.id} className="border-b border-border">
                <Link
                  href={`/coach/clients/${c.id}`}
                  prefetch={false}
                  className="group flex items-center justify-between gap-4 px-5 sm:px-8 py-3.5 hover:bg-surface/40 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-sm sm:text-base font-medium text-text truncate group-hover:text-primary-hi transition-colors">
                        {c.name}
                      </p>
                      {c.clientType === 'pt' && (
                        <Badge tone="progress" className="shrink-0">PT</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{caption(c)}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono tabular-nums text-xs text-faint">
                      {c.daysLoggedThisWeek}/{c.weeklyDayTarget}
                    </span>
                    <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
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

const STATUS_TONE: Record<ClientStatus, BadgeTone> = {
  pain: 'danger',
  inactive: 'neutral',
  behind: 'warn',
  on_track: 'done',
};

const STATUS_LABEL: Record<ClientStatus, string> = {
  pain: 'Pain',
  inactive: 'Quiet',
  behind: 'Behind',
  on_track: 'On track',
};

/**
 * Flagged rows get the reason; on-track rows get the plain weekly count.
 * This is the caption the old "needs attention" band carried — it says more
 * than a status chip can, which is why that band was worth folding in
 * rather than dropping.
 */
function caption(c: ClientSummary): string {
  if (c.status === 'pain') {
    return `${c.unackPainCount} pain report${c.unackPainCount === 1 ? '' : 's'} to review`;
  }
  if (c.status === 'inactive') {
    return c.lastActivityAt
      ? `Last trained ${formatDistanceToNow(new Date(c.lastActivityAt), { addSuffix: true })}`
      : 'No training logged yet';
  }
  if (c.status === 'behind') {
    return `${c.daysLoggedThisWeek} of ${c.weeklyDayTarget} days logged this week`;
  }
  return c.lastActivityAt
    ? `Last trained ${formatDistanceToNow(new Date(c.lastActivityAt), { addSuffix: true })}`
    : 'No training logged yet';
}

function MastheadLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="group relative pb-0.5 text-muted hover:text-text transition-colors"
    >
      {children}
      <span
        aria-hidden
        className="absolute left-0 right-0 -bottom-px h-px bg-text/0 group-hover:bg-text/40 transition-colors"
      />
    </Link>
  );
}
