'use client';

import { useState } from 'react';

export function SwitchToCoachButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch('/api/client/switch-to-coach', { method: 'POST' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            alert(body.error ?? 'Switch failed');
            return;
          }
          navigator.serviceWorker?.controller?.postMessage({ type: 'clear-cache' });
          window.location.href = '/coach';
        } finally {
          setBusy(false);
        }
      }}
      className="text-sm text-muted hover:text-text transition-colors disabled:opacity-50"
      title="Switch to coach mode"
    >
      {busy ? 'Switching…' : 'Coach'}
    </button>
  );
}
