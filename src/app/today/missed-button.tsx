'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MissedButton({ dayId, label }: { dayId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const res = await fetch('/api/client/workout/miss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dayId }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <button
          type="button"
          onClick={go}
          disabled={busy}
          className="px-2 py-0.5 rounded-md bg-warn/15 text-warn border border-warn/30 disabled:opacity-50"
        >
          {busy ? '…' : 'Confirm'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-faint hover:text-text px-1"
        >
          ✕
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      title={`Mark ${label} as missed`}
      className="text-xs text-faint hover:text-warn transition-colors px-1"
    >
      Missed?
    </button>
  );
}
