import Link from 'next/link';
import { format } from 'date-fns';
import { notFound, redirect } from 'next/navigation';

import { loadClientWorkout } from '@/lib/workout-guard';
import { buildSessionSummary, type ExerciseSummary } from '@/lib/session-summary';
import { SrpePrompt } from './srpe-prompt';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export default async function WorkoutSummaryPage(props: { params: Params }) {
  const { id } = await props.params;
  const ctx = await loadClientWorkout(id);
  if (!ctx) notFound();
  // Only show summary for completed workouts; for in-progress ones, send the
  // user back to the live session.
  if (!ctx.workout.completedAt) redirect(`/workout/${id}`);

  const summary = await buildSessionSummary(id);
  if (!summary) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-md w-full mx-auto">
      <Link
        href="/today"
        prefetch={false}
        className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
      >
        ← Today
      </Link>

      <header className="mt-4 mb-6">
        <p className="text-[10px] uppercase tracking-[0.28em] text-faint">Session complete</p>
        <h1 className="mt-1 font-display text-4xl sm:text-5xl tracking-tight leading-[0.95]">
          {summary.workout.dayLabel}
        </h1>
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
          {format(new Date(summary.workout.startedAt), 'EEE MMM d')}
          {summary.workout.durationMinutes != null && (
            <>
              {' '}
              <span className="mx-1 text-border-strong">·</span>{' '}
              {summary.workout.durationMinutes} min
            </>
          )}
        </p>
      </header>

      {/* Aggregate stats */}
      <section className="grid grid-cols-3 gap-2 mb-6">
        <Stat label="Sets" value={String(summary.totals.setCount)} />
        <Stat label="Volume" value={`${summary.totals.totalVolumeKg.toLocaleString()} kg`} />
        <Stat
          label={summary.totals.prCount === 1 ? 'PR' : 'PRs'}
          value={String(summary.totals.prCount)}
          accent={summary.totals.prCount > 0}
        />
      </section>

      {/* Per-exercise list */}
      {summary.exercises.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No exercises logged this session.
        </p>
      ) : (
        <ul className="border-t border-border">
          {summary.exercises.map((e) => (
            <li key={e.exerciseId} className="border-b border-border py-4">
              <ExerciseRow exercise={e} />
            </li>
          ))}
        </ul>
      )}

      <SrpePrompt workoutId={summary.workout.id} initial={summary.workout.sessionRpe} />

      <Link
        href="/today"
        prefetch={false}
        className="mt-8 self-stretch text-center px-4 py-3 rounded-xl bg-primary hover:bg-primary-hi text-bg text-sm font-semibold transition-colors"
      >
        Done
      </Link>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 px-3 py-3 text-center">
      <p className="text-[10px] uppercase tracking-[0.22em] text-faint">{label}</p>
      <p
        className={`mt-1 font-display text-2xl tabular-nums tracking-tight ${
          accent ? 'text-primary-hi' : 'text-text'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ExerciseRow({ exercise: e }: { exercise: ExerciseSummary }) {
  const top = e.topSet;
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-text truncate">{e.name}</p>
          <p className="mt-0.5 text-[11px] text-faint tabular-nums">
            {top
              ? `${top.weight} ${(top.unit ?? 'kg').toString().toUpperCase()} × ${top.reps}`
              : 'no sets logged'}
          </p>
        </div>
        {e.isPR && (
          <span className="shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-semibold px-2 py-1 rounded-sm border border-primary/50 bg-primary/15 text-primary-hi">
            PR
          </span>
        )}
      </div>
      <DeltaLine exercise={e} />
      {e.painReason && (
        <p className="mt-1 text-xs text-danger">Pain: {e.painReason}</p>
      )}
    </div>
  );
}

function DeltaLine({ exercise: e }: { exercise: ExerciseSummary }) {
  if (!e.topSet) return null;
  const d = e.delta;
  if (d.kind === 'first') {
    return (
      <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-faint">First time</p>
    );
  }
  const tone =
    d.kind === 'better'
      ? 'text-primary-hi'
      : d.kind === 'tied'
        ? 'text-muted'
        : 'text-warn';
  return (
    <p className={`mt-1 text-[11px] uppercase tracking-[0.18em] tabular-nums ${tone}`}>
      {d.text}
    </p>
  );
}
