import Link from 'next/link';
import { format } from 'date-fns';
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { listClientWeeks } from '@/lib/client-history';
import { buildClientIssues } from '@/lib/client-issues';
import { ClientHeader } from '../_components/client-header';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string }>;

export default async function ClientHistoryPage(props: { params: Params }) {
  await requireCoach();
  const { clientId } = await props.params;

  // Re-fetch lightweight client info (parallel with weeks list) for the header.
  const supa = db();
  const [issues, weeks, { data: client }] = await Promise.all([
    buildClientIssues(clientId),
    listClientWeeks(clientId),
    supa
      .from('clients')
      .select('id, name, weekly_day_target')
      .eq('id', clientId)
      .maybeSingle(),
  ]);

  if (!client || !issues || weeks == null) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <ClientHeader
        clientId={client.id}
        name={client.name}
        weeklyDayTarget={client.weekly_day_target}
        daysDone={issues.daysDoneThisWeek}
        hasIssues={issues.hasActionableIssues}
        issueCount={issues.issueCount}
        subnav="history"
      />

      {weeks.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No program uploaded yet.
        </p>
      ) : (
        <ul className="border-t border-border">
          {weeks.map((w) => (
            <li key={w.weekStart} className="border-b border-border">
              {w.hasWorkouts ? (
                <Link
                  href={`/coach/status/${clientId}/history/${w.weekStart}`}
                  prefetch={false}
                  className="group flex items-center justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
                >
                  <WeekRow w={w} muted={false} />
                </Link>
              ) : (
                <div className="flex items-center justify-between gap-4 px-2 py-4 opacity-60">
                  <WeekRow w={w} muted />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function WeekRow({
  w,
  muted,
}: {
  w: {
    weekStart: string;
    daysDone: number;
    daysTarget: number;
    totalSets: number;
    prCount: number;
    painCount: number;
    hasWorkouts: boolean;
  };
  muted: boolean;
}) {
  return (
    <>
      <p className={`font-display text-xl tracking-tight ${muted ? 'text-muted' : 'text-text'}`}>
        Week of {format(new Date(w.weekStart), 'MMM d')}
      </p>
      <p className="text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
        {muted ? (
          <span>no logs</span>
        ) : (
          <>
            <span className="text-muted">
              {w.daysDone}/{w.daysTarget}
            </span>{' '}
            days <span className="mx-1 text-border-strong">·</span>{' '}
            <span className="text-muted">{w.totalSets}</span> sets
            {w.prCount > 0 && (
              <>
                {' '}
                <span className="mx-1 text-border-strong">·</span>{' '}
                <span className="text-primary-hi">
                  {w.prCount} PR{w.prCount === 1 ? '' : 's'}
                </span>
              </>
            )}
            {w.painCount > 0 && (
              <>
                {' '}
                <span className="mx-1 text-border-strong">·</span>{' '}
                <span className="text-danger">{w.painCount} pain</span>
              </>
            )}
          </>
        )}
      </p>
    </>
  );
}
