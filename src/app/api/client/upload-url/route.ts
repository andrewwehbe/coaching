import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { checkUploadRate } from '@/lib/upload-rate';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const BUCKET = 'workout-videos';

const Body = z.object({
  filename: z.string().min(1).max(200),
  size: z.number().int().min(1).max(MAX_BYTES),
  contentType: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('video/'), 'Must be a video file'),
});

export async function POST(req: Request) {
  const user = await readSession();
  if (!user || user.type !== 'client' || !user.active) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!checkUploadRate(user.id, 'video', { perTenMin: 30, perDay: 200 })) {
    return NextResponse.json(
      { error: 'Too many uploads. Try again later.' },
      { status: 429 }
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid body' },
      { status: 400 }
    );
  }

  const safeName = parsed.data.filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = `${user.id}/${Date.now()}-${randomBytes(6).toString('hex')}-${safeName}`;

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
