/**
 * Stage 6 Piece 4 — weekly-note SEND cron.
 *
 * Schedule: 0 6 * * 1 (UTC) — Monday 06:00 UTC = ~09:00 Beirut DST
 * (08:00 standard, drifts with DST).
 *
 * Sunday-approve / Monday-send split: this cron fires the approved
 * batch on Monday morning. It re-pulls the weekly report FRESH at
 * send time — approval is just the gate, not a content snapshot.
 * So if a client trained Sunday after the coach approved, Monday's
 * push reflects current data.
 *
 * The clean-window `at`:
 *   We pass dispatch `at = last completed Sunday 23:59:59` so the
 *   internal weekStartIsoFor(at) returns the PRIOR week's Monday
 *   (the week we approved), not THIS Monday's date. The weekly-report
 *   data window inside buildWeeklyReport(at) then covers the just-
 *   completed week, which is what we want the message to be about.
 *
 * Fail-closed: dispatchApprovedWeeklyNotes refuses to send unless the
 * weekly_note_approvals row for that week_start has approved_at IS
 * NOT NULL. No approval Sunday → 0 sends Monday.
 *
 * Per-client dedup: each weekly_note_sent alert insert is gated on
 * the existing-rows check inside buildWeeklyNoteSendInputs. If the
 * cron retries or a manual /dispatch call follows, clients already
 * marked sent stay marked sent.
 */
import { NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import {
  dispatchApprovedWeeklyNotes,
  reviewAtFor,
} from '@/lib/weekly-note-send';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<NextResponse> {
  const unauth = verifyCronSecret(req);
  if (unauth) return unauth;

  const now = new Date();
  // reviewAtFor lands on end-of-last-Sunday on Mon-Sat (and end-of-
  // today on Sunday); on Monday cron-time that's last week's Sunday
  // 23:59:59.999, which makes weekStartIsoFor(at) return the prior
  // Monday — the approval row the Sunday prepare cron created and
  // the coach approved.
  const at = reviewAtFor(now);

  try {
    const result = await dispatchApprovedWeeklyNotes({ at });
    log.info('cron.weekly-note-send.complete', {
      weekStart: result.weekStart,
      reason: result.reason,
      sent: result.sent,
      skipped: result.skipped,
      candidates: result.candidates,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error('cron.weekly-note-send.failed', err, {});
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
