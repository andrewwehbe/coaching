import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { markDeloadWeek } from '@/lib/deload';
import { sendPushToClient } from '@/lib/push';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add_set'),
    clientId: z.string().uuid(),
    exerciseIds: z.array(z.string().uuid()).min(1).max(50),
  }),
  z.object({
    kind: z.literal('archive_day'),
    clientId: z.string().uuid(),
    dayId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('swap_exercise'),
    clientId: z.string().uuid(),
    exerciseIds: z.array(z.string().uuid()).min(1).max(50),
    replacementName: z.string().trim().min(1).max(200),
  }),
  z.object({
    kind: z.literal('deload'),
    clientId: z.string().uuid(),
    firedTriggers: z.array(z.string().max(100)).max(20).optional(),
  }),
]);

/**
 * Applies a coach-approved suggestion. Previously this route cast the body
 * without validation, never verified the targeted rows belonged to
 * body.clientId, and the swap's archive-then-insert had only a best-effort
 * revert. Now: zod-validated, and the mutating kinds run through Postgres
 * functions (0039) that enforce exercise -> day -> program -> client
 * ownership INSIDE one transaction.
 */
export async function POST(req: Request) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    log.warn('suggestion.apply.invalid_body', {
      coachId: guard.user.id,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json({ error: 'Invalid suggestion payload' }, { status: 400 });
  }
  const body = parsed.data;

  const supa = db();

  if (body.kind === 'add_set') {
    const { data, error } = await supa.rpc('increment_prescribed_sets', {
      p_client_id: body.clientId,
      p_exercise_ids: body.exerciseIds,
    });
    if (error) {
      log.error('suggestion.add_set.rpc_failed', error, { clientId: body.clientId });
      return NextResponse.json({ error: 'Failed to add set' }, { status: 500 });
    }
    const result = data as { ok?: true; error?: string; updated?: number; names?: string[] } | null;
    if (result?.error === 'ownership_mismatch') {
      log.warn('suggestion.add_set.ownership_mismatch', {
        clientId: body.clientId,
        exerciseIds: body.exerciseIds,
      });
      return NextResponse.json({ error: 'Exercises do not belong to this client' }, { status: 400 });
    }
    if (!result?.ok) {
      return NextResponse.json({ error: 'No active exercises matched' }, { status: 404 });
    }
    const targetName = result.names?.[0] ?? null;

    await supa.from('audit_log').insert({
      actor_type: 'coach',
      actor_id: guard.user.id,
      action: 'suggestion.add_set',
      target_type: 'client',
      target_id: body.clientId,
      details: { exercise_ids: body.exerciseIds, target_name: targetName },
    });

    void sendPushToClient(body.clientId, {
      title: 'Program updated',
      body: `Coach added a set to ${targetName ?? 'an exercise'}.`,
      url: '/today',
    }).catch(() => {});

    return NextResponse.json({ ok: true, updated: result.updated ?? 0 });
  }

  if (body.kind === 'archive_day') {
    // Ownership: the day must belong to one of this client's programs.
    const { data: day, error: de } = await supa
      .from('days')
      .select('id, programs!inner(client_id)')
      .eq('id', body.dayId)
      .maybeSingle();
    if (de) {
      log.error('suggestion.archive_day.lookup_failed', de, { dayId: body.dayId });
      return NextResponse.json({ error: 'Failed to archive day' }, { status: 500 });
    }
    const ownerClientId = (day as unknown as { programs?: { client_id?: string } } | null)
      ?.programs?.client_id;
    if (!day || ownerClientId !== body.clientId) {
      log.warn('suggestion.archive_day.ownership_mismatch', {
        dayId: body.dayId,
        clientId: body.clientId,
      });
      return NextResponse.json({ error: 'Day does not belong to this client' }, { status: 400 });
    }

    // Soft-delete: set archived_at on every exercise in that day. The day
    // row itself stays so historical workouts still link. Single statement,
    // so no transaction needed.
    const { error: ee } = await supa
      .from('exercises')
      .update({ archived_at: new Date().toISOString() })
      .eq('day_id', body.dayId)
      .is('archived_at', null);
    if (ee) {
      log.error('suggestion.archive_day.update_failed', ee, { dayId: body.dayId });
      return NextResponse.json({ error: 'Failed to archive day' }, { status: 500 });
    }

    await supa.from('audit_log').insert({
      actor_type: 'coach',
      actor_id: guard.user.id,
      action: 'suggestion.archive_day',
      target_type: 'day',
      target_id: body.dayId,
      details: { client_id: body.clientId },
    });

    void sendPushToClient(body.clientId, {
      title: 'Program updated',
      body: 'Coach removed an inactive day from your split.',
      url: '/today',
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  }

  if (body.kind === 'swap_exercise') {
    // Archive originals + insert replacements happens inside swap_exercises
    // (0039) — one transaction, ownership enforced, positions preserved via
    // the partial (day_id, position) index semantics.
    const { data, error } = await supa.rpc('swap_exercises', {
      p_client_id: body.clientId,
      p_exercise_ids: body.exerciseIds,
      p_replacement_name: body.replacementName,
    });
    if (error) {
      log.error('suggestion.swap.rpc_failed', error, { clientId: body.clientId });
      return NextResponse.json({ error: 'Failed to swap exercise' }, { status: 500 });
    }
    const result = data as { ok?: true; error?: string; replaced?: number } | null;
    if (result?.error === 'ownership_mismatch') {
      log.warn('suggestion.swap.ownership_mismatch', {
        clientId: body.clientId,
        exerciseIds: body.exerciseIds,
      });
      return NextResponse.json({ error: 'Exercises do not belong to this client' }, { status: 400 });
    }
    if (result?.error === 'no_active_matches') {
      return NextResponse.json({ error: 'No active exercises matched' }, { status: 404 });
    }
    if (!result?.ok) {
      return NextResponse.json({ error: 'Failed to swap exercise' }, { status: 500 });
    }

    await supa.from('audit_log').insert({
      actor_type: 'coach',
      actor_id: guard.user.id,
      action: 'suggestion.swap_exercise',
      target_type: 'client',
      target_id: body.clientId,
      details: {
        archived_exercise_ids: body.exerciseIds,
        replacement_name: body.replacementName,
      },
    });

    void sendPushToClient(body.clientId, {
      title: 'Program updated',
      body: `Coach swapped in ${body.replacementName}.`,
      url: '/today',
    }).catch(() => {});

    return NextResponse.json({ ok: true, replaced: result.replaced ?? 0 });
  }

  if (body.kind === 'deload') {
    // The suggestions engine emits apply: { kind: 'deload' } payloads.
    // Marks the current calendar week as a deload for the client. The
    // applyDeloadOverlay (cue.ts) reduces working-set volume at RENDER
    // time and buildRirTargetForCue applies the RIR backoff — neither
    // mutates exercises.prescribed_sets. Load is held; only volume +
    // effort drop. Coleman 2024 (PeerJ e16777) — complete cessation can
    // hurt strength, so keep the bar moving.
    const firedTriggers = body.firedTriggers ?? [];

    const result = await markDeloadWeek(body.clientId, guard.user.id);
    if (!result.ok) {
      log.error('suggestion.deload.failed', result.error, { clientId: body.clientId });
      return NextResponse.json({ error: 'Failed to mark deload week' }, { status: 500 });
    }

    await supa.from('audit_log').insert({
      actor_type: 'coach',
      actor_id: guard.user.id,
      action: 'suggestion.deload',
      target_type: 'client',
      target_id: body.clientId,
      details: { week_start: result.weekStart, fired_triggers: firedTriggers },
    });

    void sendPushToClient(body.clientId, {
      title: 'Deload week',
      body: 'Coach set this week as a deload — load is held, sets are reduced.',
      url: '/today',
    }).catch(() => {});

    return NextResponse.json({ ok: true, weekStart: result.weekStart });
  }

  // Unreachable — the zod union above covers every kind — but keeps the
  // route total if a new kind is added to the schema without an arm.
  return NextResponse.json({ error: 'Unknown kind' }, { status: 400 });
}
