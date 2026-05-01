import 'server-only';

import { db } from './supabase';

/**
 * Updates best_efforts when a new set lands. Rule: max weight wins, and on
 * ties we prefer max reps. Unit changes don't auto-convert — we just store
 * the new top set's unit.
 *
 * Safe to call after every insert; ignores no-op cases.
 */
export async function upsertBestEffortFromSet(
  clientId: string,
  exerciseNameKey: string,
  weight: number | null | undefined,
  unit: string | null | undefined,
  reps: number | null | undefined,
  setId: string,
): Promise<void> {
  if (weight == null || reps == null) return;

  const supa = db();
  const { data: current } = await supa
    .from('best_efforts')
    .select('best_weight, best_reps')
    .eq('client_id', clientId)
    .eq('exercise_name_key', exerciseNameKey)
    .maybeSingle();

  const beats =
    !current ||
    current.best_weight == null ||
    weight > Number(current.best_weight) ||
    (weight === Number(current.best_weight) &&
      (current.best_reps == null || reps > current.best_reps));

  if (!beats) return;

  await supa.from('best_efforts').upsert(
    {
      client_id: clientId,
      exercise_name_key: exerciseNameKey,
      best_weight: weight,
      best_unit: unit ?? null,
      best_reps: reps,
      source_set_id: setId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'client_id,exercise_name_key' },
  );
}
