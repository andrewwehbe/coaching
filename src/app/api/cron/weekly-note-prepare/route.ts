/**
 * Stage 6 Piece 4 — weekly-note PREPARE cron.
 *
 * Schedule: 0 6 * * 0 (UTC) — Sunday 06:00 UTC = ~09:00 Beirut DST
 * (08:00 standard, drifts with DST).
 *
 * Sunday-approve / Monday-send split:
 *   - Sunday morning this cron creates an unapproved approval row
 *     so the coach has a preview ready for the weekly review.
 *   - Sunday: coach approves the batch via the UI.
 *   - Monday morning the SEND cron (/api/cron/weekly-note-send)
 *     re-reads the approval, RE-PULLS the weekly report fresh
 *     (does NOT use any frozen snapshot), and pushes to clients.
 *
 * Approval records THAT the week is approved; content is re-derived
 * at send time so a Sunday-afternoon log lands in Monday's message.
 *
 * This cron is the PREPARE step ONLY. It inserts a single
 * weekly_note_approvals row for the current week with approved_at
 * NULL. THAT'S IT. No push to any client. No alerts written. The
 * coach UI is the only place that flips approved_at.
 *
 * Idempotent: weekly_note_approvals.week_start is UNIQUE, so a
 * second prepare call in the same week 409s at the DB; we treat the
 * 23505 as success ("already prepared").
 *
 * SAFETY: this route does NOT send pushes. It does NOT call the
 * dispatch helper. If you ever read this file and see a push call
 * anywhere, REVERT — the cron must NEVER send.
 */
import { NextResponse } from 'next/server';

import { db } from '@/lib/supabase';
import { verifyCronSecret } from '@/lib/cron-auth';
import { weekStartIsoFor } from '@/lib/weekly-note-send';
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
  const weekStart = weekStartIsoFor(now);
  const supa = db();

  // Idempotent insert: the UNIQUE on week_start guarantees one row
  // per week even if cron retries. We don't UPSERT — re-running this
  // should NEVER touch a row that may already have approved_at set.
  const { data, error } = await supa
    .from('weekly_note_approvals')
    .insert({ week_start: weekStart })
    .select('id')
    .maybeSingle();

  if (error) {
    // Postgres 23505 = unique_violation. That's the happy "already
    // prepared" path; we return ok=true with status='already_prepared'.
    if (error.code === '23505') {
      return NextResponse.json({
        ok: true,
        weekStart,
        status: 'already_prepared',
      });
    }
    log.error('cron.weekly-note-prepare.failed', error, { weekStart });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    weekStart,
    status: 'prepared',
    approvalId: data?.id ?? null,
  });
}
