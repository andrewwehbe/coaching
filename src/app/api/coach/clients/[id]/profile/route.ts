import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { log } from '@/lib/log';

type Params = Promise<{ id: string }>;

/**
 * Coach-facing edit for the recommender inputs the decision tree needs:
 * who the client is (training_age, primary_goal), what they can train
 * with (equipment), and what they must not train (exercise_blacklist).
 * All fields are optional — nullable so the coach can clear them.
 */
const Body = z.object({
  training_age: z.enum(['novice', 'intermediate', 'advanced']).nullable(),
  primary_goal: z.enum(['hypertrophy', 'strength', 'fat_loss', 'general']).nullable(),
  equipment: z.enum(['full_gym', 'home_gym', 'dumbbells_only', 'bodyweight']).nullable(),
  exercise_blacklist: z.array(z.string().trim().min(1).max(200)).max(200),
});

export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id: clientId } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    log.warn('profile.invalid_payload', {
      coachId: guard.user.id,
      clientId,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  // Normalize blacklist: trim, dedupe case-insensitively, drop empties.
  const seen = new Set<string>();
  const blacklist: string[] = [];
  for (const raw of parsed.data.exercise_blacklist) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blacklist.push(raw);
  }

  const { error } = await supa
    .from('clients')
    .update({
      training_age: parsed.data.training_age,
      primary_goal: parsed.data.primary_goal,
      equipment: parsed.data.equipment,
      exercise_blacklist: blacklist,
    })
    .eq('id', clientId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'client.profile.update',
    targetType: 'client',
    targetId: clientId,
    details: {
      training_age: parsed.data.training_age,
      primary_goal: parsed.data.primary_goal,
      equipment: parsed.data.equipment,
      blacklist_count: blacklist.length,
    },
  });

  return NextResponse.json({ ok: true });
}
