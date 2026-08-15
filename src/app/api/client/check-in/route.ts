import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { insertAlert } from '@/lib/notify';

const PhotoSchema = z.object({
  label: z.enum(['front', 'side', 'back', 'extra']),
  storagePath: z.string().min(1).max(500),
});

const Body = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  bodyWeight: z.number().positive().max(1000).nullable().optional(),
  bodyWeightUnit: z.enum(['kg', 'lb']).optional(),
  notes: z.string().max(2000).optional(),
  photos: z.array(PhotoSchema).max(8).optional(),
});

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
  const { bodyWeight, bodyWeightUnit, notes, photos } = parsed.data;
  const date = parsed.data.date ?? todayLocal();

  if (bodyWeight != null && !bodyWeightUnit) {
    return NextResponse.json(
      { error: 'bodyWeightUnit is required when bodyWeight is provided' },
      { status: 400 }
    );
  }

  // Storage paths are namespaced per user by /api/client/check-in/photo-url
  // ({clientId}/{ts}-{rand}-{filename}). Reject any path outside the
  // caller's own prefix — otherwise a client could attach another client's
  // object to their check-in and have coach views sign it.
  if (photos?.some((p) => !p.storagePath.startsWith(`${user.id}/`))) {
    return NextResponse.json({ error: 'Invalid photo path' }, { status: 400 });
  }

  const supa = db();

  // Upsert by (client_id, date) — one check-in per day per client.
  const { data: ci, error: ciErr } = await supa
    .from('check_ins')
    .upsert(
      {
        client_id: user.id,
        date,
        body_weight: bodyWeight ?? null,
        body_weight_unit: bodyWeight != null ? bodyWeightUnit : null,
        notes: notes ?? null,
      },
      { onConflict: 'client_id,date' }
    )
    .select('id')
    .single();

  if (ciErr || !ci) {
    return NextResponse.json(
      { error: ciErr?.message ?? 'Failed to save check-in' },
      { status: 500 }
    );
  }

  if (photos && photos.length > 0) {
    // Note: column name is `storage_url` for legacy reasons; we store the
    // bucket-relative path so reads can sign short-lived URLs and the bucket
    // can stay private.
    const rows = photos.map((p) => ({
      check_in_id: ci.id,
      label: p.label,
      storage_url: p.storagePath,
    }));
    const { error: phErr } = await supa.from('check_in_photos').insert(rows);
    if (phErr) {
      return NextResponse.json(
        { error: 'Saved check-in but failed to attach photos: ' + phErr.message },
        { status: 500 }
      );
    }
  }

  await insertAlert({
    clientId: user.id,
    type: 'check_in_submitted',
    message: `${user.name} submitted a check-in.`,
    data: { check_in_id: ci.id, date },
  });

  return NextResponse.json({ ok: true, id: ci.id });
}
