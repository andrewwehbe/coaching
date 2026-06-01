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
  const [picking, setPicking] = useState(false);
  const [pickedName, setPickedName] = useState('');

  if (dismissed) return null;

  async function apply(replacementName?: string) {
    if (!suggestion.apply) return;
    setBusy(true);
    setError(null);
    try {
      let payload: Record<string, unknown>;
      if (suggestion.apply.kind === 'add_set') {
        payload = { kind: 'add_set', clientId, exerciseIds: suggestion.apply.exerciseIds };
      } else if (suggestion.apply.kind === 'archive_day') {
        payload = { kind: 'archive_day', clientId, dayId: suggestion.apply.dayId };
      } else if (suggestion.apply.kind === 'swap_exercise') {
        if (!replacementName) {
          setError('Pick a replacement first.');
          setBusy(false);
          return;
        }
        payload = {
          kind: 'swap_exercise',
          clientId,
          exerciseIds: suggestion.apply.exerciseIds,
          replacementName,
        };
      } else {
        return;
      }
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

  const chip = TYPE_CHIPS[suggestion.type] ?? UNKNOWN_CHIP;
  const applyHint =
    suggestion.apply?.kind === 'add_set'
      ? `Adds 1 set to ${suggestion.apply.targetName}`
      : suggestion.apply?.kind === 'archive_day'
        ? `Removes ${suggestion.apply.dayLabel} from the split`
        : suggestion.apply?.kind === 'swap_exercise'
          ? `Replaces ${suggestion.apply.targetName} across the program`
          : null;

  const isSwap = suggestion.apply?.kind === 'swap_exercise';
  const swapApply = isSwap && suggestion.apply?.kind === 'swap_exercise' ? suggestion.apply : null;

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
          {suggestion.apply && !done && !picking && (
            <button
              type="button"
              onClick={() => {
                if (isSwap) setPicking(true);
                else apply();
              }}
              disabled={busy || pending}
              className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              {busy ? '…' : isSwap ? 'Pick swap' : 'Apply'}
            </button>
          )}
          {done && (
            <span className="text-xs text-primary-hi font-medium px-2 py-1.5">Applied</span>
          )}
          {!done && !picking && (
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

      {picking && swapApply && !done && (
        <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
          <label className="block text-[11px] uppercase tracking-[0.18em] text-faint">
            Replace with
          </label>
          {swapApply.alternatives.length === 0 ? (
            <p className="text-xs text-warn">
              No catalog alternatives found for &quot;{swapApply.targetName}&quot;.
            </p>
          ) : (
            <select
              value={pickedName}
              onChange={(e) => setPickedName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg/70 border border-border text-text text-sm focus:outline-none focus:border-border-strong"
            >
              <option value="">Select replacement…</option>
              {swapApply.alternatives.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => apply(pickedName)}
              disabled={busy || pending || !pickedName}
              className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              {busy ? 'Saving…' : 'Confirm swap'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPicking(false);
                setPickedName('');
                setError(null);
              }}
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

// Per-suggestion-type chip styling. Suggestion['type'] is the single
// source of truth (see src/lib/suggestions.ts). Missing a key here
// compile-errors at the Record declaration the moment a new
// Suggestion type is added — Vercel will catch the build failure
// before deploy.
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
  // Stage 4 — fatigue / effort signals.
  deload: {
    label: 'Deload',
    pillClass: 'bg-warn/15 text-warn border-warn/40',
    cardClass: 'border-warn/30 bg-warn/8',
  },
  load_progression: {
    label: 'Load up',
    pillClass: 'bg-primary/15 text-primary-hi border-primary/35',
    cardClass: 'border-primary/30 bg-primary/8',
  },
  high_rir_stall: {
    label: 'Effort gap',
    pillClass: 'bg-warn/10 text-warn border-warn/35',
    cardClass: 'border-warn/25 bg-warn/5',
  },
  // Stage 5 — per-client weekly coaching note.
  weekly_note: {
    label: 'Weekly note',
    pillClass: 'bg-surface-2 text-muted border-border',
    cardClass: 'border-border bg-surface/40',
  },
};

const UNKNOWN_CHIP = {
  label: 'Suggestion',
  pillClass: 'bg-surface-2 text-muted border-border',
  cardClass: 'border-border bg-surface/40',
};
