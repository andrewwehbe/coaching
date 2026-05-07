'use client';

import { useState } from 'react';

export function LogoutButton({ label = 'Sign out' }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch('/api/auth/logout', { method: 'POST' });
        // Drop the SW's cached HTML so the next user on this device doesn't
        // see the previous user's pages from cache.
        navigator.serviceWorker?.controller?.postMessage({ type: 'clear-cache' });
        // Hard navigation: forces the browser to drop any cached RSC
        // state and re-request /login with no session cookie.
        window.location.href = '/login';
      }}
      className="text-sm text-muted hover:text-text transition-colors disabled:opacity-50"
    >
      {label}
    </button>
  );
}
