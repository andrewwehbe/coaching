import 'server-only';

import { db } from './supabase';
import { sendPushToClient } from './push';
import { buildWeeklyReport } from './weekly-report';
import { fetchActiveContextsForClients } from './client-context-store';
import {
  getActiveClientContext,
  getContextDirective,
} from './signals/client-context';
import {
  selectEligibleSendCandidates,
  weekStartIsoFor,
  reviewAtFor,
  type WeeklyNoteSendCandidate,
  type WeeklyNoteSendInputRow,
} from './signals/weekly-note-send';

// Re-export the pure types/helpers so existing imports against
// '@/lib/weekly-note-send' keep working — single import surface.
export {
  selectEligibleSendCandidates,
  weekStartIsoFor,
  reviewAtFor,
  type WeeklyNoteSendCandidate,
  type WeeklyNoteSendInputRow,
};

/**
 * Stage 6 Piece 4 — approval-gated weekly client-note send.
 *
 * SAFETY MODEL: two independent gates, both fail-closed.
 *
 *   Gate 1 (route layer):
 *     POST /api/coach/weekly-notes/approve flips
 *     weekly_note_approvals.approved_at from NULL → NOW() inside an
 *     atomic UPDATE WHERE approved_at IS NULL. If the row doesn't
 *     exist (cron prepare didn't run) OR the row is already approved,
 *     the UPDATE affects 0 rows and the route refuses to dispatch.
 *
 *   Gate 2 (this module):
 *     dispatchApprovedWeeklyNotes re-reads weekly_note_approvals and
 *     refuses to send when no row exists OR approved_at IS NULL. This
 *     is the bulletproof part — even if a future caller dispatches
 *     out-of-band, no row in the DB → no send. Default state is
 *     no-send. Absence of evidence = absence of authorization.
 *
 * Per-client per-week dedup:
 *   Each successful send writes one alerts row of type
 *   'weekly_note_sent' with data.week_start = the ISO week start.
 *   Re-dispatching the same week reads existing weekly_note_sent rows
 *   and skips those client_ids. A client can therefore receive the
 *   weekly note AT MOST ONCE per week, no matter how many times
 *   approve is re-clicked or dispatch is re-triggered.
 *
 * Context filtering:
 *   ContextDirective.suppressClientWeeklyMessage is the single source
 *   for "is this client paused/away from coaching this week." This
 *   module reads ONLY that flag — it never re-decides per-code.
 *   Onboarding/health/at_risk clients receive their tier-0 framed note
 *   (the weeklyNoteTemplate decision already happened inside
 *   buildWeeklyReport via the directive).
 */

/**
 * DB-bound: assemble inputs for selectEligibleSendCandidates. Used by
 * both the coach preview UI and the dispatch path so they always see
 * the same candidate list (construction-consistency).
 */
export async function buildWeeklyNoteSendInputs(
  at: Date,
): Promise<{
  weekStart: string;
  inputs: WeeklyNoteSendInputRow[];
}> {
  const weekStart = weekStartIsoFor(at);
  const report = await buildWeeklyReport(at);
  const clientIds = report.rows.map((r) => r.clientId);

  if (clientIds.length === 0) {
    return { weekStart, inputs: [] };
  }

  const supa = db();
  const [
    { data: clientMetaRows },
    { data: anyLogRows },
    persistedContextByClient,
    { data: sentRows },
  ] = await Promise.all([
    supa.from('clients').select('id, created_at').in('id', clientIds),
    supa
      .from('workouts')
      .select('client_id')
      .in('client_id', clientIds)
      .not('completed_at', 'is', null),
    fetchActiveContextsForClients(clientIds),
    supa
      .from('alerts')
      .select('client_id, data')
      .in('client_id', clientIds)
      .eq('type', 'weekly_note_sent'),
  ]);

  const createdAtByClient = new Map<string, Date>();
  for (const c of clientMetaRows ?? []) {
    if (c.created_at) {
      createdAtByClient.set(c.id as string, new Date(c.created_at as string));
    }
  }
  const clientsWithAnyLog = new Set<string>(
    (anyLogRows ?? []).map((r) => r.client_id as string),
  );
  const alreadySentClients = new Set<string>();
  for (const r of sentRows ?? []) {
    const data = (r.data ?? {}) as { week_start?: string };
    if (data.week_start === weekStart) {
      alreadySentClients.add(r.client_id as string);
    }
  }

  const inputs: WeeklyNoteSendInputRow[] = report.rows.map((row) => {
    const createdAt = createdAtByClient.get(row.clientId);
    const activeContext = createdAt
      ? getActiveClientContext({
          at,
          persistedRow: persistedContextByClient.get(row.clientId) ?? null,
          clientCreatedAt: createdAt,
          hasNoLogs: !clientsWithAnyLog.has(row.clientId),
        })
      : null;
    const directive = activeContext
      ? getContextDirective(activeContext.reasonCode)
      : null;
    return {
      row,
      directive,
      reasonCode: activeContext?.reasonCode ?? null,
      contextSource: activeContext?.source ?? null,
      alreadySentThisWeek: alreadySentClients.has(row.clientId),
    };
  });

  return { weekStart, inputs };
}

