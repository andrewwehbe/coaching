'use client';

import { useState, useTransition } from 'react';

/**
 * Post-session effort capture. 1–10 Borg CR-10, matching resistance-training
 * literature. Skippable — the Done button on the summary page is not gated
 * on this. Re-tapping the same number clears it.
 *
 * Display hints follow the standard mapping (5 = moderate, 7 = hard,
 * 9 = ~1 RIR across the session, 10 = could not have done more).
 */
const SCALE: Array<{ value: number; hint?: string }> = [
  { value: 1 },
  { value: 2 },
  { value: 3 },
  { value: 4 },
  { value: 5, hint: 'moderate' },
  { value: 6 },
  { value: 7, hint: 'hard' },
  { value: 8 },
  { value: 9, hint: '~1 RIR' },
  { value: 10, hint: 'max' },
];

export function SrpePrompt({
  workoutId,
  initial,
}: {
  workoutId: string;
  initial: number | null;
}) {
  const [value, setValue] = useState<number | null>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function pick(rpe: number) {
    const next = value === rpe ? null : rpe;
    setValue(next);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/client/workout/${workoutId}/srpe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rpe: next }),
        });
        if (!res.ok) {
          setError('Failed to save — tap again');
          setValue(value);
        }
      } catch {
        setError('Network error');
        setValue(value);
      }
    });
  }

  const activeHint = value != null ? SCALE.find((s) => s.value === value)?.hint : null;

  return (
    <section className="mt-6 rounded-2xl border border-border bg-surface/60 px-4 py-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[10px] uppercase tracking-[0.22em] text-faint">
          Session effort
        </p>
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint tabular-nums">
          {value != null ? (
            <>
              <span className="text-text">{value}</span>
              {activeHint && (
                <span className="ml-1 text-faint">· {activeHint}</span>
              )}
            </>
          ) : (
            <span>not rated</span>
          )}
        </p>
      </div>
      <div className="grid grid-cols-10 gap-1.5">
        {SCALE.map((s) => {
          const active = value === s.value;
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => pick(s.value)}
              disabled={pending}
              aria-pressed={active}
              aria-label={`RPE ${s.value}${s.hint ? ` — ${s.hint}` : ''}`}
              className={
                'h-10 rounded-md text-sm tabular-nums transition-colors border ' +
                (active
                  ? 'border-primary bg-primary/20 text-primary-hi'
                  : 'border-border bg-bg hover:border-primary/40 text-muted hover:text-text')
              }
            >
              {s.value}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="mt-2 text-xs text-danger">{error}</p>
      )}
    </section>
  );
}
