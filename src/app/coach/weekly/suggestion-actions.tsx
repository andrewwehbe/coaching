'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { Suggestion } from '@/lib/suggestions';

export function SuggestionRow({
  clientId,
  suggestion,
}: {
  clientId: string;
  suggestion: Suggestion;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed) return null;

  async function apply() {
    if (!suggestion.apply) return;
    setBusy(true);
    setError(null);
    try {
      const payload =
        suggestion.apply.kind === 'add_set'
          ? { kind: 'add_set', clientId, exerciseIds: suggestion.apply.exerciseIds }
          : { kind: 'archive_day', clientId, dayId: suggestion.apply.dayId };
      const res = await fetch('/api/coach/suggestions/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error ?? 'Failed');
        return;
      }
      setDone(true);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const chip = TYPE_CHIPS[suggestion.type];
  const applyHint =
    suggestion.apply?.kind === 'add_set'
      ? `Adds 1 set to ${suggestion.apply.targetName}`
      : suggestion.apply?.kind === 'archive_day'
        ? `Removes ${suggestion.apply.dayLabel} from the split`
        : null;

  return (
    <div
      className={`rounded-xl border px-3.5 py-3 transition-opacity ${
        done ? 'opacity-50' : ''
      } ${chip.cardClass}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded-full border ${chip.pillClass}`}
            >
              {chip.label}
            </span>
            <span className="text-sm font-medium text-text">{suggestion.title}</span>
          </div>
          <p className="text-xs text-muted leading-relaxed">{suggestion.body}</p>
          {applyHint && !done && (
            <p className="mt-1 text-[11px] text-faint italic">{applyHint}</p>
          )}
          {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {suggestion.apply && !done && (
            <button
              type="button"
              onClick={apply}
              disabled={busy || pending}
              className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              {busy ? '…' : 'Apply'}
            </button>
          )}
          {done && (
            <span className="text-xs text-primary-hi font-medium px-2 py-1.5">Applied</span>
          )}
          {!done && (
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="px-2 py-1.5 rounded-lg text-faint hover:text-text text-xs transition-colors"
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const TYPE_CHIPS: Record<
  Suggestion['type'],
  { label: string; pillClass: string; cardClass: string }
> = {
  watch: {
    label: 'Watch',
    pillClass: 'bg-warn/10 text-warn border-warn/35',
    cardClass: 'border-warn/25 bg-warn/5',
  },
  adjust: {
    label: 'Adjust',
    pillClass: 'bg-warn/15 text-warn border-warn/40',
    cardClass: 'border-warn/30 bg-warn/8',
  },
  swap_candidate: {
    label: 'Swap',
    pillClass: 'bg-danger/10 text-danger border-danger/35',
    cardClass: 'border-danger/30 bg-danger/8',
  },
  pain: {
    label: 'Pain',
    pillClass: 'bg-danger/10 text-danger border-danger/35',
    cardClass: 'border-danger/40 bg-danger/8',
  },
  adherence: {
    label: 'Adherence',
    pillClass: 'bg-warn/10 text-warn border-warn/35',
    cardClass: 'border-warn/25 bg-warn/5',
  },
  skipped_day: {
    label: 'Skipped',
    pillClass: 'bg-surface-2 text-muted border-border',
    cardClass: 'border-border bg-surface/40',
  },
};
