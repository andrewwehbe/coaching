import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { PageHeader } from '../../ui';

export const dynamic = 'force-dynamic';

const LIVE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

type LiveRow = {
  id: string;
  clientName: string;
  dayLabel: string | null;
  startedAt: string;
  setsDone: number;
  exercisesTouched: number;
  currentExerciseName: string | null;
};

export default async function LiveSessionsPage() {
  await requireCoach();
  const supa = db();
  const since = new Date(Date.now() - LIVE_LOOKBACK_MS).toISOString();

  const { data: workouts } = await supa
    .from('workouts')
    .select(
      'id, started_at, days(label), clients(name), exercise_logs(id, exercise_id, created_at, exercises(name, position), sets(id))'
    )
    .is('completed_at', null)
    .eq('is_missed', false)
    .gte('started_at', since)
    .order('started_at', { ascending: false });

  const rows: LiveRow[] = (workouts ?? []).map((w) => {
    const cs = w.clients as unknown;
    const c = (Array.isArray(cs) ? cs[0] : cs) as { name?: string } | null;
    const ds = w.days as unknown;
    const d = (Array.isArray(ds) ? ds[0] : ds) as { label?: string } | null;
    const logs =
      (w.exercise_logs as Array<{
        id: string;
        exercise_id: string;
        created_at: string;
        exercises:
          | { name?: string; position?: number }
          | { name?: string; position?: number }[]
          | null;
        sets: { id: string }[] | null;
      }>) ?? [];

    let setsDone = 0;
    for (const l of logs) setsDone += (l.sets ?? []).length;

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
      id: w.id,
      clientName: c?.name ?? '(unknown)',
      dayLabel: d?.label ?? null,
      startedAt: w.started_at,
      setsDone,
      exercisesTouched: logs.length,
      currentExerciseName: ex?.name ?? null,
    };
  });

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <PageHeader
        back={{ href: '/coach', label: 'Home' }}
        eyebrow="Live"
        title="Now training"
        meta={
          <span>
            {rows.length === 0
              ? 'No one on the floor right now.'
              : `${rows.length} in progress · last 6h`}
          </span>
        }
      />

      {rows.length === 0 ? (
        <div className="border-t border-border pt-10 text-center">
          <p className="font-display text-2xl text-muted">
            When a client starts a workout, they show up here.
          </p>
        </div>
      ) : (
        <ul className="border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="border-b border-border">
              <Link
                href={`/coach/sessions/${r.id}`}
                prefetch={false}
                className="group flex items-baseline justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-display text-2xl sm:text-3xl tracking-tight leading-none truncate group-hover:text-primary-hi transition-colors">
                    {r.clientName}
                    {r.dayLabel && (
                      <span className="text-faint font-normal text-lg sm:text-xl ml-2">
                        · {r.dayLabel}
                      </span>
                    )}
                  </p>
                  <p className="mt-1.5 text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-faint">
                    {r.currentExerciseName ? (
                      <>
                        On{' '}
                        <span className="text-primary-hi normal-case tracking-normal text-xs">
                          {r.currentExerciseName}
                        </span>
                      </>
                    ) : (
                      'Starting up'
                    )}
                    <span className="mx-2 text-border-strong">·</span>
                    started{' '}
                    {formatDistanceToNow(new Date(r.startedAt), { addSuffix: true })}
                  </p>
                </div>
                <div className="flex items-baseline gap-4 shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  <span>
                    <span className="font-display text-base text-text tabular-nums">
                      {r.exercisesTouched}
                    </span>{' '}
                    ex
                  </span>
                  <span>
                    <span className="font-display text-base text-text tabular-nums">
                      {r.setsDone}
                    </span>{' '}
                    sets
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
