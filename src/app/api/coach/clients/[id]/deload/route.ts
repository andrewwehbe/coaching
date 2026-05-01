import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startOfWeek, formatISO } from 'date-fns';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

type Params = Promise<{ id: string }>;

const Body = z.object({ deload: z.boolean() });

/**
 * Toggles the current week as a deload for the client. We mark every workout
 * with this client + week_start = current Monday. If none exist yet, we
 * create a marker workout against day_index=1 of the active program so the
 * client UI can pick it up — but here we just flip flags on existing rows
 * and remember the choice via audit_log so M2 can render it.
 */
export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const weekStart = formatISO(startOfWeek(new Date(), { weekStartsOn: 1 }), {
    representation: 'date',
  });

  const { error } = await supa
    .from('workouts')
    .update({ is_deload: parsed.data.deload })
    .eq('client_id', id)
    .eq('week_start', weekStart);

  if (error) {
    return NextResponse.json({ error: 'Failed to mark deload' }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: parsed.data.deload ? 'mark_deload' : 'unmark_deload',
    targetType: 'client',
    targetId: id,
    details: { week_start: weekStart },
  });

  return NextResponse.json({ ok: true, weekStart });
}
