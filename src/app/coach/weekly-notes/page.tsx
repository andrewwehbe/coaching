import Link from 'next/link';
import { format } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import {
  buildWeeklyNoteSendInputs,
  selectEligibleSendCandidates,
  weekStartIsoFor,
  reviewAtFor,
} from '@/lib/weekly-note-send';
import { ApproveButton } from './approve-button';

export const dynamic = 'force-dynamic';

/**
 * Stage 6 Piece 4 — coach approval page (Sunday-approve / Monday-send).
 *
 * reviewAtFor(now) returns end-of-last-Sunday on Mon-Sat (or
 * end-of-today if today IS Sunday). That makes weekStartIsoFor(at)
 * the SAME Monday for any access day within the same Mon-Sun review
 * window — so Sunday's preview, Monday's send cron, and any
 * mid-week sanity check all key on the same approval row.
 */
export default async function WeeklyNotesPage() {
  await requireCoach();

  const now = new Date();
  const at = reviewAtFor(now);
  const weekStart = weekStartIsoFor(at);

  const supa = db();
  const [{ data: approvalRow }, { inputs }] = await Promise.all([
    supa
      .from('weekly_note_approvals')
      .select(
        'id, week_start, prepared_at, approved_at, approved_by, total_eligible, total_sent, total_skipped',
      )
      .eq('week_start', weekStart)
      .maybeSingle(),
    buildWeeklyNoteSendInputs(at),
  ]);

  const eligible = selectEligibleSendCandidates(inputs);
  const eligibleIds = new Set(eligible.map((c) => c.clientId));

  // Skipped: had a row in inputs but isn't in eligible. Capture reason.
  type SkippedRow = {
    clientId: string;
    name: string;
    reason: string;
    reasonCode: string | null;
  };
  const skipped: SkippedRow[] = inputs
    .filter((i) => !eligibleIds.has(i.row.clientId))
    .map((i) => {
      let reason: string;
      if (i.alreadySentThisWeek) reason = 'already sent this week';
      else if (i.directive?.suppressClientWeeklyMessage) {
        reason = `context: ${i.reasonCode} suppresses client messaging`;
      } else if (!i.row.suggestions.find((s) => s.type === 'weekly_note')) {
        reason = 'no weekly_note (got a structural suggestion instead)';
      } else reason = 'unknown';
      return {
        clientId: i.row.clientId,
        name: i.row.name,
        reason,
        reasonCode: i.reasonCode,
      };
    });

  const isPrepared = approvalRow != null;
  const isApproved = approvalRow?.approved_at != null;

  return (
    <main className="flex flex-1 flex-col max-w-5xl w-full mx-auto px-5 sm:px-8 py-6 space-y-8">
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-[0.28em] text-faint">Weekly client notes</p>
        <h1 className="font-display text-3xl sm:text-4xl leading-tight tracking-tight">
          Week of {weekStart}
        </h1>
        <p className="text-sm text-muted">
          Preview the per-client weekly note. Approval is per-week and explicit — clicking <strong>Approve</strong> records that this batch is cleared to send. The <strong>Monday 06:00 UTC cron</strong> fires the actual pushes (re-pulling each note fresh at send time, so any Sunday training after approval is reflected). Default state is no-send; without approval, Monday sends zero.
        </p>
        <Link href="/coach" prefetch={false} className="inline-block text-[11px] uppercase tracking-[0.18em] text-muted hover:text-text">
          ← Back to coach home
        </Link>
      </div>

      <section className="rounded-2xl border border-border bg-surface/40 p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Stat label="Prepared" value={isPrepared ? 'yes' : 'no'} tone={isPrepared ? 'good' : 'warn'} />
          <Stat label="Approved" value={isApproved ? 'yes' : 'no'} tone={isApproved ? 'good' : 'mute'} />
          <Stat label="Eligible" value={String(eligible.length)} tone="ink" />
          <Stat label="Skipped" value={String(skipped.length)} tone="mute" />
          {approvalRow?.total_sent != null && (
            <Stat label="Previously sent" value={String(approvalRow.total_sent)} tone="good" />
          )}
        </div>
        {!isPrepared && (
          <p className="text-xs text-warn">
            No prepared row for this week yet. The Sunday 06:00 UTC cron creates it; until then the approve action will fail-closed.
          </p>
        )}
        {isApproved && approvalRow?.approved_at && (
          <p className="text-xs text-muted">
            Approved at {format(new Date(approvalRow.approved_at), 'PPp')}.
          </p>
        )}
        <ApproveButton
          weekStart={weekStart}
          candidateCount={eligible.length}
          alreadyApproved={isApproved}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Eligible — will receive a push ({eligible.length})</h2>
        {eligible.length === 0 && (
          <p className="text-xs text-muted">
            No eligible clients this week. Either every active client got a structural suggestion (no weekly note), or context excluded them all.
          </p>
        )}
        <ul className="space-y-3">
          {eligible.map((c) => (
            <li key={c.clientId} className="rounded-xl border border-border bg-surface/40 p-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium text-text">{c.clientName}</p>
                {c.reasonCode && (
                  <span className="text-[10px] uppercase tracking-[0.18em] text-faint">
                    {c.reasonCode}
                    {c.contextSource === 'synthesized_onboarding' ? ' · synth' : c.contextSource === 'persisted' ? ' · persisted' : ''}
                  </span>
                )}
              </div>
              <p className="text-sm font-medium text-text">{c.title}</p>
              <p className="text-sm text-muted whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Skipped ({skipped.length})</h2>
        {skipped.length === 0 && <p className="text-xs text-muted">None.</p>}
        <ul className="space-y-2">
          {skipped.map((s) => (
            <li key={s.clientId} className="flex items-center justify-between rounded-lg border border-border bg-surface/30 px-4 py-2.5 text-sm">
              <span className="text-text">{s.name}</span>
              <span className="text-xs text-muted">
                {s.reasonCode ? `[${s.reasonCode}] ` : ''}
                {s.reason}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'mute' | 'ink';
}) {
  const valueClass =
    tone === 'good'
      ? 'text-primary-hi'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'mute'
          ? 'text-faint'
          : 'text-text';
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-faint">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${valueClass}`}>{value}</span>
    </span>
  );
}
