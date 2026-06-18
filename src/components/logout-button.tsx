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
        // Detach this browser's push subscription from the account *before* the
        // session is cleared, so a signed-out account stops getting pushes on a
        // shared device. The browser subscription itself is kept — the next
        // login re-attaches it without re-prompting.
        try {
          const reg = await navigator.serviceWorker?.ready;
          const sub = await reg?.pushManager.getSubscription();
          if (sub) {
            await fetch('/api/push/unsubscribe', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ endpoint: sub.endpoint }),
            }).catch(() => {});
          }
        } catch {
          /* best-effort — never block logout on this */
        }
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
