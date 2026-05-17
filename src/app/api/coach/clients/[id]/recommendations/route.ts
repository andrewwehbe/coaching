import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { log } from '@/lib/log';

type Params = Promise<{ id: string }>;

const REC_TYPES = [
  'hold',
  'refer_adherence',
  'trigger_deload',
  'refer_recovery',
  'phase_transition',
  'exercise_reorder',
  'rotate_day',
  'volume_adjust',
  'intensity_adjust',
  'single_exercise_swap',
  'refer_technique_or_loading',
  'split_rotation',
] as const;

const DECISIONS = ['applied', 'dismissed', 'snoozed', 'acknowledged'] as const;

/**
 * Persists a coach decision on a recommendation. Insert-only — we never
 * overwrite a past decision because the row is the audit log. The full
 * recommendation snapshot (title, body, rationale, data_gaps, forced_swaps)
 * and the upstream signals are captured so analysis can replay decisions
 * after the recommender logic evolves.
 */
const Body = z.object({
  decision: z.enum(DECISIONS),
  decision_note: z.string().trim().max(2000).nullish(),
  rec_type: z.enum(REC_TYPES),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  forced_swaps: z
    .array(
      z.object({
        exerciseId: z.string(),
        exerciseName: z.string(),
        reason: z.string(),
      }),
    )
    .max(50),
  rationale: z.array(z.string()).max(50),
  data_gaps: z.array(z.string()).max(50),
  signals: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id: clientId } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    log.warn('recommendation.invalid_body', {
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

  const { data: row, error } = await supa
    .from('recommendations')
    .insert({
      client_id: clientId,
      coach_id: guard.user.id,
      rec_type: parsed.data.rec_type,
      title: parsed.data.title,
      body: parsed.data.body,
      forced_swaps: parsed.data.forced_swaps,
      rationale: parsed.data.rationale,
      data_gaps: parsed.data.data_gaps,
      signals: parsed.data.signals ?? {},
      decision: parsed.data.decision,
      decision_note: parsed.data.decision_note?.trim() || null,
    })
    .select('id, created_at')
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: error?.message ?? 'Failed to save' },
      { status: 500 },
    );
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'recommendation.decision',
    targetType: 'client',
    targetId: clientId,
    details: {
      recommendation_id: row.id,
      decision: parsed.data.decision,
      rec_type: parsed.data.rec_type,
    },
  });

  return NextResponse.json({ ok: true, id: row.id, created_at: row.created_at });
}
