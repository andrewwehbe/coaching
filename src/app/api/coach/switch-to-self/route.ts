import { NextResponse } from 'next/server';

import { issueSession, readSession, revokeSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { linkForCoach } from '@/lib/coach-link';

// Quality-of-life shortcut for a coach who is also a client (e.g. trains
// themselves). Single click in the coach UI swaps the session over to the
// linked client account (coach_links row) so they don't have to log out
// and re-enter the client PIN.

export async function POST(req: Request) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const link = await linkForCoach(user.id);
  if (!link) {
    return NextResponse.json({ error: 'No linked client' }, { status: 404 });
  }

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, name, greeting_name, active')
    .eq('id', link.clientId)
    .maybeSingle();

  if (!client) {
    return NextResponse.json({ error: 'Linked client not found' }, { status: 404 });
  }
  if (!client.active) {
    return NextResponse.json({ error: 'Linked client is deactivated' }, { status: 400 });
  }

  await audit({
    actorType: 'coach',
    actorId: user.id,
    action: 'switch_to_client',
    targetType: 'client',
    targetId: client.id,
    details: { client_name: client.name },
  });

  await revokeSession();
  await issueSession(
    {
      type: 'client',
      id: client.id,
      name: client.name,
      greetingName: client.greeting_name ?? client.name,
      active: client.active,
    },
    req.headers.get('user-agent'),
  );

  return NextResponse.json({ ok: true, redirect: '/today' });
}
