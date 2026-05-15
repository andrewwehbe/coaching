import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { buildStatusOverview } from '@/lib/status-overview';
import { PageHeader } from '../ui';

export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  await requireCoach();
  const overview = await buildStatusOverview();
  const isSunday = new Date().getDay() === 0;

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <PageHeader
        eyebrow={isSunday ? 'Sunday — program review' : 'The week so far'}
        title="Status"
        meta={<span>Week of {format(new Date(overview.weekStart), 'MMM d, yyyy')}</span>}
      />

      {overview.rows.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No active clients yet.
        </p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {overview.rows.map((r) => (
            <li
              key={r.clientId}
              className="rounded-2xl border border-border bg-surface/60 px-4 py-4 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-text truncate">{r.name}</p>
                  <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                    {r.daysDone}/{r.weeklyDayTarget} days
                    {r.lastActivityAt && (
                      <span className="ml-2 text-faint/80">
                        · last{' '}
                        {formatDistanceToNow(new Date(r.lastActivityAt), { addSuffix: true })}
                      </span>
                    )}
                  </p>
                </div>
                <StatusBadge
                  hasIssues={r.hasActionableIssues}
                  count={r.issueCount}
                  emphasized={isSunday}
                />
              </div>

              <div className="flex items-center gap-2">
                <Link
                  href={`/coach/status/${r.clientId}/history`}
                  prefetch={false}
                  className="flex-1 rounded-lg border border-border bg-surface/40 text-text text-xs font-medium text-center py-2 hover:bg-surface hover:border-border-strong transition-colors"
                >
                  View
                </Link>
                <Link
                  href={`/coach/status/${r.clientId}/issues`}
                  prefetch={false}
                  className={`flex-1 rounded-lg text-xs font-semibold text-center py-2 transition-colors ${
                    r.hasActionableIssues
                      ? 'bg-primary hover:bg-primary-hi text-bg'
                      : 'border border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong'
                  }`}
                >
                  {r.hasActionableIssues ? 'Open' : 'Review'}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function StatusBadge({
  hasIssues,
  count,
  emphasized,
}: {
  hasIssues: boolean;
  count: number;
  emphasized: boolean;
}) {
  if (hasIssues) {
    return (
      <span
        className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-1 rounded-sm border ${
          emphasized
            ? 'border-danger/60 bg-danger/15 text-danger animate-pulse'
            : 'border-danger/30 bg-danger/8 text-danger'
        }`}
      >
        Issues ({count})
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-1 rounded-sm border ${
        emphasized
          ? 'border-primary/50 bg-primary/15 text-primary-hi'
          : 'border-border bg-surface-2 text-muted'
      }`}
    >
      All set
    </span>
  );
}
