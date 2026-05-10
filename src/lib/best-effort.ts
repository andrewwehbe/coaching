import 'server-only';

import { db } from './supabase';

/**
 * Updates best_efforts when a new set lands. Rule: max weight wins, and on
 * ties we prefer max reps. Mixed kg/lb inputs are normalized to kg for the
 * comparison so 100kg correctly beats 200lb (~90.7kg). The stored unit
 * tracks whichever unit the winning set was logged in.
 *
 * Safe to call after every insert; ignores no-op cases.
 */
const LB_TO_KG = 0.45359237;

function toKg(weight: number, unit: string | null | undefined): number {
  return unit === 'lb' ? weight * LB_TO_KG : weight;
}

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
    .select('best_weight, best_unit, best_reps')
    .eq('client_id', clientId)
    .eq('exercise_name_key', exerciseNameKey)
    .maybeSingle();

  const newKg = toKg(weight, unit);
  const curKg =
    current?.best_weight == null
      ? null
      : toKg(Number(current.best_weight), current.best_unit);

  const beats =
    curKg == null ||
    newKg > curKg ||
    (newKg === curKg && (current?.best_reps == null || reps > current.best_reps));

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
