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
  pain: { label: 'Pain', className: 'bg-red-900/60 text-red-200 border-red-700/40' },
  stalled: { label: 'Stalled', className: 'bg-amber-900/60 text-amber-200 border-amber-700/40' },
  missed_workout: {
    label: 'Missed',
    className: 'bg-amber-900/60 text-amber-200 border-amber-700/40',
  },
  workout_started: {
    label: 'Started',
    className: 'bg-blue-900/60 text-blue-200 border-blue-700/40',
  },
  workout_completed: {
    label: 'Completed',
    className: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/40',
  },
  check_in_due: {
    label: 'Check-in due',
    className: 'bg-neutral-800 text-neutral-300 border-neutral-700',
  },
  check_in_submitted: {
    label: 'Check-in',
    className: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/40',
  },
};

export function AlertsList({ alerts }: { alerts: Alert[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  if (alerts.length === 0) {
    return (
      <p className="rounded-xl border border-neutral-800 bg-neutral-900/30 px-4 py-3 text-sm text-neutral-400">
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
        <div className="flex items-center justify-end mb-2">
          <button
            type="button"
            disabled={busy !== null || pending}
            onClick={ackVisible}
            className="text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
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
              className={`rounded-xl px-4 py-2.5 border flex items-center justify-between gap-3 ${
                acked
                  ? 'border-neutral-800 bg-neutral-900/20 opacity-60'
                  : a.type === 'pain'
                    ? 'border-red-700/50 bg-red-950/30'
                    : 'border-neutral-800 bg-neutral-900/40'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${chip.className}`}
                  >
                    {chip.label}
                  </span>
                  <Link
                    href={`/coach/clients/${a.client_id}`}
                    className="text-xs text-neutral-300 hover:text-neutral-100"
                  >
                    {a.clients?.name ?? 'Unknown'}
                  </Link>
                  <span className="text-xs text-neutral-500">
                    · {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-sm">{a.message}</p>
              </div>
              {!acked ? (
                <button
                  type="button"
                  disabled={busy === a.id || pending}
                  onClick={() => ack(a.id)}
                  className="text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50 shrink-0"
                >
                  Ack
                </button>
              ) : (
                <span className="text-xs text-neutral-600 shrink-0">acked</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
