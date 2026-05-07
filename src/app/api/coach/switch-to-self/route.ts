import { NextResponse } from 'next/server';

import { issueSession, readSession, revokeSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

// Quality-of-life shortcut for the coach who is also a client (e.g. trains
// themselves). Single click in the coach UI swaps the session over to a
// preconfigured client account so they don't have to log out and re-enter
// the client PIN. Defaults to Andrew's id; override with COACH_LINKED_CLIENT_ID
// in env if the linked client ever changes.
const FALLBACK_LINKED_CLIENT_ID = '8a06a900-aec4-44fc-8da4-9f90581a74c0';

export async function POST(req: Request) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const targetId = process.env.COACH_LINKED_CLIENT_ID || FALLBACK_LINKED_CLIENT_ID;
  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, name, greeting_name, active')
    .eq('id', targetId)
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
