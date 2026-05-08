import Link from 'next/link';
import { format } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { PageHeader, PaginationLink, Pill } from '../../ui';

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

  let workoutQuery = supa
    .from('workouts')
    .select('id, client_id, started_at, completed_at, days(label), clients(name)')
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  if (clientFilter) workoutQuery = workoutQuery.eq('client_id', clientFilter);

  const [{ data: clients }, { data: workouts }] = await Promise.all([
    supa.from('clients').select('id, name').order('name'),
    workoutQuery,
  ]);

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
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <PageHeader
        back={{ href: '/coach/sessions', label: 'This week' }}
        eyebrow="Archive"
        title="All history"
      />

      <div className="mb-6 flex flex-wrap gap-1.5">
        <Pill href="/coach/sessions/all" active={!clientFilter}>
          Everyone
        </Pill>
        {(clients ?? []).map((c) => (
          <Pill
            key={c.id}
            href={`/coach/sessions/all?client=${c.id}`}
            active={clientFilter === c.id}
          >
            {c.name}
          </Pill>
        ))}
      </div>

      {weeks.length === 0 ? (
        <div className="border-t border-border pt-10 text-center">
          <p className="font-display text-2xl text-muted">No completed sessions on record.</p>
        </div>
      ) : (
        <div className="space-y-7">
          {weeks.map(([week, ws]) => (
            <div key={week}>
              <p className="text-[10px] uppercase tracking-[0.22em] text-faint mb-2 font-mono">
                Week of {format(new Date(week), 'MMM d, yyyy')}
              </p>
              <ul className="border-t border-border">
                {ws.map((r) => (
                  <li key={r.id} className="border-b border-border">
                    <Link
                      href={`/coach/sessions/${r.id}`}
                      prefetch={false}
                      className="group flex items-baseline justify-between gap-3 px-2 py-3 hover:bg-surface/40 transition-colors"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-display text-lg sm:text-xl tracking-tight group-hover:text-primary-hi transition-colors">
                          {r.client_name}
                        </span>
                        {r.day_label && (
                          <span className="text-faint font-normal text-sm ml-2">
                            · {r.day_label}
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.16em] text-faint shrink-0 font-mono">
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
          <PaginationLink
            href={`/coach/sessions/all?page=${page - 1}${clientFilter ? `&client=${clientFilter}` : ''}`}
          >
            ← Newer
          </PaginationLink>
        ) : (
          <span />
        )}
        {hasMore ? (
          <PaginationLink
            href={`/coach/sessions/all?page=${page + 1}${clientFilter ? `&client=${clientFilter}` : ''}`}
          >
            Older →
          </PaginationLink>
        ) : (
          <span />
        )}
      </div>
    </main>
  );
}
