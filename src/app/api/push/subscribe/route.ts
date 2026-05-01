import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
  expirationTime: z.number().nullable().optional(),
});

const bodySchema = z.object({
  subscription: subSchema,
  userAgent: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const user = await readSession();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-payload' }, { status: 400 });
  }
  const { subscription, userAgent } = parsed.data;

  const supa = db();

  // De-dupe by endpoint per user — same browser re-subscribing shouldn't pile up rows.
  const { data: existing } = await supa
    .from('devices')
    .select('id, push_subscription')
    .eq('user_type', user.type)
    .eq('user_id', user.id)
    .filter('push_subscription->>endpoint', 'eq', subscription.endpoint)
    .maybeSingle();

  if (existing) {
    await supa
      .from('devices')
      .update({
        push_subscription: subscription,
        user_agent: userAgent ?? null,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return NextResponse.json({ ok: true, id: existing.id });
  }

  const { data, error } = await supa
    .from('devices')
    .insert({
      user_type: user.type,
      user_id: user.id,
      push_subscription: subscription,
      user_agent: userAgent ?? null,
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}
