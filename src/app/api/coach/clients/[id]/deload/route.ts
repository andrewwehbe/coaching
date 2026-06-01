import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { audit } from '@/lib/audit';
import { markDeloadWeek, unmarkDeloadWeek } from '@/lib/deload';

type Params = Promise<{ id: string }>;

const Body = z.object({ deload: z.boolean() });

/**
 * Toggles the current week as a deload for the client. The actual
 * upsert + workout-flag mirror lives in lib/deload — shared with the
 * Stage-4 kind:'deload' apply route so the two surfaces can't drift.
 */
export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const result = parsed.data.deload
    ? await markDeloadWeek(id, guard.user.id)
    : await unmarkDeloadWeek(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: parsed.data.deload ? 'mark_deload' : 'unmark_deload',
    targetType: 'client',
    targetId: id,
    details: { week_start: result.weekStart },
  });

  return NextResponse.json({ ok: true, weekStart: result.weekStart });
}
