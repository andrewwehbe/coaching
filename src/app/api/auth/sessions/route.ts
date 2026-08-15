import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { hashSessionToken, readSession, SESSION_COOKIE } from '@/lib/auth';
import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Lists active (non-revoked, non-expired) sessions for the calling user.
 * Each row carries enough fingerprint data — last_used_ip, last_used_ua,
 * timestamps — for the user to recognize their own devices and revoke
 * anything that doesn't look like them.
 */
export async function GET() {
  const user = await readSession();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cookieStore = await cookies();
  const currentToken = cookieStore.get(SESSION_COOKIE)?.value ?? null;
  // Sessions store hashed ids since 0036; raw compare covers pre-migration rows.
  const currentIds = currentToken
    ? new Set([hashSessionToken(currentToken), currentToken])
    : new Set<string>();

  const supa = db();
  const { data } = await supa
    .from('sessions')
    .select(
      'id, created_at, last_used_at, expires_at, last_used_ip, last_used_ua',
    )
    .eq('user_type', user.type)
    .eq('user_id', user.id)
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .order('last_used_at', { ascending: false });

  const sessions = (data ?? []).map((s) => ({
    id: s.id,
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at,
    expiresAt: s.expires_at,
    lastUsedIp: s.last_used_ip,
    lastUsedUa: s.last_used_ua,
    isCurrent: currentIds.has(s.id),
  }));

  return NextResponse.json({ sessions });
}
