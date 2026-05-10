import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * Constant-time check of the request's cron secret. Accepts either:
 *   - x-cron-secret: <CRON_SECRET>           (manual / curl)
 *   - Authorization: Bearer <CRON_SECRET>    (Vercel Cron auto-sends this)
 *
 * Returns null on success; an unauthorized NextResponse on failure (or
 * a 500 if CRON_SECRET isn't configured).
 *
 * We hash both sides to SHA-256 so timingSafeEqual sees fixed-length
 * buffers regardless of header content. A bare === leaks length and
 * lets a remote attacker time-walk the secret one byte at a time.
 */
export function verifyCronSecret(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }

  const headerSecret = req.headers.get('x-cron-secret') ?? '';
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';

  const want = sha256(secret);
  if (
    (headerSecret && safeEqual(sha256(headerSecret), want)) ||
    (bearer && safeEqual(sha256(bearer), want))
  ) {
    return null;
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
