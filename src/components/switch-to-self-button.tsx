'use client';

import { useState } from 'react';

import { toast } from '@/components/ui';

export function SwitchToSelfButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch('/api/coach/switch-to-self', { method: 'POST' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            toast(body.error ?? "Couldn't switch accounts — try again.", 'danger');
            return;
          }
          // Drop SW-cached coach pages so the next nav fetches client-side
          // pages fresh. The session cookie has already flipped server-side.
          navigator.serviceWorker?.controller?.postMessage({ type: 'clear-cache' });
          window.location.href = '/today';
        } finally {
          setBusy(false);
        }
      }}
      className="text-sm text-muted hover:text-text transition-colors disabled:opacity-50"
      title="Switch to your client account"
    >
      {busy ? 'Switching…' : 'My account'}
    </button>
  );
}
