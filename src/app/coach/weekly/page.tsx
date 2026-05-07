import Link from 'next/link';
import { format } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { buildWeeklyReport } from '@/lib/weekly-report';
import { SuggestionRow } from './suggestion-actions';

export const dynamic = 'force-dynamic';

export default async function WeeklyReportPage() {
  await requireCoach();
  const report = await buildWeeklyReport();

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-3xl w-full mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Weekly report</h1>
        <p className="text-xs text-faint mt-1">
          Week of {format(new Date(report.weekStart), 'MMM d, yyyy')}
        </p>
      </header>

      <section className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Completion" value={`${report.totals.completionPct}%`} />
        <Stat label="Sets" value={String(report.totals.totalSets)} />
        <Stat label="Videos" value={String(report.totals.totalVideos)} />
        <Stat label="PRs" value={String(report.totals.totalPRs)} />
      </section>

      <ul className="space-y-2">
        {report.rows.map((r) => {
          const onTrack = r.daysDone >= r.daysTarget;
          const pct = r.daysTarget === 0 ? 0 : Math.min(100, Math.round((r.daysDone / r.daysTarget) * 100));
          return (
            <li
              key={r.clientId}
              className={`rounded-2xl border px-4 py-3.5 transition-colors ${
                r.painExercises > 0
                  ? 'border-danger/40 bg-danger/8'
                  : onTrack
                    ? 'border-primary/30 bg-primary/8'
                    : 'border-border bg-surface/60'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <Link
                  href={`/coach/clients/${r.clientId}`}
                  prefetch={false}
                  className="font-medium text-text hover:text-primary-hi transition-colors"
                >
                  {r.name}
                </Link>
                <span
                  className={`text-sm tabular-nums font-medium ${
                    onTrack ? 'text-primary-hi' : 'text-muted'
                  }`}
                >
                  {r.daysDone}/{r.daysTarget}
                  <span className="text-faint font-normal"> days</span>
                </span>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    onTrack ? 'bg-primary' : 'bg-muted/50'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
                <span>
                  <span className="text-text">{r.totalSets}</span> sets
                </span>
                {r.videos > 0 && (
                  <span>
                    <span className="text-text">{r.videos}</span> videos
                  </span>
                )}
                {r.prs > 0 && (
                  <span className="text-primary-hi">
                    {r.prs} PR{r.prs === 1 ? '' : 's'}
                  </span>
                )}
                {r.painExercises > 0 && (
                  <span className="text-danger">
                    {r.painExercises} pain
                  </span>
                )}
                {r.stalledEscalations > 0 && (
                  <span className="text-warn">
                    {r.stalledEscalations} stalled
                  </span>
                )}
                {r.bodyWeight && (
                  <span>
                    <span className="text-text tabular-nums">
                      {r.bodyWeight.value}
                      {(r.bodyWeight.unit ?? 'kg').toUpperCase()}
                    </span>
                    {r.bodyWeight.deltaFromPrior != null && (
                      <span
                        className={`ml-1 tabular-nums ${
                          r.bodyWeight.deltaFromPrior > 0
                            ? 'text-warn'
                            : r.bodyWeight.deltaFromPrior < 0
                              ? 'text-primary-hi'
                              : 'text-faint'
                        }`}
                      >
                        {r.bodyWeight.deltaFromPrior > 0 ? '+' : ''}
                        {r.bodyWeight.deltaFromPrior}
                      </span>
                    )}
                  </span>
                )}
                {!r.checkedIn && (
                  <span className="text-faint italic">no check-in</span>
                )}
              </div>

              {r.suggestions.length > 0 && (
                <div className="mt-3 space-y-2">
                  {r.suggestions.map((s) => (
                    <SuggestionRow key={s.id} clientId={r.clientId} suggestion={s} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 px-3.5 py-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-faint">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
