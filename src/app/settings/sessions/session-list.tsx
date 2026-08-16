'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';

import { Button, Sheet } from '@/components/ui';

type Session = {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  lastUsedIp: string | null;
  lastUsedUa: string | null;
  isCurrent: boolean;
};

function shortDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  // Cheap heuristic — the only goal is to let the user recognize their
  // own browser/phone, not to do real UA parsing.
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone / iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return ua.slice(0, 40);
}

export function SessionList({ sessions }: { sessions: Session[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Revoking the CURRENT session signs the user out — that one gets a
  // confirmation sheet; other devices revoke directly.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  async function revoke(id: string, isCurrent: boolean) {
    if (isCurrent && confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/auth/sessions/${id}/revoke`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Failed to revoke');
        return;
      }
      if (isCurrent) {
        router.push('/login');
        return;
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  if (sessions.length === 0) {
    return (
      <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
        No active sessions. (That shouldn&rsquo;t happen — try logging in again.)
      </p>
    );
  }

  return (
    <>
      {error && (
        <p className="mb-3 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <ul className="rounded-2xl border border-border bg-surface/40 divide-y divide-border">
        {sessions.map((s) => (
          <li key={s.id} className="px-4 py-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium truncate">
                {shortDevice(s.lastUsedUa)}
                {s.isCurrent && (
                  <span className="ml-2 text-[10px] uppercase tracking-[0.18em] text-primary-hi">
                    this device
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={() => revoke(s.id, s.isCurrent)}
                disabled={busyId === s.id}
                className="text-xs text-muted hover:text-danger transition-colors disabled:opacity-40"
              >
                {busyId === s.id ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
            <p className="text-[11px] text-faint tabular-nums">
              {s.lastUsedIp ?? 'no ip'} ·{' '}
              <span title={format(new Date(s.lastUsedAt), 'PPpp')}>
                {formatDistanceToNow(new Date(s.lastUsedAt), { addSuffix: true })}
              </span>{' '}
              · created {format(new Date(s.createdAt), 'MMM d, yyyy')}
            </p>
          </li>
        ))}
      </ul>

      {confirmId && (
        <Sheet
          title="Sign out this device?"
          subtitle="This is your current session — revoking it signs you out here and sends you back to the PIN screen."
          onClose={() => setConfirmId(null)}
        >
          <div className="space-y-2">
            <Button
              variant="danger"
              className="w-full"
              onClick={() => revoke(confirmId, true)}
            >
              Revoke &amp; sign out
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setConfirmId(null)}>
              Keep session
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}
