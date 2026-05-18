'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ClientActions({
  clientId,
  active,
  currentWeekIsDeload,
  logMode,
}: {
  clientId: string;
  active: boolean;
  currentWeekIsDeload: boolean;
  logMode: 'sets' | 'best' | 'all';
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [newPin, setNewPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setLogMode(next: 'sets' | 'best' | 'all') {
    if (next === logMode) return;
    setBusy('logmode');
    setError(null);
    try {
      const res = await fetch(`/api/coach/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ log_mode: next }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Failed');
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    if (
      !confirm(
        'Generate a new PIN? The old one stops working immediately and the client will need the new PIN to log in.',
      )
    )
      return;
    setBusy('pin');
    setError(null);
    try {
      const res = await fetch(`/api/coach/clients/${clientId}/regenerate-pin`, {
        method: 'POST',
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Failed');
        return;
      }
      setNewPin(body.pin);
    } finally {
      setBusy(null);
    }
  }

  async function setActive(next: boolean) {
    if (
      !confirm(next ? 'Reactivate this client?' : 'Deactivate this client? They will be locked out until reactivated.')
    )
      return;
    setBusy('active');
    setError(null);
    try {
      const res = await fetch(`/api/coach/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active: next }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Failed');
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  async function toggleDeload() {
    setBusy('deload');
    setError(null);
    try {
      const res = await fetch(`/api/coach/clients/${clientId}/deload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deload: !currentWeekIsDeload }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Failed');
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-surface/60 p-4 mb-6">
      <h2 className="text-xs uppercase tracking-[0.18em] text-faint mb-3">Actions</h2>

      {newPin && (
        <div className="mb-3 rounded-xl border border-primary/40 bg-primary/8 p-3 text-center">
          <p className="text-xs text-primary-hi">New PIN — share once:</p>
          <p className="text-3xl font-bold tracking-[0.3em] tabular-nums my-2 text-text">{newPin}</p>
          <button
            type="button"
            onClick={() => setNewPin(null)}
            className="text-xs text-muted hover:text-text underline transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-3">
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint mb-1.5">
          Log mode
        </p>
        <div className="inline-flex rounded-lg border border-border bg-surface/40 p-0.5">
          {(['sets', 'best', 'all'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setLogMode(mode)}
              disabled={busy !== null || pending}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${
                logMode === mode
                  ? 'bg-primary/15 text-primary-hi'
                  : 'text-muted hover:text-text'
              }`}
            >
              {mode === 'sets' ? 'Per-set' : mode === 'best' ? 'Best set only' : 'All sets'}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          {logMode === 'best'
            ? 'Client logs one entry per exercise — taken as the session best.'
            : logMode === 'all'
              ? 'Client logs every prescribed set on one screen per exercise; next session shows the full set list (no Beat-X cue).'
              : 'Client logs every set individually, set-by-set.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={regenerate}
          disabled={busy !== null || pending}
          className="rounded-lg border border-border bg-surface/40 hover:bg-surface hover:border-border-strong text-text px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50"
        >
          {busy === 'pin' ? 'Generating…' : 'Regenerate PIN'}
        </button>
        <button
          type="button"
          onClick={toggleDeload}
          disabled={busy !== null || pending}
          className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            currentWeekIsDeload
              ? 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/15'
              : 'border-border bg-surface/40 text-text hover:bg-surface hover:border-border-strong'
          }`}
        >
          {busy === 'deload'
            ? '…'
            : currentWeekIsDeload
              ? 'Unmark deload'
              : 'Mark week as deload'}
        </button>
        <button
          type="button"
          onClick={() => setActive(!active)}
          disabled={busy !== null || pending}
          className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            active
              ? 'border-danger/40 bg-surface/40 text-danger hover:bg-danger/10'
              : 'border-primary/40 bg-surface/40 text-primary-hi hover:bg-primary/10'
          }`}
        >
          {busy === 'active' ? '…' : active ? 'Deactivate' : 'Reactivate'}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
