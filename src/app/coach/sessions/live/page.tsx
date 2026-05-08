import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';

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
        exercises: { name?: string; position?: number } | { name?: string; position?: number }[] | null;
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
    <main className="flex flex-1 flex-col px-5 py-7 max-w-3xl w-full mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Current sessions</h1>
        <p className="text-xs text-faint mt-1">
          {rows.length === 0 ? 'No one training right now.' : `${rows.length} in progress · last 6h`}
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">When a client starts a workout, they&rsquo;ll show up here.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/coach/sessions/${r.id}`}
                className="block rounded-2xl border border-border bg-surface/60 hover:bg-surface hover:border-primary/40 transition-colors p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {r.clientName}
                      {r.dayLabel && (
                        <span className="text-muted font-normal"> · {r.dayLabel}</span>
                      )}
                    </p>
                    <p className="text-xs text-faint mt-0.5">
                      {r.currentExerciseName ? (
                        <>
                          On <span className="text-primary-hi">{r.currentExerciseName}</span>
                        </>
                      ) : (
                        <span>Starting up</span>
                      )}
                      <span> · started {formatDistanceToNow(new Date(r.startedAt), { addSuffix: true })}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted shrink-0 tabular-nums">
                    <span>{r.exercisesTouched} ex</span>
                    <span>{r.setsDone} sets</span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
