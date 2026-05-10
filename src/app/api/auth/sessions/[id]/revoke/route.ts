import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { readSession, SESSION_COOKIE } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

type Params = Promise<{ id: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const user = await readSession();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supa = db();

  // Scope the revoke to sessions belonging to the current user — a coach
  // can't revoke a client's session and vice versa.
  const { data: target } = await supa
    .from('sessions')
    .select('id, user_type, user_id, revoked')
    .eq('id', id)
    .maybeSingle();

  if (!target || target.user_type !== user.type || target.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (target.revoked) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await supa.from('sessions').update({ revoked: true }).eq('id', id);

  await audit({
    actorType: user.type,
    actorId: user.id,
    action: 'session.revoke',
    targetType: 'session',
    targetId: id,
  });

  // If the user revoked their own current session, clear the cookie too
  // so the next request bounces them to /login cleanly.
  const cookieStore = await cookies();
  const currentToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (currentToken === id) {
    cookieStore.delete(SESSION_COOKIE);
  }

  return NextResponse.json({ ok: true });
}
