import 'server-only';

import { db } from './supabase';

export type AlertType =
  | 'pain'
  | 'stalled'
  | 'missed_workout'
  | 'workout_started'
  | 'workout_completed'
  | 'check_in_due'
  | 'check_in_submitted';

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
}
