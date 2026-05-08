import Link from 'next/link';
import { startOfWeek, formatISO, getISOWeek, getISOWeekYear } from 'date-fns';

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

  const isoWeek = getISOWeek(now);
  const isoWeekYear = getISOWeekYear(now);

  return (
    <main className="flex flex-1 flex-col min-h-0 max-w-5xl w-full mx-auto">
      {/* Editorial masthead */}
      <div className="px-5 sm:px-8 pt-6 pb-5 flex items-end justify-between gap-6 shrink-0">
        <div className="min-w-0 editorial-reveal">
          <p className="text-[10px] uppercase tracking-[0.28em] text-faint">Welcome back</p>
          <h1 className="mt-1 font-display text-4xl sm:text-6xl leading-[0.9] tracking-tight truncate">
            {user.name}
          </h1>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0 editorial-reveal" style={{ animationDelay: '60ms' }}>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-faint">
            WK {String(isoWeek).padStart(2, '0')} · {isoWeekYear}
          </p>
          <div className="flex items-center gap-5 text-[10px] uppercase tracking-[0.18em]">
            <Link
              href="/coach/sessions/all"
              prefetch={false}
              className="group relative pb-0.5 text-muted hover:text-text transition-colors"
            >
              All history
              <span aria-hidden className="absolute left-0 right-0 -bottom-px h-px bg-text/0 group-hover:bg-text/40 transition-colors" />
            </Link>
            <Link
              href="/coach/weekly"
              prefetch={false}
              className="group relative pb-0.5 text-muted hover:text-text transition-colors"
            >
              Weekly report
              <span aria-hidden className="absolute left-0 right-0 -bottom-px h-px bg-text/0 group-hover:bg-text/40 transition-colors" />
            </Link>
          </div>
        </div>
      </div>

      {/* Editorial 2x2 quadrants — hairlines instead of rounded boxes. */}
      <div className="grid grid-cols-2 grid-rows-2 flex-1 min-h-0 border-t border-border">
        <Quadrant
          href="/coach/sessions/remaining"
          eyebrow="Sessions left"
          hero={String(sessionsLeft)}
          tone={sessionsLeft > 0 ? 'warn' : 'good'}
          delay={120}
          rightBorder
          bottomBorder
        />
        <Quadrant
          href="/coach/sessions/live"
          eyebrow="Now training"
          hero={String(liveCount)}
          tone={liveCount > 0 ? 'good' : 'mute'}
          pulse={liveCount > 0}
          delay={200}
          bottomBorder
        />
        <Quadrant
          href="/coach/sessions"
          eyebrow="Done this week"
          hero={String(doneCount)}
          tone={doneCount > 0 ? 'good' : 'mute'}
          delay={280}
          rightBorder
        />
        <Quadrant
          href="/coach/clients"
          eyebrow="Clients"
          hero={String(activeCount)}
          tone="ink"
          delay={360}
        />
      </div>
    </main>
  );
}

function Quadrant(props: {
  href: string;
  eyebrow: string;
  hero: string;
  tone: 'good' | 'warn' | 'mute' | 'ink';
  pulse?: boolean;
  delay: number;
  rightBorder?: boolean;
  bottomBorder?: boolean;
}) {
  const heroClass =
    props.tone === 'good'
      ? 'text-primary-hi'
      : props.tone === 'warn'
        ? 'text-warn'
        : props.tone === 'mute'
          ? 'text-faint'
          : 'text-text';
  return (
    <Link
      href={props.href}
      prefetch={false}
      className={`group editorial-reveal relative flex flex-col justify-between min-h-0 px-5 sm:px-8 py-6 sm:py-8 hover:bg-surface/35 transition-colors ${
        props.rightBorder ? 'border-r border-border' : ''
      } ${props.bottomBorder ? 'border-b border-border' : ''}`}
      style={{ animationDelay: `${props.delay}ms` }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.24em] text-faint truncate">
          {props.eyebrow}
        </p>
        {props.pulse && (
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_12px_rgba(34,197,94,0.6)]" />
          </span>
        )}
      </div>

      <p
        className={`font-display tabular-nums leading-[0.82] tracking-[-0.02em] text-7xl sm:text-9xl ${heroClass}`}
      >
        {props.hero}
      </p>

      <span className="self-start inline-flex items-center gap-2 rounded-sm border border-border-strong group-hover:border-primary group-hover:text-text px-3 py-1.5 text-[10px] sm:text-[11px] uppercase tracking-[0.24em] font-medium text-muted transition-colors">
        View all
        <span
          aria-hidden
          className="font-display text-base leading-none translate-x-0 group-hover:translate-x-1 transition-transform duration-300"
        >
          →
        </span>
      </span>
    </Link>
  );
}
