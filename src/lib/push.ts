import 'server-only';

import webpush from 'web-push';

import { db } from './supabase';

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return false;
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

type Payload = {
  title: string;
  body: string;
  url?: string;
};

type Subscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

async function sendToUser(
  userType: 'coach' | 'client',
  userId: string,
  payload: Payload
): Promise<void> {
  if (!configure()) return;

  const supa = db();
  const { data: devices } = await supa
    .from('devices')
    .select('id, push_subscription')
    .eq('user_type', userType)
    .eq('user_id', userId);

  if (!devices?.length) return;

  const json = JSON.stringify(payload);

  await Promise.all(
    devices.map(async (d) => {
      const sub = d.push_subscription as Subscription | null;
      if (!sub?.endpoint) return;
      try {
        await webpush.sendNotification(sub, json);
      } catch (err: unknown) {
        // Drop subscriptions the push service has expired/unsubscribed.
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await supa.from('devices').delete().eq('id', d.id);
        }
      }
    })
  );
}

export async function sendPushToCoach(payload: Payload): Promise<void> {
  if (!configure()) return;
  const supa = db();
  const { data: coaches } = await supa.from('coaches').select('id');
  if (!coaches?.length) return;
  await Promise.all(coaches.map((c) => sendToUser('coach', c.id, payload)));
}

export async function sendPushToClient(
  clientId: string,
  payload: Payload
): Promise<void> {
  await sendToUser('client', clientId, payload);
}
