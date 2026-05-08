import Link from 'next/link';
import { format, startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { PageHeader, Pill } from '../ui';

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
    .select(
      'id, client_id, day_id, started_at, completed_at, days(label), clients(name), exercise_logs(id, pain_reason, sets(video_url))'
    )
    .gte('week_start', weekStartIso)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(200);

  const rows: WorkoutRow[] = (workouts ?? []).map((w) => {
    const days = w.days as unknown;
    const day = (Array.isArray(days) ? days[0] : days) as { label?: string } | null;
    const cs = w.clients as unknown;
    const c = (Array.isArray(cs) ? cs[0] : cs) as { name?: string } | null;
    const logs =
      (w.exercise_logs as Array<{
        id: string;
        pain_reason: string | null;
        sets: Array<{ video_url: string | null }> | null;
      }>) ?? [];
    let setCount = 0;
    let videoCount = 0;
    let painCount = 0;
    for (const l of logs) {
      if (l.pain_reason) painCount++;
      for (const s of l.sets ?? []) {
        setCount++;
        if (s.video_url) videoCount++;
      }
    }
    return {
      id: w.id,
      client_id: w.client_id,
      client_name: c?.name ?? '(unknown)',
      day_label: day?.label ?? null,
      started_at: w.started_at,
      completed_at: w.completed_at,
      set_count: setCount,
      video_count: videoCount,
      pain_count: painCount,
    };
  });

  const filtered = mode === 'with_video' ? rows.filter((r) => r.video_count > 0) : rows;

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <PageHeader
        eyebrow="This week"
        title="Sessions"
        meta={<span>Week of {format(weekStart, 'MMM d, yyyy')}</span>}
      />

      <div className="flex gap-2 mb-5 flex-wrap">
        <Pill href="/coach/sessions" active={mode === 'recent'}>
          All ({rows.length})
        </Pill>
        <Pill href="/coach/sessions?sort=with_video" active={mode === 'with_video'}>
          With video ({rows.filter((r) => r.video_count > 0).length})
        </Pill>
      </div>

      {filtered.length === 0 ? (
        <div className="border-t border-border pt-10 text-center">
          <p className="font-display text-2xl text-muted">
            No completed sessions yet this week.
          </p>
        </div>
      ) : (
        <ul className="border-t border-border">
          {filtered.map((r) => (
            <li key={r.id} className="border-b border-border">
              <Link
                href={`/coach/sessions/${r.id}`}
                prefetch={false}
                className="group flex items-baseline justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-display text-xl sm:text-2xl tracking-tight leading-none truncate group-hover:text-primary-hi transition-colors">
                    {r.client_name}
                    {r.day_label && (
                      <span className="text-faint font-normal text-base sm:text-lg ml-2">
                        · {r.day_label}
                      </span>
                    )}
                  </p>
                  <p className="mt-1.5 text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-faint">
                    {format(new Date(r.completed_at ?? r.started_at), 'EEE MMM d, h:mma')}
                    {r.pain_count > 0 && (
                      <>
                        <span className="mx-2 text-border-strong">·</span>
                        <span className="text-warn">{r.pain_count} pain</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-baseline gap-4 shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                  <span className="tabular-nums">{r.set_count} sets</span>
                  {r.video_count > 0 && (
                    <span className="tabular-nums text-primary-hi">▶ {r.video_count}</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex justify-center">
        <Link
          href="/coach/sessions/all"
          prefetch={false}
          className="inline-flex items-center gap-2 rounded-sm border border-border-strong hover:border-primary px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium text-muted hover:text-text transition-colors"
        >
          All history
          <span aria-hidden className="font-display text-base leading-none">
            →
          </span>
        </Link>
      </div>
    </main>
  );
}
