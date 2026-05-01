import { NextResponse } from 'next/server';
import { revokeSession, SESSION_COOKIE } from '@/lib/auth';

export async function POST() {
  await revokeSession();
  const res = NextResponse.json({ ok: true });
  // Belt-and-suspenders: also clear via NextResponse so the Set-Cookie
  // header is guaranteed to ride on this response.
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
