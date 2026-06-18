import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

const bodySchema = z.object({
  endpoint: z.string().url(),
});

// Called on logout: detach the current device row for this browser's push
// endpoint so a signed-out account stops receiving pushes. We intentionally do
// NOT ask the browser to unsubscribe — the subscription stays valid, and the
// next login's self-heal in NotificationsToggle re-attaches it without
// re-prompting the user.
export async function POST(req: Request) {
  const user = await readSession();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad-payload' }, { status: 400 });
  }

  const supa = db();
  await supa
    .from('devices')
    .delete()
    .eq('user_type', user.type)
    .eq('user_id', user.id)
    .filter('push_subscription->>endpoint', 'eq', parsed.data.endpoint);

  return NextResponse.json({ ok: true });
}
