import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { listClientSummaries } from '@/lib/clients';
import { db } from '@/lib/supabase';
import { generateUniquePin } from '@/lib/pin';
import { audit } from '@/lib/audit';

export async function GET() {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const clients = await listClientSummaries();
  return NextResponse.json({ clients });
}

const Body = z.object({
  name: z.string().min(1).max(120),
  // 'pt' clients train in person and never sign in (0043), so no PIN is
  // issued for them at all.
  client_type: z.enum(['online', 'pt']).default('online'),
  weekly_day_target: z.number().int().min(1).max(7).default(4),
  body_weight_freq: z.enum(['none', 'daily', '3x', 'weekly']).default('none'),
  photo_check_in_enabled: z.boolean().default(false),
  meal_plan_enabled: z.boolean().default(false),
});

export async function POST(req: Request) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const isPt = parsed.data.client_type === 'pt';
  // Only mint a credential for someone who will actually use it. A PT client
  // with a PIN would be a loginable account nobody logs into.
  const credential = isPt ? null : await generateUniquePin();
  const supa = db();

  const { data: client, error } = await supa
    .from('clients')
    .insert({
      name: parsed.data.name,
      client_type: parsed.data.client_type,
      pin_hash: credential?.hash ?? null,
      pin_hmac: credential?.hmac ?? null,
      weekly_day_target: parsed.data.weekly_day_target,
      body_weight_freq: parsed.data.body_weight_freq,
      photo_check_in_enabled: parsed.data.photo_check_in_enabled,
      meal_plan_enabled: parsed.data.meal_plan_enabled,
    })
    .select('id, name')
    .single();

  if (error || !client) {
    return NextResponse.json({ error: 'Failed to create client' }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'create_client',
    targetType: 'client',
    targetId: client.id,
    details: { name: client.name, client_type: parsed.data.client_type },
  });

  return NextResponse.json({ client, pin: credential?.pin ?? null });
}
