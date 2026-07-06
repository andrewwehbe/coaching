'use client';

import { useState } from 'react';
import Link from 'next/link';

export type HistorySet = {
  setId: string;
  weight: number;
  unit: string;
  reps: number;
  rir: number | null;
};

export type HistorySession = {
  workoutId: string;
  date: string; // YYYY-MM-DD
  isDeload: boolean;
  inCurrentBlock: boolean;
  sets: HistorySet[];
};

export type CurrentBest = {
  weight: number;
  unit: string;
  reps: number | null;
  sourceSetId: string | null;
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function fmtWeight(w: number, unit: string): string {
  const n = Number.isInteger(w) ? String(w) : w.toFixed(1);
  return `${n}${unit ? unit.toUpperCase() : ''}`;
}

export function ExerciseHistoryClient({
  exerciseName,
  sessions,
  currentBest,
}: {
  exerciseName: string;
  sessions: HistorySession[];
  currentBest: CurrentBest | null;
}) {
  const [best, setBest] = useState<CurrentBest | null>(currentBest);
  const [pendingSetId, setPendingSetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSetId, setJustSetId] = useState<string | null>(null);

  const current = sessions.filter((s) => s.inCurrentBlock);
  const earlier = sessions.filter((s) => !s.inCurrentBlock);

  async function setAsBest(set: HistorySet) {
    setError(null);
    setPendingSetId(set.setId);
    try {
      const res = await fetch('/api/client/exercise/set-best', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setId: set.setId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'Could not set best');
      }
      setBest({
        weight: set.weight,
        unit: set.unit,
        reps: set.reps,
        sourceSetId: set.setId,
      });
      setJustSetId(set.setId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set best');
    } finally {
      setPendingSetId(null);
    }
  }

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-md w-full mx-auto">
      <header className="mb-6">
        <Link
          href="/today"
          prefetch={false}
          className="text-sm text-muted hover:text-text transition-colors"
        >
          ← Today
        </Link>
        <p className="mt-5 text-[11px] uppercase tracking-[0.24em] text-faint">History</p>
        <h1 className="font-display text-3xl sm:text-4xl tracking-tight leading-[1.05] mt-1">
          {exerciseName}
        </h1>

        <div className="mt-4 rounded-2xl border border-primary/40 bg-primary/8 px-4 py-3">
          <p className="text-[10px] uppercase tracking-[0.18em] text-primary-hi">Current best</p>
          {best ? (
            <p className="mt-0.5 text-2xl font-semibold tabular-nums">
              {fmtWeight(best.weight, best.unit)}
              {best.reps != null && (
                <span className="text-muted text-lg font-medium"> × {best.reps}</span>
              )}
            </p>
          ) : (
            <p className="mt-0.5 text-base text-muted">Not set yet</p>
          )}
          <p className="mt-1 text-xs text-muted">
            Tap “Set as best” on any set below to make it your target.
          </p>
        </div>

        {error && (
          <p className="mt-3 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </header>

      {sessions.length === 0 ? (
        <div className="border-t border-border pt-10 text-center text-muted">
          <p className="font-display text-2xl">No logged history yet.</p>
          <p className="mt-1 text-sm">Sets you log for this exercise will show up here.</p>
        </div>
      ) : (
        <div className="space-y-7">
          <Section
            title="This block"
            sessions={current}
            bestSetId={best?.sourceSetId ?? null}
            pendingSetId={pendingSetId}
            justSetId={justSetId}
            onSetBest={setAsBest}
          />
          <Section
            title="Earlier"
            sessions={earlier}
            bestSetId={best?.sourceSetId ?? null}
            pendingSetId={pendingSetId}
            justSetId={justSetId}
            onSetBest={setAsBest}
          />
        </div>
      )}

      <div className="mt-8">
        <Link
          href="/today"
          prefetch={false}
          className="flex w-full items-center justify-center h-12 rounded-2xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors"
        >
          Back to today
        </Link>
      </div>
    </main>
  );
}

function Section({
  title,
  sessions,
  bestSetId,
  pendingSetId,
  justSetId,
  onSetBest,
}: {
  title: string;
  sessions: HistorySession[];
  bestSetId: string | null;
  pendingSetId: string | null;
  justSetId: string | null;
  onSetBest: (set: HistorySet) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-faint mb-3">{title}</h2>
      <ol className="space-y-3">
        {sessions.map((s) => (
          <li key={s.workoutId} className="rounded-2xl border border-border bg-surface/60 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60 bg-surface-2/40">
              <span className="text-sm font-medium tabular-nums">{fmtDate(s.date)}</span>
              {s.isDeload && (
                <span className="text-[9px] uppercase tracking-[0.16em] text-accent border border-accent/30 bg-accent/8 rounded-full px-2 py-0.5">
                  Deload
                </span>
              )}
            </div>
            <ul className="divide-y divide-border/50">
              {s.sets.map((set) => {
                const isBest = bestSetId != null && set.setId === bestSetId;
                const isPending = pendingSetId === set.setId;
                const justSet = justSetId === set.setId;
                return (
                  <li key={set.setId} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="tabular-nums">
                      <span className="text-base font-semibold">{fmtWeight(set.weight, set.unit)}</span>
                      <span className="text-muted"> × {set.reps}</span>
                      {set.rir != null && (
                        <span className="text-faint text-sm"> @{set.rir} RIR</span>
                      )}
                    </span>
                    {isBest ? (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.12em] text-primary-hi border border-primary/40 bg-primary/10 rounded-full px-2.5 py-1">
                        {justSet ? 'Set ✓' : 'Best'}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => onSetBest(set)}
                        className="shrink-0 text-xs font-medium rounded-xl border border-border px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-text transition-colors disabled:opacity-40"
                      >
                        {isPending ? 'Setting…' : 'Set as best'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
