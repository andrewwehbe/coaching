import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startOfWeek, formatISO } from 'date-fns';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';

type Params = Promise<{ id: string }>;

const Body = z.object({ deload: z.boolean() });

/**
 * Toggles the current week as a deload for the client. Two halves:
 *   1. client_deload_weeks holds the canonical mark — also picked up by
 *      future workouts started this week (via /api/client/workout/start)
 *      and by /today's deload-week banner.
 *   2. Existing workouts for the week have their is_deload flag flipped
 *      so the coach session view + history reflect the change.
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

  if (parsed.data.deload) {
    const { error: markErr } = await supa
      .from('client_deload_weeks')
      .upsert(
        { client_id: id, week_start: weekStart, marked_by: guard.user.id },
        { onConflict: 'client_id,week_start' },
      );
    if (markErr) {
      return NextResponse.json({ error: 'Failed to mark deload' }, { status: 500 });
    }
  } else {
    const { error: unmarkErr } = await supa
      .from('client_deload_weeks')
      .delete()
      .eq('client_id', id)
      .eq('week_start', weekStart);
    if (unmarkErr) {
      return NextResponse.json({ error: 'Failed to unmark deload' }, { status: 500 });
    }
  }

  // Mirror the flag onto any existing workouts so coach views stay in sync.
  const { error: flipErr } = await supa
    .from('workouts')
    .update({ is_deload: parsed.data.deload })
    .eq('client_id', id)
    .eq('week_start', weekStart);
  if (flipErr) {
    return NextResponse.json({ error: 'Failed to flip workout flags' }, { status: 500 });
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
