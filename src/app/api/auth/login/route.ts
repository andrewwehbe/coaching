import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';

import {
  attemptPinLogin,
  checkAndBumpRateLimit,
  clientIp,
  issueSession,
} from '@/lib/auth';

const Body = z.object({
  pin: z.string().regex(/^\d{5}$/, 'PIN must be 5 digits'),
});

export async function POST(req: Request) {
  const ip = await clientIp();
  const allowed = await checkAndBumpRateLimit(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again later.' },
      { status: 429 }
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid PIN format' }, { status: 400 });
  }

  const result = await attemptPinLogin(parsed.data.pin);
  if (!result.ok) {
    if (result.reason === 'locked') {
      return NextResponse.json(
        {
          error: 'Account temporarily locked. Contact your coach to reset.',
          lockedUntil: result.lockedUntil,
        },
        { status: 423 }
      );
    }
    return NextResponse.json({ error: 'Invalid PIN' }, { status: 401 });
  }

  const ua = (await headers()).get('user-agent');
  await issueSession(result.user, ua);

  return NextResponse.json({ ok: true, user: result.user });
}
