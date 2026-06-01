import 'server-only';

import { db } from './supabase';
import { sendPushToCoach } from './push';
import type { AlertType } from './alert-types';

// Re-export so existing callers `import { AlertType } from '@/lib/notify'`
// keep working. The single source lives in alert-types.ts (pure module
// importable from client components too).
export type { AlertType };

// Coach-facing alerts that should auto-push the coach when written via
// insertAlert. Non-pushable: check_in_due (client-bound, sent by cron
// not coach-facing) and weekly_note_sent (per-client dedup row, no
// coach action implied). The Stage 6 anomaly types (adherence_drop,
// returned_after_gap, performance_cliff, went_quiet) ARE in here for
// defense — the daily-analysis cron currently bypasses insertAlert and
// sends its own push, but if a future caller routes through here it
// should push.
const PUSHABLE: ReadonlySet<AlertType> = new Set<AlertType>([
  'pain',
  'stalled',
  'missed_workout',
  'workout_started',
  'workout_completed',
  'workout_stale',
  'check_in_submitted',
  'missed_checkin',
  'deload',
  'effort_gap',
  'adherence_drop',
  'returned_after_gap',
  'performance_cliff',
  'went_quiet',
]);

function titleFor(type: AlertType): string {
  switch (type) {
    case 'pain': return '⚠️ Pain reported';
    case 'workout_started': return '🏋️ Started';
    case 'workout_completed': return '✅ Finished';
    case 'workout_stale': return '🕒 Workout still open';
    case 'missed_workout': return 'Behind on workouts';
    case 'stalled': return 'Stalled exercise';
    case 'check_in_submitted': return '📋 Check-in';
    case 'missed_checkin': return '⏭ Missed check-in';
    case 'deload': return 'Deload recommended';
    case 'effort_gap': return 'Effort gap';
    case 'adherence_drop': return 'Adherence dropped';
    case 'returned_after_gap': return 'Returned after gap';
    case 'performance_cliff': return 'Performance cliff';
    case 'went_quiet': return 'Went quiet';
    case 'check_in_due': return 'Coaching';
    case 'weekly_note_sent': return 'Coaching';
  }
}

export async function insertAlert(args: {
  clientId: string;
  type: AlertType;
  message: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const supa = db();
  await supa.from('alerts').insert({
    client_id: args.clientId,
    type: args.type,
    message: args.message,
    data: args.data ?? null,
  });

  if (PUSHABLE.has(args.type)) {
    void sendPushToCoach({
      title: titleFor(args.type),
      body: args.message,
      url: '/coach',
    }).catch(() => {});
  }
}
