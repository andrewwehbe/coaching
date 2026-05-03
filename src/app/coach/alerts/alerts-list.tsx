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
    | 'check_in_due'
    | 'check_in_submitted';
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
  check_in_due: { label: 'Check-in due', className: 'bg-surface-2 text-muted border-border' },
  check_in_submitted: {
    label: 'Check-in',
    className: 'bg-primary/15 text-primary-hi border-primary/30',
  },
};

export function AlertsList({ alerts }: { alerts: Alert[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  if (alerts.length === 0) {
    return (
      <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
        No alerts.
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
            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-muted hover:text-text hover:border-border-strong hover:bg-surface/60 transition-colors disabled:opacity-50"
          >
            Ack {unack.length} on this page
          </button>
        </div>
      )}
      <ul className="space-y-2">
        {alerts.map((a) => {
          const chip = TYPE_CHIPS[a.type];
          const acked = !!a.acknowledged_at;
          return (
            <li
              key={a.id}
              className={`rounded-2xl px-4 py-3 border flex items-center justify-between gap-3 transition-colors ${
                acked
                  ? 'border-border bg-surface/30 opacity-55'
                  : a.type === 'pain'
                    ? 'border-danger/40 bg-danger/8'
                    : 'border-border bg-surface/60'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span
                    className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded-full border ${chip.className}`}
                  >
                    {chip.label}
                  </span>
                  <Link
                    href={`/coach/clients/${a.client_id}`}
                    className="text-xs text-text hover:text-primary-hi transition-colors"
                  >
                    {a.clients?.name ?? 'Unknown'}
                  </Link>
                  <span className="text-xs text-faint">
                    · {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-sm text-text">{a.message}</p>
              </div>
              {!acked ? (
                <button
                  type="button"
                  disabled={busy === a.id || pending}
                  onClick={() => ack(a.id)}
                  className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-muted hover:text-text hover:border-primary/40 hover:bg-primary/10 transition-colors disabled:opacity-50"
                >
                  Ack
                </button>
              ) : (
                <span className="shrink-0 text-xs text-faint">acked</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
