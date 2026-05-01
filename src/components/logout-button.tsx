'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LogoutButton({ label = 'Sign out' }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch('/api/auth/logout', { method: 'POST' });
        router.replace('/login');
        router.refresh();
      }}
      className="text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
    >
      {label}
    </button>
  );
}
