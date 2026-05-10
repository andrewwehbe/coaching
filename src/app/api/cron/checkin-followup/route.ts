/**
 * Monday check-in follow-up cron.
 *
 * Schedule: 0 4,14 * * 1 (UTC) — Mondays at 04:00 UTC and 14:00 UTC =
 * 07:00 and 17:00 Asia/Beirut (UTC+3, no DST).
 *
 * - 07:00 fire: clients with check-ins enabled who didn't check in for
 *   last week (Mon..Sun previous) get a gentle reminder push.
 * - 17:00 fire: any still-missing client gets a 'missed_checkin' alert
 *   inserted (which auto-pushes the coach via insertAlert) and a final
 *   "marked missed" push to the client.
 *
 * "Last week" is computed as [previous Monday, this Monday). The Sunday
 * 09:00 reminder is already sent by the daily-analysis cron — this
 * picks up the misses.
 *
 * Idempotency: only one missed_checkin alert per client per week is
 * inserted; subsequent fires (e.g. cron retries) no-op.
 */
import { NextResponse } from 'next/server';
import { startOfWeek, formatISO, subWeeks } from 'date-fns';

import { db } from '@/lib/supabase';
import { insertAlert } from '@/lib/notify';
import { sendPushToClient } from '@/lib/push';
import { verifyCronSecret } from '@/lib/cron-auth';

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

  const supa = db();
  const now = new Date();
  const hourUtc = now.getUTCHours();
  // 04:00 UTC = morning fire (7am Beirut), 14:00 UTC = evening fire (5pm Beirut).
  const isEvening = hourUtc >= 12;

  const thisWeekStart = startOfWeek(now, { weekStartsOn: 1 });
  const lastWeekStart = subWeeks(thisWeekStart, 1);
  const lastWeekStartIso = formatISO(lastWeekStart, { representation: 'date' });
  const thisWeekStartIso = formatISO(thisWeekStart, { representation: 'date' });

  const { data: clients } = await supa
    .from('clients')
    .select('id, name, body_weight_freq, photo_check_in_enabled')
    .eq('active', true);

  const eligible = (clients ?? []).filter(
    (c) => c.body_weight_freq !== 'none' || c.photo_check_in_enabled === true
  );
  if (eligible.length === 0) {
    return NextResponse.json({ ok: true, eligible: 0 });
  }

  const eligibleIds = eligible.map((c) => c.id);

  const [{ data: lastWeekCheckIns }, { data: existingMissedAlerts }] = await Promise.all([
    supa
      .from('check_ins')
      .select('client_id')
      .in('client_id', eligibleIds)
      .gte('date', lastWeekStartIso)
      .lt('date', thisWeekStartIso),
    supa
      .from('alerts')
      .select('client_id')
      .in('client_id', eligibleIds)
      .eq('type', 'missed_checkin')
      .gte('created_at', new Date(thisWeekStart).toISOString()),
  ]);

  const checkedIn = new Set((lastWeekCheckIns ?? []).map((r) => r.client_id));
  const alreadyMarkedMissed = new Set((existingMissedAlerts ?? []).map((r) => r.client_id));

  let reminded = 0;
  let markedMissed = 0;

  for (const c of eligible) {
    if (checkedIn.has(c.id)) continue;

    if (!isEvening) {
      // 7am fire — gentle reminder, no DB write.
      void sendPushToClient(c.id, {
        title: 'Check-in reminder',
        body: 'Quick check-in for last week — log your weight + photos when you get a sec.',
        url: '/check-in',
      }).catch(() => {});
      reminded++;
    } else {
      // 5pm fire — mark missed (idempotent) and push final notice to client.
      // insertAlert handles the coach push because 'missed_checkin' is in PUSHABLE.
      if (!alreadyMarkedMissed.has(c.id)) {
        await insertAlert({
          clientId: c.id,
          type: 'missed_checkin',
          message: `${c.name} missed their weekly check-in.`,
          data: { week_start: lastWeekStartIso },
        });
        markedMissed++;
      }
      void sendPushToClient(c.id, {
        title: 'Check-in marked missed',
        body: 'You can still log it — your coach has been notified.',
        url: '/check-in',
      }).catch(() => {});
    }
  }

  return NextResponse.json({
    ok: true,
    fire: isEvening ? 'evening' : 'morning',
    eligible: eligible.length,
    skipped_already_done: checkedIn.size,
    reminded,
    marked_missed: markedMissed,
  });
}
