import Link from 'next/link';
import { format, startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type SortMode = 'recent' | 'with_video';

type WorkoutRow = {
  id: string;
  client_id: string;
  client_name: string;
  day_label: string | null;
  started_at: string;
  completed_at: string | null;
  set_count: number;
  video_count: number;
  pain_count: number;
};

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  await requireCoach();
  const { sort } = await searchParams;
  const mode: SortMode = sort === 'with_video' ? 'with_video' : 'recent';

  const supa = db();
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });

  const { data: workouts } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, days(label), clients(name)')
    .gte('week_start', weekStartIso)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(200);

  const workoutIds = (workouts ?? []).map((w) => w.id);

  // Pull set + log info for the listed workouts in two batches.
  const { data: logs } = workoutIds.length
    ? await supa
        .from('exercise_logs')
        .select('id, workout_id, pain_reason')
        .in('workout_id', workoutIds)
    : { data: [] as never };
  const logIds = (logs ?? []).map((l) => l.id);
  const logToWorkout = new Map<string, string>();
  for (const l of logs ?? []) logToWorkout.set(l.id, l.workout_id);

  const painByWorkout = new Map<string, number>();
  for (const l of logs ?? []) {
    if (l.pain_reason) painByWorkout.set(l.workout_id, (painByWorkout.get(l.workout_id) ?? 0) + 1);
  }

  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('exercise_log_id, video_url')
        .in('exercise_log_id', logIds)
    : { data: [] as never };

  const setCount = new Map<string, number>();
  const videoCountByWorkout = new Map<string, number>();
  for (const s of sets ?? []) {
    const wid = logToWorkout.get(s.exercise_log_id);
    if (!wid) continue;
    setCount.set(wid, (setCount.get(wid) ?? 0) + 1);
    if (s.video_url) {
      videoCountByWorkout.set(wid, (videoCountByWorkout.get(wid) ?? 0) + 1);
    }
  }

  const rows: WorkoutRow[] = (workouts ?? []).map((w) => {
    const days = w.days as unknown;
    const day = (Array.isArray(days) ? days[0] : days) as { label?: string } | null;
    const cs = w.clients as unknown;
    const c = (Array.isArray(cs) ? cs[0] : cs) as { name?: string } | null;
    return {
      id: w.id,
      client_id: w.client_id,
      client_name: c?.name ?? '(unknown)',
      day_label: day?.label ?? null,
      started_at: w.started_at,
      completed_at: w.completed_at,
      set_count: setCount.get(w.id) ?? 0,
      video_count: videoCountByWorkout.get(w.id) ?? 0,
      pain_count: painByWorkout.get(w.id) ?? 0,
    };
  });

  const filtered = mode === 'with_video' ? rows.filter((r) => r.video_count > 0) : rows;

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <header className="mb-5">
        <Link href="/coach" className="text-sm text-muted hover:text-text transition-colors">
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sessions this week</h1>
        <p className="text-xs text-faint mt-1">Week of {format(weekStart, 'MMM d, yyyy')}</p>
      </header>

      <div className="flex gap-2 mb-4 text-xs">
        <Link
          href="/coach/sessions"
          className={`px-3 py-1.5 rounded-full border transition-colors ${
            mode === 'recent'
              ? 'border-primary/50 bg-primary/10 text-primary-hi'
              : 'border-border text-muted hover:text-text'
          }`}
        >
          All ({rows.length})
        </Link>
        <Link
          href="/coach/sessions?sort=with_video"
          className={`px-3 py-1.5 rounded-full border transition-colors ${
            mode === 'with_video'
              ? 'border-primary/50 bg-primary/10 text-primary-hi'
              : 'border-border text-muted hover:text-text'
          }`}
        >
          With video ({rows.filter((r) => r.video_count > 0).length})
        </Link>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted">No completed sessions yet this week.</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <li key={r.id}>
              <Link
                href={`/coach/sessions/${r.id}`}
                className="block rounded-2xl border border-border bg-surface/60 hover:bg-surface hover:border-primary/40 transition-colors p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {r.client_name}
                      {r.day_label && (
                        <span className="text-muted font-normal"> · {r.day_label}</span>
                      )}
                    </p>
                    <p className="text-xs text-faint mt-0.5">
                      {format(new Date(r.completed_at ?? r.started_at), 'EEE MMM d, h:mma')}
                      {r.pain_count > 0 && (
                        <span className="ml-2 text-warn">· {r.pain_count} pain</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted shrink-0">
                    <span className="tabular-nums">{r.set_count} sets</span>
                    {r.video_count > 0 && (
                      <span className="tabular-nums text-primary-hi">▶ {r.video_count}</span>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex justify-center">
        <Link
          href="/coach/sessions/all"
          className="text-sm text-primary-hi hover:text-primary px-4 py-2 rounded-xl border border-border hover:border-primary/40 transition-colors"
        >
          All history →
        </Link>
      </div>
    </main>
  );
}
