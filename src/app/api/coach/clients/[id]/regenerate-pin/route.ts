import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { generateUniquePin } from '@/lib/pin';
import { audit } from '@/lib/audit';

type Params = Promise<{ id: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const supa = db();
  const { data: existing } = await supa.from('clients').select('id').eq('id', id).maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { pin, hash, hmac } = await generateUniquePin();
  const { error } = await supa
    .from('clients')
    .update({
      pin_hash: hash,
      pin_hmac: hmac,
      pin_attempts: 0,
      pin_locked_until: null,
    })
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: 'Failed to regenerate PIN' }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'regenerate_pin',
    targetType: 'client',
    targetId: id,
  });

  return NextResponse.json({ pin });
}
