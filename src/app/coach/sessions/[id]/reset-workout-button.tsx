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
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="text-faint">Wipe this workout?</span>
        <button
          type="button"
          onClick={go}
          disabled={busy}
          className="px-2 py-0.5 rounded-md bg-warn/15 text-warn border border-warn/30 disabled:opacity-50"
        >
          {busy ? '…' : 'Reset'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-faint hover:text-text px-1"
        >
          ✕
        </button>
        {error && <span className="text-warn">{error}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="text-xs text-faint hover:text-warn transition-colors"
    >
      Reset workout
    </button>
  );
}
