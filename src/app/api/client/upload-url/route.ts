import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

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
    // The bucket has to exist. Surface a helpful message instead of 500-ing
    // silently — this saves debugging time on first deploy.
    return NextResponse.json(
      {
        error:
          'Storage upload failed. Make sure a "workout-videos" bucket ' +
          'exists in Supabase Storage and that the service role can write to it.',
        details: error?.message,
      },
      { status: 500 }
    );
  }

  const { data: pub } = supa.storage.from(BUCKET).getPublicUrl(path);

  return NextResponse.json({
    uploadUrl: data.signedUrl,
    token: data.token,
    path,
    publicUrl: pub.publicUrl,
  });
}
