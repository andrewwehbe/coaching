'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { Recommendation, RecommenderInput } from '@/lib/recommender';

type Decision = 'applied' | 'dismissed' | 'snoozed' | 'acknowledged';

const ACTIONS: Array<{ value: Decision; label: string; primary?: boolean }> = [
  { value: 'applied', label: 'Applied', primary: true },
  { value: 'acknowledged', label: 'Ack' },
  { value: 'snoozed', label: 'Snooze' },
  { value: 'dismissed', label: 'Dismiss' },
];

/**
 * Coach decision footer for the RecommendationCard. POSTs the full
 * recommendation snapshot + input signals so each decision row is a
 * complete record — analysis later can reproduce why a given
 * recommendation fired even after thresholds are tuned.
 */
export function RecommendationActions({
  clientId,
  rec,
  signals,
}: {
  clientId: string;
  rec: Recommendation;
  signals: RecommenderInput;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();
  const [submitted, setSubmitted] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(decision: Decision) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/coach/clients/${clientId}/recommendations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision,
            decision_note: note.trim() || null,
            rec_type: rec.type,
            title: rec.title,
            body: rec.body,
            forced_swaps: rec.forcedSwaps,
            rationale: rec.rationale,
            data_gaps: rec.dataGaps,
            signals: signalsToJson(signals),
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          setError(b.error ?? 'Failed to save');
          return;
        }
        setSubmitted(decision);
        setNote('');
        router.refresh();
      } catch {
        setError('Network error');
      }
    });
  }

  if (submitted) {
    return (
      <p className="mt-3 text-[10px] uppercase tracking-[0.22em] text-primary-hi">
        Logged · {submitted}
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)…"
        className="w-full rounded-lg bg-bg border border-border px-3 py-1.5 text-xs text-text focus:outline-none focus:border-primary/50"
      />
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((a) => (
          <button
            key={a.value}
            type="button"
            onClick={() => submit(a.value)}
            disabled={pending}
            className={
              'inline-flex items-center rounded-sm px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] font-medium transition-colors disabled:opacity-50 border ' +
              (a.primary
                ? 'border-primary bg-primary/15 hover:bg-primary/25 text-primary-hi'
                : 'border-border-strong bg-surface/40 hover:bg-surface text-muted hover:text-text')
            }
          >
            {a.label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** RecommenderInput contains some non-JSON-serializable date-likes
 *  indirectly through StallSignal etc. This passes through verbatim — all
 *  current fields are JSON-safe primitives or arrays of primitives. Keep
 *  this in sync if RecommenderInput grows non-serializable fields. */
function signalsToJson(s: RecommenderInput): Record<string, unknown> {
  return s as unknown as Record<string, unknown>;
}
