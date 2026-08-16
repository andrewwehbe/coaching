'use client';

import { useState } from 'react';

import { toast } from '@/components/ui';

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
            toast(body.error ?? "Couldn't switch accounts — try again.", 'danger');
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
      {busy ? 'Switchingâ€¦' : 'Coach'}
    </button>
  );
}

