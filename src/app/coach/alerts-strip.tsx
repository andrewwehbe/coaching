'use client';

import { useState, useTransition } from 'react';
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
    | 'check_in_submitted'
    | 'missed_checkin';
  message: string;
  created_at: string;
  clients?: { name: string } | null;
};

const TYPE_CHIPS: Record<Alert['type'], { label: string; className: string }> = {
  pain: { label: 'Pain', className: 'bg-danger/10 text-danger border-danger/35' },
  stalled: { label: 'Stalled', className: 'bg-warn/10 text-warn border-warn/35' },
  missed_workout: {
    label: 'Missed',
    className: 'bg-warn/10 text-warn border-warn/35',
  },
  workout_started: {
    label: 'Started',
    className: 'bg-accent/10 text-accent border-accent/30',
  },
  workout_completed: {
    label: 'Completed',
    className: 'bg-primary/15 text-primary-hi border-primary/30',
  },
  check_in_due: {
    label: 'Check-in due',
    className: 'bg-surface-2 text-muted border-border',
  },
  check_in_submitted: {
    label: 'Check-in',
    className: 'bg-primary/15 text-primary-hi border-primary/30',
  },
  missed_checkin: {
    label: 'Missed check-in',
    className: 'bg-warn/10 text-warn border-warn/35',
  },
};

export function AlertsStrip({ alerts }: { alerts: Alert[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  if (alerts.length === 0) {
    return (
      <section className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
        No active alerts.
      </section>
    );
  }

  async function ack(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/coach/alerts/${id}/ack`, { method: 'POST' });
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  async function ackAll() {
    setBusy('all');
    try {
      await fetch('/api/coach/alerts/ack-all', { method: 'POST' });
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  const visible = alerts.slice(0, 8);
  const more = alerts.length - visible.length;

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs uppercase tracking-[0.18em] text-faint">
          Alerts ({alerts.length})
        </h2>
        <button
          type="button"
          disabled={busy === 'all' || pending}
          onClick={ackAll}
          className="text-xs font-medium px-2.5 py-1 rounded-lg border border-border text-muted hover:text-text hover:border-border-strong hover:bg-surface/60 transition-colors disabled:opacity-50"
        >
          Ack all
        </button>
      </div>
      <ul className="space-y-2">
        {visible.map((a) => {
          const chip = TYPE_CHIPS[a.type];
          return (
            <li
              key={a.id}
              className={`rounded-2xl px-4 py-2.5 border flex items-center justify-between gap-3 transition-colors ${
                a.type === 'pain'
                  ? 'border-danger/40 bg-danger/8'
                  : 'border-border bg-surface/60'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border font-medium ${chip.className}`}
                  >
                    {chip.label}
                  </span>
                  <span className="text-xs text-faint">
                    {a.clients?.name ?? ''} ·{' '}
                    {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-sm truncate text-text">{a.message}</p>
              </div>
              <button
                type="button"
                disabled={busy === a.id || pending}
                onClick={() => ack(a.id)}
                className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-muted hover:text-text hover:border-primary/40 hover:bg-primary/10 transition-colors disabled:opacity-50"
              >
                Ack
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <p className="mt-2 text-xs text-faint">
          +{more} more · <a href="/coach/alerts" className="underline hover:text-text transition-colors">view all</a>
        </p>
      )}
    </section>
  );
}
