'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sunday-approve / Monday-send split:
 *   - Pre-approval: "Approve" button → POST /api/coach/weekly-notes/approve.
 *     Records the approval. Does NOT send. The Monday 06:00 UTC cron is
 *     what fires the actual pushes — and it re-pulls fresh data at
 *     send time, so any Sunday-after-approval activity flows through.
 *   - Post-approval: "Send now" button → POST /api/coach/weekly-notes/dispatch.
 *     Failure-recovery path. Useful if the Monday cron didn't run.
 *     Per-client dedup means double-clicking is safe.
 */
export function ApproveButton({
  weekStart,
  candidateCount,
  alreadyApproved,
}: {
  weekStart: string;
  candidateCount: number;
  alreadyApproved: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/coach/weekly-notes/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ week_start: weekStart }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? 'Approve failed');
        setBusy(false);
        return;
      }
      if (json.firstApproval) {
        setResult('Approved. Monday 06:00 UTC cron will dispatch.');
      } else {
        setResult('Already approved.');
      }
      setBusy(false);
      setConfirming(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
      setBusy(false);
    }
  }

  async function dispatchNow() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/coach/weekly-notes/dispatch', {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? 'Dispatch failed');
        setBusy(false);
        return;
      }
      const r = json.result;
      if (r.reason === 'sent') {
        setResult(`Sent to ${r.sent} client${r.sent === 1 ? '' : 's'} (${r.skipped} skipped).`);
      } else if (r.reason === 'all_already_sent') {
        setResult('All eligible clients already received this week.');
      } else if (r.reason === 'no_approval_row') {
        setError('No prepared row for last week. Sunday cron prepare must run first.');
      } else if (r.reason === 'awaiting_approval') {
        setError('Approval not registered — please approve first.');
      }
      setBusy(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dispatch failed');
      setBusy(false);
    }
  }

  if (alreadyApproved) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted">
          Approved. The Monday 06:00 UTC cron will dispatch with fresh data (per-client dedup ensures at-most-once-per-week). Use <strong>Send now</strong> only if the Monday cron didn&apos;t fire.
        </p>
        <button
          type="button"
          onClick={dispatchNow}
          disabled={busy || pending}
          className="px-4 py-2 rounded-lg border border-border bg-surface/40 text-text hover:bg-surface hover:border-border-strong text-xs font-semibold disabled:opacity-50 transition-colors"
        >
          {busy ? 'Sending…' : 'Send now (recovery)'}
        </button>
        {result && <p className="text-xs text-primary-hi">{result}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={candidateCount === 0 || busy || pending}
          className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-40 transition-colors"
        >
          Approve {candidateCount} client{candidateCount === 1 ? '' : 's'} for Monday send
        </button>
      )}
      {confirming && (
        <div className="rounded-2xl border border-border bg-surface/60 p-4 space-y-3">
          <p className="text-xs text-text">
            About to approve weekly notes for <strong>{candidateCount}</strong> client{candidateCount === 1 ? '' : 's'}, week of <strong>{weekStart}</strong>. Monday 06:00 UTC cron will fire the actual pushes — content is re-pulled at send time, so any Sunday training after this click is reflected.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={approve}
              disabled={busy || pending}
              className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              {busy ? 'Approving…' : 'Confirm approval'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface/40 text-text hover:bg-surface hover:border-border-strong text-xs font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {result && <p className="text-xs text-primary-hi">{result}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
