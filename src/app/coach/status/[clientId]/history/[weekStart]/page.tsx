import Link from 'next/link';
import { format } from 'date-fns';
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { getWeekWorkouts } from '@/lib/client-history';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string; weekStart: string }>;

export default async function WeekDetailPage(props: { params: Params }) {
  await requireCoach();
  const { clientId, weekStart } = await props.params;

  const supa = db();
  const [workouts, { data: client }] = await Promise.all([
    getWeekWorkouts(clientId, weekStart),
    supa.from('clients').select('id, name').eq('id', clientId).maybeSingle(),
  ]);
  if (workouts == null || !client) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <Link
        href={`/coach/status/${clientId}/history`}
        prefetch={false}
        className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
      >
        ← {client.name} · history
      </Link>
      <h1 className="mt-4 font-display text-3xl sm:text-4xl tracking-tight">
        Week of {format(new Date(weekStart), 'MMM d, yyyy')}
      </h1>

      {workouts.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No workouts in this week.
        </p>
      ) : (
        <ul className="mt-6 border-t border-border">
          {workouts.map((w) => (
            <li key={w.id} className="border-b border-border">
              {w.isMissed ? (
                <div className="flex items-center justify-between gap-4 px-2 py-4 opacity-60">
                  <div>
                    <p className="font-display text-xl tracking-tight text-muted">
                      {w.dayLabel}
                    </p>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-faint">
                      Missed
                    </p>
                  </div>
                </div>
              ) : (
                <Link
                  href={`/coach/status/${clientId}/history/${weekStart}/${w.id}`}
                  prefetch={false}
                  className="flex items-center justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
                >
                  <div>
                    <p className="font-display text-xl tracking-tight">{w.dayLabel}</p>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
                      {format(new Date(w.startedAt), 'EEE h:mma').toLowerCase()}{' '}
                      <span className="mx-1 text-border-strong">·</span>{' '}
                      <span className="text-muted">{w.setCount}</span> sets
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
                          <span className="text-danger">pain</span>
                        </>
                      )}
                    </p>
                  </div>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
