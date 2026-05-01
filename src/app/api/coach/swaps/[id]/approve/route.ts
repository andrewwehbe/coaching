import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

type Params = Promise<{ id: string }>;

const Body = z.object({
  replacement_exercise_id: z.string().uuid(),
});

export async function POST(req: Request, ctx: { params: Params }) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();

  const { data: proposal } = await supa
    .from('swap_proposals')
    .select('id,status,exercise_id,client_id')
    .eq('id', id)
    .maybeSingle();
  if (!proposal) {
    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  }
  if (proposal.status !== 'pending') {
    return NextResponse.json(
      { error: 'Proposal already resolved' },
      { status: 409 }
    );
  }

  const { data: original } = await supa
    .from('exercises')
    .select('id,day_id')
    .eq('id', proposal.exercise_id)
    .maybeSingle();
  if (!original) {
    return NextResponse.json(
      { error: 'Original exercise missing' },
      { status: 404 }
    );
  }

  const { data: replacement } = await supa
    .from('exercises')
    .select('id,day_id')
    .eq('id', parsed.data.replacement_exercise_id)
    .maybeSingle();
  if (!replacement) {
    return NextResponse.json(
      { error: 'Replacement exercise not found' },
      { status: 404 }
    );
  }
  if (replacement.day_id !== original.day_id) {
    return NextResponse.json(
      { error: 'Replacement must be in the same day as the original' },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  await supa
    .from('exercises')
    .update({ archived_at: now })
    .eq('id', proposal.exercise_id);

  await supa
    .from('swap_proposals')
    .update({
      status: 'approved',
      replacement_exercise_id: replacement.id,
      resolved_at: now,
    })
    .eq('id', proposal.id);

  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: user.id,
    action: 'swap.approve',
    target_type: 'swap_proposal',
    target_id: proposal.id,
    details: {
      client_id: proposal.client_id,
      original_exercise_id: proposal.exercise_id,
      replacement_exercise_id: replacement.id,
    },
  });

  return NextResponse.json({ ok: true });
}
