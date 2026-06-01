import 'server-only';

import { startOfWeek, formatISO } from 'date-fns';

import { db } from './supabase';

/**
 * Shared deload-mark logic, extracted in Stage 4 so:
 *   - POST /api/coach/clients/[id]/deload         (toggle from coach UI)
 *   - POST /api/coach/suggestions/apply { deload } (one-click apply from
 *     the Gate B suggestion in suggestions.ts)
 * both go through the same upsert + mirror, can't drift, and emit the
 * same audit/push semantics.
 *
 * Two halves (unchanged from the original deload route):
 *   1. client_deload_weeks holds the canonical mark for the current
 *      calendar week (Mon-anchored).
 *   2. workouts.is_deload is mirrored onto every existing workout row
 *      for the same (client_id, week_start) so coach views + history
 *      stay in sync.
 *
 * The overlay that actually changes what the client sees on /today
 * (sets halved, RIR backed off, load held) is rendered at read time
 * via cue.applyDeloadOverlay + cue.buildRirTargetForCue — neither of
 * those mutates exercises.prescribed_sets. This module never touches
 * prescribed_sets either; the deload is purely additive metadata.
 */

export type DeloadMarkResult = {
  ok: true;
  weekStart: string;
} | {
  ok: false;
  error: string;
};

export async function markDeloadWeek(
  clientId: string,
  coachUserId: string,
  at: Date = new Date(),
): Promise<DeloadMarkResult> {
  const supa = db();
  const weekStart = formatISO(startOfWeek(at, { weekStartsOn: 1 }), {
    representation: 'date',
  });

  const { error: markErr } = await supa
    .from('client_deload_weeks')
    .upsert(
      { client_id: clientId, week_start: weekStart, marked_by: coachUserId },
      { onConflict: 'client_id,week_start' },
    );
  if (markErr) return { ok: false, error: 'Failed to mark deload' };

  const { error: flipErr } = await supa
    .from('workouts')
    .update({ is_deload: true })
    .eq('client_id', clientId)
    .eq('week_start', weekStart);
  if (flipErr) return { ok: false, error: 'Failed to flip workout flags' };

  return { ok: true, weekStart };
}

export async function unmarkDeloadWeek(
  clientId: string,
  at: Date = new Date(),
): Promise<DeloadMarkResult> {
  const supa = db();
  const weekStart = formatISO(startOfWeek(at, { weekStartsOn: 1 }), {
    representation: 'date',
  });

  const { error: unmarkErr } = await supa
    .from('client_deload_weeks')
    .delete()
    .eq('client_id', clientId)
    .eq('week_start', weekStart);
  if (unmarkErr) return { ok: false, error: 'Failed to unmark deload' };

  const { error: flipErr } = await supa
    .from('workouts')
    .update({ is_deload: false })
    .eq('client_id', clientId)
    .eq('week_start', weekStart);
  if (flipErr) return { ok: false, error: 'Failed to flip workout flags' };

  return { ok: true, weekStart };
}
