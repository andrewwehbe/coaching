import 'server-only';

import { db } from './supabase';
import { sendPushToCoach } from './push';

export type AlertType =
  | 'pain'
  | 'stalled'
  | 'missed_workout'
  | 'workout_started'
  | 'workout_completed'
  | 'check_in_due'
  | 'check_in_submitted';

// Which alert types are urgent enough to wake the coach's phone.
// Workout start/complete are now pushable so the coach knows in real time
// when a client begins or finishes a session. Check-ins stay quiet.
const PUSHABLE: ReadonlySet<AlertType> = new Set([
  'pain',
  'stalled',
  'missed_workout',
  'workout_started',
  'workout_completed',
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
      : args.type === 'missed_workout' ? 'Behind on workouts'
      : args.type === 'stalled' ? 'Stalled exercise'
      : 'Coaching';
    void sendPushToCoach({
      title,
      body: args.message,
      url: '/coach',
    }).catch(() => {});
  }
}
