import { redirect } from 'next/navigation';
import Link from 'next/link';
import { format, formatDistanceToNow, startOfWeek, formatISO, subWeeks } from 'date-fns';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { linkForClient } from '@/lib/coach-link';
import { HeaderMenu } from '@/components/header-menu';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PR_LOOKBACK_DAYS = 30;
const WEEKS_OF_HISTORY = 8;

type WorkoutRow = { id: string; week_start: string; completed_at: string | null };

export default async function TrendsPage() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'client') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const supa = db();
  const since = new Date();
  since.setDate(since.getDate() - PR_LOOKBACK_DAYS);
  const weeksAgo = subWeeks(startOfWeek(new Date(), { weekStartsOn: 1 }), WEEKS_OF_HISTORY);
  const weeksAgoIso = formatISO(weeksAgo, { representation: 'date' });

  const [
    { data: prs },
    { data: weights },
    { data: workouts },
    { data: client },
    link,
  ] = await Promise.all([
    supa
      .from('best_efforts')
      .select('exercise_name_key, best_weight, best_unit, best_reps, updated_at')
      .eq('client_id', user.id)
      .gte('updated_at', since.toISOString())
      .not('source_set_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(20),
    supa
      .from('check_ins')
      .select('date, body_weight, body_weight_unit')
      .eq('client_id', user.id)
      .not('body_weight', 'is', null)
      .gte('date', weeksAgoIso)
      .order('date', { ascending: true }),
    supa
      .from('workouts')
      .select('id, week_start, completed_at')
      .eq('client_id', user.id)
      .gte('week_start', weeksAgoIso)
      .not('completed_at', 'is', null),
    supa
      .from('clients')
      .select('weekly_day_target, name')
      .eq('id', user.id)
      .maybeSingle(),
    linkForClient(user.id),
  ]);

  const target = client?.weekly_day_target ?? 4;
  const weekBuckets = bucketByWeek(workouts ?? [], WEEKS_OF_HISTORY);

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <div className="flex items-center justify-between mb-5">
        <Link href="/today" className="text-sm text-muted hover:text-text transition-colors">
          ← Today
        </Link>
        <HeaderMenu
          switchKind={link ? 'switch-to-coach' : null}
          switchLabel="Coach"
        />
      </div>

      <header className="mb-7">
        <p className="text-[10px] uppercase tracking-[0.22em] text-faint">Trends</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{user.name}</h1>
      </header>

      <PrSection prs={prs ?? []} />
      <ConsistencySection buckets={weekBuckets} target={target} />
      <BodyWeightSection rows={weights ?? []} />
    </main>
  );
}

