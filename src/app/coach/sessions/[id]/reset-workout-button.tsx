'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ResetWorkoutButton({ workoutId }: { workoutId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/coach/workouts/${workoutId}/reset`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error ?? 'Reset failed');
        return;
      }
      router.push('/coach/sessions');
      router.refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2 text-sm">
        <span className="text-muted">Wipe this workout?</span>
        <button
          type="button"
          onClick={go}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-warn/15 text-warn border border-warn/40 hover:bg-warn/20 font-medium disabled:opacity-50 transition-colors"
        >
          {busy ? '…' : 'Reset'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="px-3 py-1.5 rounded-lg border border-border text-muted hover:text-text hover:border-border-strong transition-colors"
        >
          Cancel
        </button>
        {error && <span className="text-warn">{error}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="text-sm font-medium px-3 py-1.5 rounded-lg border border-border text-muted hover:text-warn hover:border-warn/40 hover:bg-warn/5 transition-colors"
    >
      Reset workout
    </button>
  );
}
