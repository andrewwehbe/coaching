import { NextResponse } from 'next/server';

import { readSession } from '@/lib/auth';
import { sendPushToCoach, sendPushToClient } from '@/lib/push';
import { db } from '@/lib/supabase';

export async function POST() {
  const user = await readSession();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Confirm the user has at least one stored subscription before sending,
  // so we can give an actionable error rather than silently no-op.
  const supa = db();
  const { count } = await supa
    .from('devices')
    .select('id', { count: 'exact', head: true })
    .eq('user_type', user.type)
    .eq('user_id', user.id)
    .not('push_subscription', 'is', null);

  if (!count || count === 0) {
    return NextResponse.json(
      {
        error:
          'No push subscription on file for this account. Reload the page so the toggle can re-sync, or click Enable.',
      },
      { status: 412 }
    );
  }

  const payload = {
    title: 'Test notification',
    body: `Hello ${user.name} — push delivery is working.`,
    url: user.type === 'coach' ? '/coach' : '/today',
  };

  if (user.type === 'coach') {
    await sendPushToCoach(payload);
  } else {
    await sendPushToClient(user.id, payload);
  }

  return NextResponse.json({ ok: true, devices: count });
}