function PrSection({
  prs,
}: {
  prs: Array<{
    exercise_name_key: string;
    best_weight: number | null;
    best_unit: string | null;
    best_reps: number | null;
    updated_at: string;
  }>;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-xs uppercase tracking-[0.22em] text-faint">Recent PRs</h2>
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint">last 30 days</p>
      </div>
      {prs.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No PRs yet. Log some sets and they&rsquo;ll show up here.
        </p>
      ) : (
        <ul className="rounded-2xl border border-border bg-surface/40 divide-y divide-border">
          {prs.map((p) => (
            <li
              key={`${p.exercise_name_key}-${p.updated_at}`}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <p className="text-sm font-medium truncate">{prettyExerciseName(p.exercise_name_key)}</p>
              <p className="text-sm tabular-nums shrink-0">
                <span className="text-text font-semibold">
                  {p.best_weight ?? '?'}
                  {(p.best_unit ?? 'kg').toUpperCase()}
                </span>
                <span className="text-muted"> × {p.best_reps ?? '?'}</span>
                <span className="ml-2 text-faint text-xs">
                  {formatDistanceToNow(new Date(p.updated_at), { addSuffix: true })}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type WeekBucket = { weekStart: string; count: number };

function bucketByWeek(workouts: WorkoutRow[], weeks: number): WeekBucket[] {
  const counts = new Map<string, number>();
  for (const w of workouts) {
    counts.set(w.week_start, (counts.get(w.week_start) ?? 0) + 1);
  }
  const buckets: WeekBucket[] = [];
  const today = startOfWeek(new Date(), { weekStartsOn: 1 });
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = subWeeks(today, i);
    const iso = formatISO(ws, { representation: 'date' });
    buckets.push({ weekStart: iso, count: counts.get(iso) ?? 0 });
  }
  return buckets;
}

function ConsistencySection({ buckets, target }: { buckets: WeekBucket[]; target: number }) {
  const totalDone = buckets.reduce((n, b) => n + b.count, 0);
  const totalTarget = buckets.length * target;
  const pct = totalTarget === 0 ? 0 : Math.round((totalDone / totalTarget) * 100);
  const max = Math.max(target, ...buckets.map((b) => b.count));

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-xs uppercase tracking-[0.22em] text-faint">Consistency</h2>
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint tabular-nums">
          {totalDone} / {totalTarget} · {pct}%
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <div className="flex items-end justify-between gap-1.5 h-24">
          {buckets.map((b) => {
            const height = max === 0 ? 0 : (b.count / max) * 100;
            const hit = b.count >= target;
            return (
              <div key={b.weekStart} className="flex-1 flex flex-col items-center gap-1.5">
                <div className="flex-1 w-full flex items-end">
                  <div
                    className={`w-full rounded-sm ${
                      b.count === 0
                        ? 'bg-surface-2'
                        : hit
                          ? 'bg-primary'
                          : 'bg-warn/60'
                    }`}
                    style={{ height: `${height}%`, minHeight: b.count > 0 ? 4 : 0 }}
                  />
                </div>
                <p className="text-[9px] tabular-nums text-faint">{b.count}</p>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-faint text-center">
          {buckets.length} weeks · target {target}/week
        </p>
      </div>
    </section>
  );
}

function BodyWeightSection({
  rows,
}: {
  rows: Array<{ date: string; body_weight: number | null; body_weight_unit: string | null }>;
}) {
  if (rows.length < 2) {
    return null; // not enough data to plot
  }
  const unit = rows[0].body_weight_unit ?? 'kg';
  const sameUnit = rows.every((r) => (r.body_weight_unit ?? 'kg') === unit);
  const points = rows
    .filter((r): r is { date: string; body_weight: number; body_weight_unit: string | null } =>
      r.body_weight != null,
    )
    .map((r) => ({ x: new Date(r.date).getTime(), y: Number(r.body_weight) }));

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padY = (maxY - minY) * 0.15 || 1;
  const yLo = minY - padY;
  const yHi = maxY + padY;

  const W = 320;
  const H = 100;
  const path = points
    .map((p, i) => {
      const x = maxX === minX ? W / 2 : ((p.x - minX) / (maxX - minX)) * W;
      const y = H - ((p.y - yLo) / (yHi - yLo)) * H;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.y - first.y;
  const deltaSign = delta > 0 ? '+' : '';

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-xs uppercase tracking-[0.22em] text-faint">Body weight</h2>
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint tabular-nums">
          {sameUnit ? `${deltaSign}${delta.toFixed(1)}${unit}` : 'mixed units'}
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-surface/40 px-4 py-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" preserveAspectRatio="none">
          <path d={path} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {points.map((p, i) => {
            const x = maxX === minX ? W / 2 : ((p.x - minX) / (maxX - minX)) * W;
            const y = H - ((p.y - yLo) / (yHi - yLo)) * H;
            return <circle key={i} cx={x} cy={y} r={2} fill="var(--primary-hi)" />;
          })}
        </svg>
        <div className="flex items-center justify-between mt-2 text-[10px] text-faint tabular-nums">
          <span>
            {format(new Date(first.x), 'MMM d')} · {first.y}
            {unit}
          </span>
          <span>
            {format(new Date(last.x), 'MMM d')} · {last.y}
            {unit}
          </span>
        </div>
      </div>
    </section>
  );
}

function prettyExerciseName(nameKey: string): string {
  // name_key is `d{idx}::{lower normalized name}`. Strip the prefix and
  // capitalize first letter for display.
  const m = nameKey.match(/^d\d+::(.+)$/);
  const stripped = m ? m[1] : nameKey;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
