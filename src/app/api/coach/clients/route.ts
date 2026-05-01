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

  const { pin, hash } = await generateUniquePin();
  const supa = db();

  const { data: client, error } = await supa
    .from('clients')
    .insert({
      name: parsed.data.name,
      pin_hash: hash,
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
    details: { name: client.name },
  });

  return NextResponse.json({ client, pin });
}
