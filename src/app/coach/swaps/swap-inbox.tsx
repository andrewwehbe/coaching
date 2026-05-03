'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Proposal = {
  id: string;
  client_id: string;
  client_name: string;
  exercise_id: string;
  exercise_name: string;
  exercise_name_key: string;
  day_id: string;
  day_label: string;
  reason: string | null;
  proposed_at: string;
  alternatives: { id: string; name: string }[];
};

export function SwapInbox({ proposals }: { proposals: Proposal[] }) {
  return (
    <ul className="space-y-3">
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
    </ul>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const [picking, setPicking] = useState(false);
  const [replacement, setReplacement] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function approve() {
    if (!replacement) {
      setError('Pick a replacement exercise from this day.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/coach/swaps/${proposal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replacement_exercise_id: replacement }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to approve.');
      setBusy(false);
      return;
    }
    router.refresh();
  }

  async function reject() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/coach/swaps/${proposal.id}/reject`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to reject.');
      setBusy(false);
      return;
    }
    router.refresh();
  }

  return (
    <li className="rounded-2xl border border-border bg-surface/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.18em] text-faint">
            {proposal.client_name} · {proposal.day_label}
          </p>
          <p className="font-medium mt-1 text-text">{proposal.exercise_name}</p>
          {proposal.reason && (
            <p className="text-xs text-muted mt-1">{proposal.reason}</p>
          )}
        </div>
        <p className="text-[10px] text-faint whitespace-nowrap shrink-0">
          {new Date(proposal.proposed_at).toLocaleDateString()}
        </p>
      </div>

      {picking && (
        <div className="mt-4 space-y-2">
          <label className="block text-xs text-muted">
            Replace with (from this day)
          </label>
          {proposal.alternatives.length === 0 ? (
            <p className="text-xs text-warn">
              No other exercises in this day. Add one from the client&apos;s
              program editor first.
            </p>
          ) : (
            <select
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg/70 border border-border text-text text-sm focus:outline-none focus:border-border-strong"
            >
              <option value="">Select replacement…</option>
              {proposal.alternatives.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {error && <p className="text-xs text-danger mt-2">{error}</p>}

      <div className="flex gap-2 mt-4">
        {!picking ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPicking(true)}
              className="flex-1 px-3 py-2 rounded-lg bg-primary hover:bg-primary-hi text-bg disabled:opacity-50 text-sm font-semibold transition-colors"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={reject}
              className="px-3 py-2 rounded-lg border border-border bg-surface/40 text-text hover:bg-surface hover:border-border-strong disabled:opacity-50 text-sm font-medium transition-colors"
            >
              Reject
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy || !replacement}
              onClick={approve}
              className="flex-1 px-3 py-2 rounded-lg bg-primary hover:bg-primary-hi text-bg disabled:opacity-50 text-sm font-semibold transition-colors"
            >
              {busy ? 'Saving…' : 'Confirm swap'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPicking(false);
                setReplacement('');
                setError(null);
              }}
              className="px-3 py-2 rounded-lg border border-border bg-surface/40 text-text hover:bg-surface hover:border-border-strong disabled:opacity-50 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </li>
  );
}
