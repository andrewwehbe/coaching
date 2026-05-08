import 'server-only';

import { db } from './supabase';
import { sendPushToCoach } from './push';

export type AlertType =
  | 'pain'
  | 'stalled'
  | 'missed_workout'
  | 'workout_started'
  | 'workout_completed'
  | 'workout_stale'
  | 'check_in_due'
  | 'check_in_submitted'
  | 'missed_checkin';

// Every coach-facing alert is pushable now — coach asked to be notified
// in real time on workout start/finish, check-ins, missed days, pain,
// stalled. The only non-pushable is check_in_due (that one goes to the
// client themselves via the cron, not the coach).
const PUSHABLE: ReadonlySet<AlertType> = new Set([
  'pain',
  'stalled',
  'missed_workout',
  'workout_started',
  'workout_completed',
  'workout_stale',
  'check_in_submitted',
  'missed_checkin',
]);

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
    const title =
      args.type === 'pain' ? '⚠️ Pain reported'
      : args.type === 'workout_started' ? '🏋️ Started'
      : args.type === 'workout_completed' ? '✅ Finished'
      : args.type === 'workout_stale' ? '🕒 Workout still open'
      : args.type === 'missed_workout' ? 'Behind on workouts'
      : args.type === 'stalled' ? 'Stalled exercise'
      : args.type === 'check_in_submitted' ? '📋 Check-in'
      : args.type === 'missed_checkin' ? '⏭ Missed check-in'
      : 'Coaching';
    void sendPushToCoach({
      title,
      body: args.message,
      url: '/coach',
    }).catch(() => {});
  }
}
