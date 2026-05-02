import Link from 'next/link';
import { format } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;

export default async function AllHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; client?: string }>;
}) {
  await requireCoach();
  const { page: pageParam, client: clientFilter } = await searchParams;
  const page = Math.max(0, parseInt(pageParam ?? '0', 10) || 0);

  const supa = db();

  const { data: clients } = await supa
    .from('clients')
    .select('id, name')
    .order('name');

  let q = supa
    .from('workouts')
    .select('id, client_id, started_at, completed_at, days(label), clients(name)')
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  if (clientFilter) q = q.eq('client_id', clientFilter);
  const { data: workouts } = await q;

  const rows = (workouts ?? []).slice(0, PAGE_SIZE).map((w) => {
    const days = w.days as unknown;
    const day = (Array.isArray(days) ? days[0] : days) as { label?: string } | null;
    const cs = w.clients as unknown;
    const c = (Array.isArray(cs) ? cs[0] : cs) as { name?: string } | null;
    return {
      id: w.id,
      client_id: w.client_id,
      client_name: c?.name ?? '(unknown)',
      day_label: day?.label ?? null,
      completed_at: w.completed_at,
    };
  });
  const hasMore = (workouts ?? []).length > PAGE_SIZE;

  // Group rows by week_start (Monday-anchored, derived from completed_at).
  const byWeek = new Map<string, typeof rows>();
  for (const r of rows) {
    const d = new Date(r.completed_at!);
    const monday = new Date(d);
    const day = (d.getDay() + 6) % 7;
    monday.setDate(d.getDate() - day);
    const key = monday.toISOString().slice(0, 10);
    const arr = byWeek.get(key) ?? [];
    arr.push(r);
    byWeek.set(key, arr);
  }
  const weeks = [...byWeek.entries()].sort(([a], [b]) => (a < b ? 1 : -1));

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <Link href="/coach/sessions" className="text-sm text-muted hover:text-text transition-colors">
        ← This week
      </Link>
      <h1 className="mt-2 mb-3 text-2xl font-semibold tracking-tight">All history</h1>

      <div className="mb-5 flex flex-wrap gap-1.5 text-xs">
        <Link
          href="/coach/sessions/all"
          className={`px-2.5 py-1 rounded-full border transition-colors ${
            !clientFilter
              ? 'border-primary/50 bg-primary/10 text-primary-hi'
              : 'border-border text-muted hover:text-text'
          }`}
        >
          Everyone
        </Link>
        {(clients ?? []).map((c) => (
          <Link
            key={c.id}
            href={`/coach/sessions/all?client=${c.id}`}
            className={`px-2.5 py-1 rounded-full border transition-colors ${
              clientFilter === c.id
                ? 'border-primary/50 bg-primary/10 text-primary-hi'
                : 'border-border text-muted hover:text-text'
            }`}
          >
            {c.name}
          </Link>
        ))}
      </div>

      {weeks.length === 0 ? (
        <p className="text-sm text-muted">No completed sessions on record.</p>
      ) : (
        <div className="space-y-5">
          {weeks.map(([week, ws]) => (
            <div key={week}>
              <p className="text-xs uppercase tracking-[0.18em] text-faint mb-2">
                Week of {format(new Date(week), 'MMM d, yyyy')}
              </p>
              <ul className="space-y-1.5">
                {ws.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/coach/sessions/${r.id}`}
                      className="flex items-baseline justify-between gap-3 px-4 py-2.5 rounded-xl border border-border bg-surface/60 hover:bg-surface hover:border-primary/40 transition-colors"
                    >
                      <span className="text-sm">
                        <strong className="font-medium">{r.client_name}</strong>
                        {r.day_label && (
                          <span className="text-muted font-normal"> · {r.day_label}</span>
                        )}
                      </span>
                      <span className="text-xs text-faint shrink-0">
                        {format(new Date(r.completed_at!), 'EEE MMM d, h:mma')}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        {page > 0 ? (
          <Link
            href={`/coach/sessions/all?page=${page - 1}${clientFilter ? `&client=${clientFilter}` : ''}`}
            className="text-sm text-muted hover:text-text"
          >
            ← Newer
          </Link>
        ) : <span />}
        {hasMore ? (
          <Link
            href={`/coach/sessions/all?page=${page + 1}${clientFilter ? `&client=${clientFilter}` : ''}`}
            className="text-sm text-muted hover:text-text"
          >
            Older →
          </Link>
        ) : <span />}
      </div>
    </main>
  );
}
