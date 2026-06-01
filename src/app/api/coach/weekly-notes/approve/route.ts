import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { audit } from '@/lib/audit';
import { db } from '@/lib/supabase';
import { weekStartIsoFor } from '@/lib/weekly-note-send';

/**
 * Stage 6 Piece 4 — coach approves this week's batch.
 *
 * Sunday-approve / Monday-send split: this route ONLY records the
 * approval. It does NOT push to clients and does NOT call
 * dispatchApprovedWeeklyNotes. The Monday 06:00 UTC send cron
 * (/api/cron/weekly-note-send) is the only thing that calls
 * dispatch — and it re-pulls the weekly report fresh at that
 * moment, so a Sunday-after-approval log lands in Monday's message.
 *
 * Approval is the gate. Content is not frozen here.
 *
 * Body: { week_start?: string }
 *   Optional. Defaults to weekStartIsoFor(now) — the current calendar
 *   week's Monday anchor. The week_start identifies WHICH week's
 *   approval row to flip; the Monday cron looks up the same week_start
 *   when it fires.
 *
 * Order of operations:
 *   1. Atomic UPDATE: SET approved_by, approved_at = NOW()
 *      WHERE week_start = $1 AND approved_at IS NULL.
 *      0 rows affected → either not prepared (cron hasn't run) OR
 *      already approved. Both cases are surfaced via firstApproval=
 *      false / approvedAt in the response.
 *   2. If we just flipped approved_at: audit_log the approval.
 *   3. Return.
 *
 * For failure recovery (Monday cron failed), the coach can hit
 * /api/coach/weekly-notes/dispatch to trigger dispatch manually.
 */

const Body = z.object({
  week_start: z.string().optional(),
});

export async function POST(req: Request) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const now = new Date();
  const weekStart = parsed.data.week_start ?? weekStartIsoFor(now);
  const supa = db();

  // Atomic flip: only the FIRST approval transitions approved_at;
  // subsequent calls leave the timestamp + approver untouched.
  const { data: flipped, error: flipErr } = await supa
    .from('weekly_note_approvals')
    .update({
      approved_by: guard.user.id,
      approved_at: now.toISOString(),
    })
    .eq('week_start', weekStart)
    .is('approved_at', null)
    .select('id, approved_at')
    .maybeSingle();
  if (flipErr) {
    return NextResponse.json({ error: flipErr.message }, { status: 500 });
  }

  let firstApproval = false;
  if (flipped) {
    firstApproval = true;
    await audit({
      actorType: 'coach',
      actorId: guard.user.id,
      action: 'approve_weekly_notes',
      targetType: 'weekly_note_approval',
      targetId: flipped.id,
      details: { week_start: weekStart },
    });
  }

  return NextResponse.json({
    ok: true,
    weekStart,
    firstApproval,
    note: 'Approval recorded. Monday 06:00 UTC send cron will dispatch.',
  });
}
