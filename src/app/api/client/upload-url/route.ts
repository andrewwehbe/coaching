import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { checkUploadRate } from '@/lib/upload-rate';
import { loadOpenClientWorkout } from '@/lib/workout-guard';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const BUCKET = 'workout-videos';

const Body = z.object({
  filename: z.string().min(1).max(200),
  size: z.number().int().min(1).max(MAX_BYTES),
  contentType: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('video/'), 'Must be a video file'),
  // Only needed when the coach is logging a PT client's session: the path
  // must be namespaced by the WORKOUT's client, and log_set checks exactly
  // that. A client session ignores it and always uploads under its own id.
  workoutId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const user = await readSession();
  if (!user || (user.type === 'client' && !user.active)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid body' },
      { status: 400 }
    );
  }

  let ownerId: string;
  if (user.type === 'client') {
    ownerId = user.id;
  } else {
    // Coach: resolve the PT client through the same guard the write routes
    // use, so a coach can never presign into an online client's namespace.
    if (!parsed.data.workoutId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const ctx = await loadOpenClientWorkout(parsed.data.workoutId);
    if (!ctx || ctx.actor !== 'coach') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    ownerId = ctx.user.id;
  }

  if (!checkUploadRate(ownerId, 'video', { perTenMin: 30, perDay: 200 })) {
    return NextResponse.json(
      { error: 'Too many uploads. Try again later.' },
      { status: 429 }
    );
  }

  const safeName = parsed.data.filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = `${ownerId}/${Date.now()}-${randomBytes(6).toString('hex')}-${safeName}`;

  const supa = db();
  const { data, error } = await supa.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    // Log the underlying Supabase error server-side so we can debug, but
    // don't ship infra error strings to the client.
    if (error) console.error('upload-url:', error);
    return NextResponse.json(
      { error: 'Could not start upload. Please try again.' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    uploadUrl: data.signedUrl,
    token: data.token,
    path,
  });
}
