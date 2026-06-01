import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { audit } from '@/lib/audit';
import {
  dispatchApprovedWeeklyNotes,
  reviewAtFor,
} from '@/lib/weekly-note-send';

/**
 * Stage 6 Piece 4 — manual send trigger (failure recovery).
 *
 * Sunday-approve / Monday-send split: the Monday 06:00 UTC cron
 * normally fires dispatch automatically. THIS endpoint lets the
 * coach trigger dispatch manually — useful if the Monday cron
 * failed (network, deploy in flight, etc.) or if the coach wants
 * to send earlier than 06:00 UTC.
 *
 * Identical semantics to the Monday cron: passes the clean-window
 * `at` so dispatch reads the PRIOR week's approval and uses fresh
 * data. dispatchApprovedWeeklyNotes is fail-closed (refuses without
 * approved_at) and per-client deduped (weekly_note_sent alert
 * check), so a click here is safe whether or not the cron already
 * ran.
 */
export async function POST() {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  const now = new Date();
  const at = reviewAtFor(now);

  const result = await dispatchApprovedWeeklyNotes({ at });

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'dispatch_weekly_notes_manual',
    targetType: 'weekly_note_approval',
    targetId: null,
    details: {
      week_start: result.weekStart,
      reason: result.reason,
      sent: result.sent,
      skipped: result.skipped,
      candidates: result.candidates,
    },
  });

  return NextResponse.json({ ok: true, result });
}
