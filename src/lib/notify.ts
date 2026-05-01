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
// Workout start/complete/check-ins are nice-to-know, not push-worthy.
const PUSHABLE: ReadonlySet<AlertType> = new Set([
  'pain',
  'stalled',
  'missed_workout',
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
    // Fire-and-forget; never block the request on push delivery.
    void sendPushToCoach({
      title: args.type === 'pain' ? '⚠️ Pain reported' : 'Coaching',
      body: args.message,
      url: '/coach',
    }).catch(() => {});
  }
}