export type DispatchResult = {
  weekStart: string;
  reason:
    | 'no_approval_row'
    | 'awaiting_approval'
    | 'sent'
    | 'all_already_sent';
  sent: number;
  skipped: number;
  candidates: number;
};

/**
 * The bulletproof send. Re-reads weekly_note_approvals as the second
 * gate — even if a caller bypasses the route's atomic UPDATE, this
 * function will refuse to send unless approved_at IS NOT NULL.
 *
 * Order of operations per candidate:
 *   1. Compose payload.
 *   2. INSERT alerts row (type=weekly_note_sent) with the week_start
 *      in data. The insert happens BEFORE the push so that if the
 *      push succeeds but we crash before recording, we don't
 *      double-send on retry. If the insert fails, we don't push.
 *   3. await sendPushToClient.
 *
 * This is "record then push" — the safer direction. A spurious record
 * with no push is harmless (next week's send is unaffected); a push
 * with no record could be re-sent on retry.
 */
export async function dispatchApprovedWeeklyNotes(args: {
  at: Date;
}): Promise<DispatchResult> {
  const weekStart = weekStartIsoFor(args.at);
  const supa = db();

  // GATE 2 — bulletproof. Even if the route layer is buggy, this
  // refuses to send unless the DB says approved.
  const { data: approvalRow, error: approvalErr } = await supa
    .from('weekly_note_approvals')
    .select('id, approved_at')
    .eq('week_start', weekStart)
    .maybeSingle();
  if (approvalErr) {
    throw new Error(`fetch approval: ${approvalErr.message}`);
  }
  if (!approvalRow) {
    return {
      weekStart,
      reason: 'no_approval_row',
      sent: 0,
      skipped: 0,
      candidates: 0,
    };
  }
  if (!approvalRow.approved_at) {
    return {
      weekStart,
      reason: 'awaiting_approval',
      sent: 0,
      skipped: 0,
      candidates: 0,
    };
  }

  const { inputs } = await buildWeeklyNoteSendInputs(args.at);
  const candidates = selectEligibleSendCandidates(inputs);
  const skipped = inputs.length - candidates.length;

  if (candidates.length === 0) {
    await supa
      .from('weekly_note_approvals')
      .update({
        total_eligible: inputs.length,
        total_sent: 0,
        total_skipped: skipped,
      })
      .eq('id', approvalRow.id);
    return {
      weekStart,
      reason: 'all_already_sent',
      sent: 0,
      skipped,
      candidates: 0,
    };
  }

  let sent = 0;
  for (const candidate of candidates) {
    // Record first (the dedup row). If this fails we DON'T push —
    // record-then-push is the safer direction.
    const { error: insertErr } = await supa.from('alerts').insert({
      client_id: candidate.clientId,
      type: 'weekly_note_sent',
      message: `Weekly note sent to ${candidate.clientName}.`,
      data: {
        week_start: weekStart,
        title: candidate.title,
        reason_code: candidate.reasonCode,
        context_source: candidate.contextSource,
      },
    });
    if (insertErr) {
      // Skip the push. The next dispatch attempt will retry this
      // client because alreadySentThisWeek === false for them.
      continue;
    }
    const bodyTrimmed =
      candidate.body.length > 200
        ? candidate.body.slice(0, 197) + '...'
        : candidate.body;
    try {
      await sendPushToClient(candidate.clientId, {
        title: candidate.title,
        body: bodyTrimmed,
        url: '/today',
      });
      sent += 1;
    } catch {
      // Push failures don't roll back the dedup row — Web Push has
      // its own delivery semantics, the alert+audit trail is what
      // matters for the "did we attempt to send" question.
      sent += 1;
    }
  }

  await supa
    .from('weekly_note_approvals')
    .update({
      total_eligible: inputs.length,
      total_sent: sent,
      total_skipped: skipped,
    })
    .eq('id', approvalRow.id);

  return {
    weekStart,
    reason: 'sent',
    sent,
    skipped,
    candidates: candidates.length,
  };
}
