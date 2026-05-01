import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

type Params = Promise<{ id: string }>;

const Body = z.object({
  note: z.string().max(1000).nullable(),
});

export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const trimmed = parsed.data.note?.trim() || null;
  const { data: exercise, error } = await supa
    .from('exercises')
    .update({ coach_note: trimmed })
    .eq('id', id)
    .select('id, coach_note')
    .single();
  if (error || !exercise) {
    return NextResponse.json({ error: 'Failed to update note' }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'edit_coach_note',
    targetType: 'exercise',
    targetId: id,
    details: { has_note: trimmed != null },
  });

  return NextResponse.json({ exercise });
}
