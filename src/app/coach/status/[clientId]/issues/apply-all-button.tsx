'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { Suggestion } from '@/lib/suggestions';

type AutoApplyable = Suggestion & {
  apply: NonNullable<Extract<Suggestion['apply'], { kind: 'add_set' | 'archive_day' }>>;
};

export function ApplyAllButton({
  clientId,
  suggestions,
  swapsNeedingChoice,
}: {
  clientId: string;
  suggestions: Suggestion[];
  swapsNeedingChoice: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const auto = suggestions.filter(
    (s): s is AutoApplyable =>
      s.apply?.kind === 'add_set' || s.apply?.kind === 'archive_day',
  );

  if (auto.length === 0 && swapsNeedingChoice === 0) return null;

  async function applyAll() {
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: auto.length });
    for (let i = 0; i < auto.length; i++) {
      const s = auto[i];
      let payload: Record<string, unknown>;
      if (s.apply.kind === 'add_set') {
        payload = { kind: 'add_set', clientId, exerciseIds: s.apply.exerciseIds };
      } else {
        payload = { kind: 'archive_day', clientId, dayId: s.apply.dayId };
      }
      const res = await fetch('/api/coach/suggestions/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(`Stopped after ${i} of ${auto.length}: ${e.error ?? 'failed'}`);
        setBusy(false);
        return;
      }
      setProgress({ done: i + 1, total: auto.length });
    }
    setBusy(false);
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={auto.length === 0}
        className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-40 transition-colors"
      >
        Apply all ({auto.length})
      </button>
      {swapsNeedingChoice > 0 && (
        <p className="mt-2 text-[11px] text-faint">
          {swapsNeedingChoice} swap{swapsNeedingChoice === 1 ? '' : 's'} need manual choice — apply below.
        </p>
      )}
      {open && auto.length > 0 && (
        <div className="mt-3 rounded-2xl border border-border bg-surface/60 p-4 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint">
            Confirm — will apply each in order
          </p>
          <ul className="space-y-1 text-xs text-text">
            {auto.map((s) => (
              <li key={s.id}>
                ·{' '}
                {s.apply.kind === 'add_set'
                  ? `+1 set to ${s.apply.targetName}`
                  : `Archive ${s.apply.dayLabel}`}
              </li>
            ))}
          </ul>
          {progress && (
            <p className="text-[11px] text-muted tabular-nums">
              {progress.done} / {progress.total} applied
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={applyAll}
              disabled={busy || pending}
              className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              {busy ? 'Applying…' : 'Apply all'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface/40 text-text hover:bg-surface hover:border-border-strong text-xs font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
