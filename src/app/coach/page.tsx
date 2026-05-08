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
      .select(
        'id, started_at, clients(name), exercise_logs(id, created_at, exercises(name))'
      )
      .is('completed_at', null)
      .eq('is_missed', false)
      .gte('started_at', sinceIso)
      .order('started_at', { ascending: false }),
    supa
      .from('workouts')
      .select('id, exercise_logs(pain_reason, sets(video_url))')
      .gte('week_start', weekStartIso)
      .not('completed_at', 'is', null)
      .eq('is_missed', false),
  ]);

  const activeSummaries = summaries.filter((c) => c.active);

  // Top-left: sessions left this week.
  const remainingClients = activeSummaries.filter(
    (c) => c.daysLoggedThisWeek < (c.weeklyDayTarget ?? 4)
  );
  const sessionsLeft = remainingClients.reduce(
    (sum, c) => sum + Math.max(0, (c.weeklyDayTarget ?? 4) - c.daysLoggedThisWeek),
    0
  );

  // Top-right: live sessions.
  const live = (liveRes.data ?? []).map((w) => {
    const cs = w.clients as unknown;
    const c = (Array.isArray(cs) ? cs[0] : cs) as { name?: string } | null;
    const logs =
      (w.exercise_logs as Array<{
        created_at: string;
        exercises: { name?: string } | { name?: string }[] | null;
      }>) ?? [];
    const sortedLogs = logs
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const latest = sortedLogs[0];
    const ex = latest
      ? Array.isArray(latest.exercises)
        ? latest.exercises[0]
        : latest.exercises
      : null;
    return {
      clientName: c?.name ?? '(unknown)',
      currentExerciseName: ex?.name ?? null,
    };
  });

  // Bottom-left: sessions done this week.
  const doneCount = (doneRes.data ?? []).length;
  let videoCount = 0;
  let painCount = 0;
  for (const w of doneRes.data ?? []) {
    const logs =
      (w.exercise_logs as Array<{
        pain_reason: string | null;
        sets: { video_url: string | null }[] | null;
      }>) ?? [];
    let hasVideo = false;
    let hasPain = false;
    for (const l of logs) {
      if (l.pain_reason) hasPain = true;
      for (const s of l.sets ?? []) if (s.video_url) hasVideo = true;
    }
    if (hasVideo) videoCount++;
    if (hasPain) painCount++;
  }

  // Bottom-right: clients.
  const activeCount = activeSummaries.length;
  const onTrackCount = activeSummaries.filter((c) => c.status === 'on_track').length;
  const behindCount = activeSummaries.filter((c) => c.status === 'behind').length;
  const painClientCount = activeSummaries.filter((c) => c.status === 'pain').length;

  const liveSubline = (() => {
    if (live.length === 0) return 'No one training now';
    const first = live[0];
    const lead = first.currentExerciseName
      ? `${first.clientName} · ${first.currentExerciseName}`
      : first.clientName;
    if (live.length === 1) return lead;
    return `${lead}\n+${live.length - 1} more`;
  })();

  const clientsSubline = (() => {
    const parts = [`${onTrackCount} on track`];
    if (behindCount) parts.push(`${behindCount} behind`);
    if (painClientCount) parts.push(`${painClientCount} pain`);
    return parts.join(' · ');
  })();

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
          subline={
            remainingClients.length === 0
              ? 'Everyone hit target'
              : `${remainingClients.length} client${
                  remainingClients.length === 1 ? '' : 's'
                } still owed`
          }
          tone={sessionsLeft > 0 ? 'warn' : 'good'}
        />
        <DashBox
          href="/coach/sessions/live"
          eyebrow="Current sessions"
          hero={String(live.length)}
          subline={liveSubline}
          tone={live.length > 0 ? 'good' : 'neutral'}
          pulse={live.length > 0}
        />
        <DashBox
          href="/coach/sessions"
          eyebrow="Done this week"
          hero={String(doneCount)}
          subline={
            doneCount === 0
              ? 'No completions yet'
              : `${videoCount} with video${painCount ? ` · ${painCount} pain` : ''}`
          }
          tone={doneCount > 0 ? 'good' : 'neutral'}
        />
        <DashBox
          href="/coach/clients"
          eyebrow="Clients"
          hero={String(activeCount)}
          subline={activeCount === 0 ? 'Add your first' : clientsSubline}
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
  subline: string;
  tone: 'good' | 'warn' | 'neutral';
  pulse?: boolean;
}) {
  const heroClass =
    props.tone === 'good'
      ? 'text-primary-hi'
      : props.tone === 'warn'
        ? 'text-warn'
        : 'text-text';
  const borderClass =
    props.tone === 'good'
      ? 'border-primary/20'
      : props.tone === 'warn'
        ? 'border-warn/25'
        : 'border-border';
  const glowStyle =
    props.tone === 'good'
      ? {
          background:
            'radial-gradient(150% 90% at 100% 0%, rgba(74,222,128,0.11), transparent 62%)',
        }
      : props.tone === 'warn'
        ? {
            background:
              'radial-gradient(150% 90% at 100% 0%, rgba(251,191,36,0.10), transparent 62%)',
          }
        : undefined;
  return (
    <Link
      href={props.href}
      prefetch={false}
      className={`group relative isolate flex flex-col justify-between rounded-2xl border ${borderClass} bg-surface/60 hover:bg-surface hover:border-primary/45 hover:-translate-y-[1px] hover:shadow-[0_14px_36px_-18px_rgba(0,0,0,0.55)] transition-all duration-200 overflow-hidden min-h-0 px-4 py-4 sm:px-5 sm:py-5`}
    >
      {glowStyle && (
        <div className="absolute inset-0 pointer-events-none" style={glowStyle} />
      )}

      <div className="relative flex items-center justify-between gap-2">
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
        className={`relative text-5xl sm:text-7xl font-semibold tabular-nums leading-none tracking-tight ${heroClass}`}
      >
        {props.hero}
      </p>

      <div className="relative flex items-end justify-between gap-2">
        <p className="text-xs sm:text-sm text-muted whitespace-pre-line line-clamp-2 flex-1 min-w-0">
          {props.subline}
        </p>
        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.12em] text-faint group-hover:text-primary-hi transition-all">
          View all
          <span
            aria-hidden
            className="text-sm leading-none translate-x-0 group-hover:translate-x-0.5 transition-transform"
          >
            →
          </span>
        </span>
      </div>
    </Link>
  );
}
