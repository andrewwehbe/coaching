import { NextResponse } from 'next/server';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

type Params = Promise<{ id: string }>;

export async function POST(_req: Request, ctx: { params: Params }) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const supa = db();

  const { data: proposal } = await supa
    .from('swap_proposals')
    .select('id,status,client_id,exercise_id')
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

  const now = new Date().toISOString();
  await supa
    .from('swap_proposals')
    .update({ status: 'rejected', resolved_at: now })
    .eq('id', proposal.id);

  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: user.id,
    action: 'swap.reject',
    target_type: 'swap_proposal',
    target_id: proposal.id,
    details: {
      client_id: proposal.client_id,
      exercise_id: proposal.exercise_id,
    },
  });

  return NextResponse.json({ ok: true });
}
