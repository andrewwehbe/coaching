'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ClientActions({
  clientId,
  active,
  currentWeekIsDeload,
}: {
  clientId: string;
  active: boolean;
  currentWeekIsDeload: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [newPin, setNewPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 mb-6">
      <h2 className="text-sm uppercase tracking-wide text-neutral-500 mb-3">Actions</h2>

      {newPin && (
        <div className="mb-3 rounded-lg border border-emerald-700/50 bg-emerald-950/30 p-3 text-center">
          <p className="text-xs text-emerald-200/80">New PIN — share once:</p>
          <p className="text-3xl font-bold tracking-[0.3em] tabular-nums my-2">{newPin}</p>
          <button
            type="button"
            onClick={() => setNewPin(null)}
            className="text-xs text-neutral-300 hover:text-neutral-100 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={regenerate}
          disabled={busy !== null || pending}
          className="rounded-lg border border-neutral-700 hover:bg-neutral-800/40 px-3 py-2 text-sm disabled:opacity-50"
        >
          {busy === 'pin' ? 'Generating…' : 'Regenerate PIN'}
        </button>
        <button
          type="button"
          onClick={toggleDeload}
          disabled={busy !== null || pending}
          className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${
            currentWeekIsDeload
              ? 'border-amber-700/50 bg-amber-950/30 hover:bg-amber-950/50'
              : 'border-neutral-700 hover:bg-neutral-800/40'
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
          className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${
            active
              ? 'border-red-700/50 hover:bg-red-950/30 text-red-300'
              : 'border-emerald-700/50 hover:bg-emerald-950/30 text-emerald-300'
          }`}
        >
          {busy === 'active' ? '…' : active ? 'Deactivate' : 'Reactivate'}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
