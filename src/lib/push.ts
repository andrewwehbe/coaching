import 'server-only';

import webpush from 'web-push';

import { db } from './supabase';
import { log } from './log';

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

type DeviceRow = { id: string; push_subscription: unknown };

async function devicesFor(
  userType: 'coach' | 'client',
  userIds: string[]
): Promise<DeviceRow[]> {
  if (!userIds.length) return [];
  const { data } = await db()
    .from('devices')
    .select('id, push_subscription')
    .eq('user_type', userType)
    .in('user_id', userIds);
  return data ?? [];
}

async function sendToDevices(
  devices: DeviceRow[],
  payload: Payload,
  who: { userType: 'coach' | 'client'; userId?: string }
): Promise<void> {
  if (!devices.length) return;

  const supa = db();
  const json = JSON.stringify(payload);
  const seen = new Set<string>();

  await Promise.all(
    devices.map(async (d) => {
      const sub = d.push_subscription as Subscription | null;
      if (!sub?.endpoint || seen.has(sub.endpoint)) return;
      seen.add(sub.endpoint);
      try {
        await webpush.sendNotification(sub, json);
        // Stamp last_pushed_ok_at so the cron prune knows this device
        // is alive. Awaited on purpose: a Supabase query only runs when
        // it is awaited, and the old `void` stamp never ran, so the
        // prune deleted every device 30 days after it subscribed.
        await supa
          .from('devices')
          .update({ last_pushed_ok_at: new Date().toISOString() })
          .eq('id', d.id);
      } catch (err: unknown) {
        // Drop subscriptions the push service has expired/unsubscribed.
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await supa.from('devices').delete().eq('id', d.id);
          log.info('push.subscription.dropped', { deviceId: d.id, status });
        } else {
          log.warn('push.send.failed', { deviceId: d.id, status, ...who });
        }
      }
    })
  );
}

/**
 * Coach alerts also go to the devices of the coach's own client account
 * (coach_links). One phone holds one push subscription, and the subscribe
 * route hands it to whichever account last synced it, so a coach who
 * switched into their client account stopped receiving coach alerts.
 * It is the same person on both accounts, so both deliver.
 */
export async function sendPushToCoach(payload: Payload): Promise<void> {
  if (!configure()) return;
  const supa = db();
  const [{ data: coaches }, { data: links }] = await Promise.all([
    supa.from('coaches').select('id'),
    supa.from('coach_links').select('client_id'),
  ]);
  if (!coaches?.length) return;
  const [coachDevices, linkedDevices] = await Promise.all([
    devicesFor('coach', coaches.map((c) => c.id)),
    devicesFor('client', (links ?? []).map((l) => l.client_id)),
  ]);
  await sendToDevices([...coachDevices, ...linkedDevices], payload, { userType: 'coach' });
}

export async function sendPushToClient(
  clientId: string,
  payload: Payload
): Promise<void> {
  if (!configure()) return;
  const devices = await devicesFor('client', [clientId]);
  await sendToDevices(devices, payload, { userType: 'client', userId: clientId });
}
