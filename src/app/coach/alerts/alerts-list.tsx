'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';

type Alert = {
  id: string;
  client_id: string;
  type:
    | 'pain'
    | 'stalled'
    | 'missed_workout'
    | 'workout_started'
    | 'workout_completed'
    | 'workout_stale'
    | 'check_in_due'
    | 'check_in_submitted'
    | 'missed_checkin';
  message: string;
  created_at: string;
  acknowledged_at: string | null;
  clients: { name: string } | null;
};

const TYPE_CHIPS: Record<Alert['type'], { label: string; className: string }> = {
  pain: { label: 'Pain', className: 'bg-danger/10 text-danger border-danger/35' },
  stalled: { label: 'Stalled', className: 'bg-warn/10 text-warn border-warn/35' },
  missed_workout: { label: 'Missed', className: 'bg-warn/10 text-warn border-warn/35' },
  workout_started: { label: 'Started', className: 'bg-accent/10 text-accent border-accent/30' },
  workout_completed: {
    label: 'Completed',
    className: 'bg-primary/15 text-primary-hi border-primary/30',
  },
  workout_stale: { label: 'Stale', className: 'bg-warn/10 text-warn border-warn/35' },
  check_in_due: { label: 'Check-in due', className: 'bg-surface-2 text-muted border-border' },
  check_in_submitted: {
    label: 'Check-in',
    className: 'bg-primary/15 text-primary-hi border-primary/30',
  },
  missed_checkin: { label: 'Missed check-in', className: 'bg-warn/10 text-warn border-warn/35' },
};

export function AlertsList({ alerts }: { alerts: Alert[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  if (alerts.length === 0) {
    return (
      <p className="border-t border-border pt-10 text-center font-display text-2xl text-muted">
        Quiet on the wire.
      </p>
    );
  }

  const unack = alerts.filter((a) => !a.acknowledged_at);

  async function ack(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/coach/alerts/${id}/ack`, { method: 'POST' });
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  async function ackVisible() {
    if (unack.length === 0) return;
    setBusy('bulk');
    try {
      await fetch('/api/coach/alerts/ack-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: unack.map((a) => a.id) }),
      });
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {unack.length > 0 && (
        <div className="flex items-center justify-end mb-3">
          <button
            type="button"
            disabled={busy !== null || pending}
            onClick={ackVisible}
            className="text-[10px] uppercase tracking-[0.18em] font-medium px-3 py-1.5 rounded-sm border border-border-strong text-muted hover:text-text hover:border-primary/50 transition-colors disabled:opacity-50"
          >
            Ack {unack.length} on this page
          </button>
        </div>
      )}
      <ul className="border-t border-border">
        {alerts.map((a) => {
          const chip = TYPE_CHIPS[a.type];
          const acked = !!a.acknowledged_at;
          return (
            <li
              key={a.id}
              className={`border-b border-border flex items-center justify-between gap-3 py-3.5 px-2 transition-colors ${
                acked
                  ? 'opacity-50'
                  : a.type === 'pain'
                    ? 'bg-danger/[0.04] border-l-2 border-l-danger'
                    : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span
                    className={`text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-0.5 rounded-sm border ${chip.className}`}
                  >
                    {chip.label}
                  </span>
                  <Link
                    href={`/coach/clients/${a.client_id}`}
                    prefetch={false}
                    className="text-xs text-text hover:text-primary-hi transition-colors"
                  >
                    {a.clients?.name ?? 'Unknown'}
                  </Link>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-faint font-mono">
                    {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-sm text-text">{a.message}</p>
              </div>
              {!acked ? (
                <button
                  type="button"
                  disabled={busy === a.id || pending}
                  onClick={() => ack(a.id)}
                  className="shrink-0 text-[10px] uppercase tracking-[0.18em] font-medium px-3 py-1.5 rounded-sm border border-border-strong text-muted hover:text-text hover:border-primary/50 hover:bg-primary/10 transition-colors disabled:opacity-50"
                >
                  Ack
                </button>
              ) : (
                <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-faint">
                  Acked
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
