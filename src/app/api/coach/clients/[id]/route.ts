import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

type Params = Promise<{ id: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select(
      'id, name, active, weekly_day_target, body_weight_freq, photo_check_in_enabled, meal_plan_enabled, created_at, deactivated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ client });
}

const Patch = z.object({
  name: z.string().min(1).max(120).optional(),
  weekly_day_target: z.number().int().min(1).max(7).optional(),
  body_weight_freq: z.enum(['none', 'daily', '3x', 'weekly']).optional(),
  photo_check_in_enabled: z.boolean().optional(),
  meal_plan_enabled: z.boolean().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const updates: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.active === false) {
    updates.deactivated_at = new Date().toISOString();
  } else if (parsed.data.active === true) {
    updates.deactivated_at = null;
  }

  const { data: client, error } = await supa
    .from('clients')
    .update(updates)
    .eq('id', id)
    .select('id, name, active')
    .single();

  if (error || !client) {
    return NextResponse.json({ error: 'Failed to update client' }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action:
      parsed.data.active === false
        ? 'deactivate_client'
        : parsed.data.active === true
          ? 'reactivate_client'
          : 'update_client',
    targetType: 'client',
    targetId: id,
    details: parsed.data,
  });

  return NextResponse.json({ client });
}
