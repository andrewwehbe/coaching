import 'server-only';

import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';

import { readSession, type SessionUser } from './auth';

/**
 * For server components / pages: returns the coach session, or redirects.
 */
export async function requireCoach(): Promise<SessionUser & { type: 'coach' }> {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'coach') redirect('/today');
  return user;
}

/**
 * For route handlers: returns either the coach session or a 401 NextResponse.
 * Caller checks `'error' in result` to short-circuit.
 */
export async function requireCoachApi(): Promise<
  | { user: SessionUser & { type: 'coach' } }
  | { error: NextResponse }
> {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { user };
}
