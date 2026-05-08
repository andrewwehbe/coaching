import Link from 'next/link';
import { startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries } from '@/lib/clients';
import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const LIVE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

export default async function CoachHome() {
  const user = await requireCoach();
  const supa = db();

  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });
  const sinceIso = new Date(Date.now() - LIVE_LOOKBACK_MS).toISOString();

  const [summaries, liveRes, doneRes] = await Promise.all([
    listClientSummaries(),
    supa
      .from('workouts')
      .select('id', { count: 'exact', head: true })
      .is('completed_at', null)
      .eq('is_missed', false)
      .gte('started_at', sinceIso),
    supa
      .from('workouts')
      .select('id', { count: 'exact', head: true })
      .gte('week_start', weekStartIso)
      .not('completed_at', 'is', null)
      .eq('is_missed', false),
  ]);

  const activeSummaries = summaries.filter((c) => c.active);

  const remainingClients = activeSummaries.filter(
    (c) => c.daysLoggedThisWeek < (c.weeklyDayTarget ?? 4)
  );
  const sessionsLeft = remainingClients.reduce(
    (sum, c) => sum + Math.max(0, (c.weeklyDayTarget ?? 4) - c.daysLoggedThisWeek),
    0
  );

  const liveCount = liveRes.count ?? 0;
  const doneCount = doneRes.count ?? 0;
  const activeCount = activeSummaries.length;

  return (
    <main className="flex flex-1 flex-col px-4 pt-3 pb-4 sm:pt-4 max-w-5xl w-full mx-auto min-h-0">
      <header className="mb-3 sm:mb-4 flex items-baseline justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint">Welcome back</p>
          <h1 className="mt-0.5 text-xl sm:text-2xl font-semibold tracking-tight truncate">
            {user.name}
          </h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/coach/sessions/all"
            prefetch={false}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 hover:bg-surface hover:border-primary/40 px-3 py-1.5 text-xs font-medium text-muted hover:text-text transition-colors"
          >
            All history
            <span aria-hidden>→</span>
          </Link>
          <Link
            href="/coach/weekly"
            prefetch={false}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 hover:bg-surface hover:border-primary/40 px-3 py-1.5 text-xs font-medium text-muted hover:text-text transition-colors"
          >
            <span aria-hidden>📊</span> Weekly
          </Link>
        </div>
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-2 grid-rows-2 gap-3 sm:gap-4">
        <DashBox
          href="/coach/sessions/remaining"
          eyebrow="Sessions left"
          hero={String(sessionsLeft)}
          tone={sessionsLeft > 0 ? 'warn' : 'good'}
        />
        <DashBox
          href="/coach/sessions/live"
          eyebrow="Current sessions"
          hero={String(liveCount)}
          tone={liveCount > 0 ? 'good' : 'neutral'}
          pulse={liveCount > 0}
        />
        <DashBox
          href="/coach/sessions"
          eyebrow="Done this week"
          hero={String(doneCount)}
          tone={doneCount > 0 ? 'good' : 'neutral'}
        />
        <DashBox
          href="/coach/clients"
          eyebrow="Clients"
          hero={String(activeCount)}
          tone="neutral"
        />
      </div>
    </main>
  );
}

function DashBox(props: {
  href: string;
  eyebrow: string;
  hero: string;
  tone: 'good' | 'warn' | 'neutral';
  pulse?: boolean;
}) {
  const heroClass =
    props.tone === 'good'
      ? 'text-primary-hi'
      : props.tone === 'warn'
        ? 'text-warn'
        : 'text-text';
  return (
    <Link
      href={props.href}
      prefetch={false}
      className="group relative flex flex-col justify-between rounded-2xl border border-border bg-surface/60 hover:bg-surface hover:border-primary/40 hover:-translate-y-[1px] transition-all duration-200 overflow-hidden min-h-0 px-4 py-4 sm:px-5 sm:py-5"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-faint truncate">
          {props.eyebrow}
        </p>
        {props.pulse && (
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_10px_rgba(34,197,94,0.55)]" />
          </span>
        )}
      </div>

      <p
        className={`text-5xl sm:text-7xl font-semibold tabular-nums leading-none tracking-tight ${heroClass}`}
      >
        {props.hero}
      </p>

      <span className="self-start inline-flex items-center gap-1 rounded-lg border border-border-strong group-hover:border-primary/55 bg-bg/30 group-hover:bg-bg/50 px-2.5 py-1 text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.14em] text-muted group-hover:text-primary-hi transition-colors">
        View all
        <span
          aria-hidden
          className="text-xs leading-none group-hover:translate-x-0.5 transition-transform"
        >
          →
        </span>
      </span>
    </Link>
  );
}
