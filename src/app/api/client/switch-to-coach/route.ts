import { NextResponse } from 'next/server';

import { issueSession, readSession, revokeSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

// Reverse of /api/coach/switch-to-self: lets the linked client jump back into
// their coach session without re-entering the coach PIN. Only works for the
// preconfigured client id (paranoia: a hostile client account shouldn't be
// able to escalate). Defaults to Andrew↔his coach record; override either via
// COACH_LINKED_CLIENT_ID and CLIENT_LINKED_COACH_ID env vars.
const FALLBACK_LINKED_CLIENT_ID = '8a06a900-aec4-44fc-8da4-9f90581a74c0';
const FALLBACK_LINKED_COACH_ID = '5ad5e2db-1135-4791-8297-f1aa43162d84';

export async function POST(req: Request) {
  const user = await readSession();
  if (!user || user.type !== 'client') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const allowedClientId =
    process.env.COACH_LINKED_CLIENT_ID || FALLBACK_LINKED_CLIENT_ID;
  if (user.id !== allowedClientId) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }

  const targetCoachId =
    process.env.CLIENT_LINKED_COACH_ID || FALLBACK_LINKED_COACH_ID;
  const supa = db();
  const { data: coach } = await supa
    .from('coaches')
    .select('id, name')
    .eq('id', targetCoachId)
    .maybeSingle();

  if (!coach) {
    return NextResponse.json({ error: 'Linked coach not found' }, { status: 404 });
  }

  await audit({
    actorType: 'client',
    actorId: user.id,
    action: 'switch_to_coach',
    targetType: 'coach',
    targetId: coach.id,
    details: { coach_name: coach.name },
  });

  await revokeSession();
  await issueSession(
    { type: 'coach', id: coach.id, name: coach.name },
    req.headers.get('user-agent'),
  );

  return NextResponse.json({ ok: true, redirect: '/coach' });
}
