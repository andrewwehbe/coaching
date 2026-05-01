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
        // Hard navigation: forces the browser to drop any cached RSC
        // state and re-request /login with no session cookie.
        window.location.href = '/login';
      }}
      className="text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
    >
      {label}
    </button>
  );
}
