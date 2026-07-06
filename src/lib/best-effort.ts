import 'server-only';

import { db } from './supabase';
import { log } from './log';

/**
 * Updates best_efforts when a new set lands. Rule: max weight wins, and on
 * ties we prefer max reps. Mixed kg/lb inputs are normalized to kg for the
 * comparison so 100kg correctly beats 200lb (~90.7kg). The stored unit
 * tracks whichever unit the winning set was logged in.
 *
 * Safe to call after every insert; ignores no-op cases.
 */
const LB_TO_KG = 0.45359237;

// 1 gram tolerance — exists so that lb→kg conversions don't miss legitimate
// ties due to float precision (220.46 lb ≈ 99.9999... kg vs 100 kg).
const TIE_EPSILON_KG = 0.001;

function toKg(weight: number, unit: string | null | undefined): number {
  return unit === 'lb' ? weight * LB_TO_KG : weight;
}

/**
 * Pure: does the candidate set beat the current best? Exported for tests.
 *
 * - currentKg = null means no prior best exists → always beats.
 * - Float ties within TIE_EPSILON_KG fall back to reps (more reps wins).
 */
export function beats(
  currentKg: number | null,
  currentReps: number | null,
  newKg: number,
  newReps: number,
): boolean {
  if (currentKg == null) return true;
  if (newKg > currentKg + TIE_EPSILON_KG) return true;
  if (newKg < currentKg - TIE_EPSILON_KG) return false;
  // Tie band: more reps wins.
  return currentReps == null || newReps > currentReps;
}

export type BestSnapshot = {
  weight: number;
  unit: 'kg' | 'lb' | string | null;
  reps: number;
};

/**
 * Pure: human-readable delta string for the PR overlay. Uses the new set's
 * unit when displaying weight deltas (so a client logging in lb sees lb).
 *
 * - First PR (no prior best): "First PR for this exercise"
 * - Weight PR: "Up X kg from your last PR" (1 decimal, trailing .0 stripped)
 * - Rep PR (same weight within epsilon): "+N rep[s] at the same weight"
 *
 * Exported for unit tests.
 */
export function prDeltaMessage(prev: BestSnapshot | null, next: BestSnapshot): string {
  if (prev == null) return 'First PR for this exercise';

  const newKg = toKg(next.weight, next.unit);
  const prevKg = toKg(prev.weight, prev.unit);

  // Tie band → rep PR.
  if (Math.abs(newKg - prevKg) <= TIE_EPSILON_KG) {
    const delta = next.reps - prev.reps;
    return `+${delta} rep${delta === 1 ? '' : 's'} at the same weight`;
  }

  // Convert prev to next's unit so the delta is shown in the unit the user
  // just logged in.
  const prevInNextUnit = next.unit === 'lb' ? prevKg / LB_TO_KG : prevKg;
  const deltaInNextUnit = next.weight - prevInNextUnit;
  const unit = next.unit === 'lb' ? 'lb' : 'kg';
  return `Up ${formatDelta(deltaInNextUnit)} ${unit} from your last PR`;
}

function formatDelta(n: number): string {
  // 1-decimal, strip trailing .0.
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export type UpsertResult =
  | { updated: true; prMessage: string }
  | { updated: false; reason: string };

export async function upsertBestEffortFromSet(
  clientId: string,
  exerciseNameKey: string,
  weight: number | null | undefined,
  unit: string | null | undefined,
  reps: number | null | undefined,
  setId: string,
): Promise<UpsertResult> {
  if (weight == null || reps == null) return { updated: false, reason: 'missing_weight_or_reps' };
  if (!exerciseNameKey) {
    log.warn('best_effort.skip', { reason: 'empty_name_key', clientId, setId });
    return { updated: false, reason: 'empty_name_key' };
  }

  const supa = db();
  const { data: current, error: readErr } = await supa
    .from('best_efforts')
    .select('best_weight, best_unit, best_reps')
    .eq('client_id', clientId)
    .eq('exercise_name_key', exerciseNameKey)
    .maybeSingle();
  if (readErr) {
    log.error('best_effort.read_failed', readErr, { clientId, exerciseNameKey, setId });
    return { updated: false, reason: 'read_failed' };
  }

  const newKg = toKg(weight, unit);
  const curKg =
    current?.best_weight == null ? null : toKg(Number(current.best_weight), current.best_unit);

  if (!beats(curKg, current?.best_reps ?? null, newKg, reps)) {
    return { updated: false, reason: 'not_a_pr' };
  }

  const { error: writeErr } = await supa.from('best_efforts').upsert(
    {
      client_id: clientId,
      exercise_name_key: exerciseNameKey,
      best_weight: weight,
      best_unit: unit ?? null,
      best_reps: reps,
      source_set_id: setId,
      // An automatic PR clears any manual pin — beating the pinned weight
      // reclaims the row for the normal block-best cue behaviour.
      pinned: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'client_id,exercise_name_key' },
  );
  if (writeErr) {
    log.error('best_effort.write_failed', writeErr, { clientId, exerciseNameKey, setId });
    return { updated: false, reason: 'write_failed' };
  }

  log.info('best_effort.updated', { clientId, exerciseNameKey, setId, weight, unit, reps });

  const prev: BestSnapshot | null =
    current?.best_weight == null
      ? null
      : { weight: Number(current.best_weight), unit: current.best_unit, reps: current.best_reps };
  return {
    updated: true,
    prMessage: prDeltaMessage(prev, { weight, unit: unit ?? null, reps }),
  };
}

/**
 * When an exercise's name_key changes (rename, day reorder), the existing
 * best_efforts row would otherwise be orphaned. This copies the old row's
 * value to the new key, keeping whichever weight is higher if a row already
 * exists at the new key.
 *
 * Never deletes the old row — another exercise in the program may still
 * share the old name_key (same name across multiple days dedupes to one
 * key), in which case deletion would silently erase that exercise's PR.
 * Orphaned rows are harmless: they just sit unused.
 *
 * Returns 'migrated' when the new key now holds the higher value, 'kept'
 * when the existing new-key row already won, or 'noop' when no old row
 * existed.
 */
export async function migrateBestEffortKey(
  clientId: string,
  oldKey: string,
  newKey: string,
): Promise<'migrated' | 'kept' | 'noop'> {
  if (oldKey === newKey) return 'noop';

  const supa = db();
  const { data: old, error: readErr } = await supa
    .from('best_efforts')
    .select('best_weight, best_unit, best_reps, source_set_id, updated_at')
    .eq('client_id', clientId)
    .eq('exercise_name_key', oldKey)
    .maybeSingle();
  if (readErr) {
    log.error('best_effort.migrate_read_failed', readErr, { clientId, oldKey, newKey });
    return 'noop';
  }
  if (!old) return 'noop';

  const { data: existing } = await supa
    .from('best_efforts')
    .select('best_weight, best_unit, best_reps')
    .eq('client_id', clientId)
    .eq('exercise_name_key', newKey)
    .maybeSingle();

  const oldKg = toKg(Number(old.best_weight), old.best_unit);
  const existingKg =
    existing?.best_weight == null ? null : toKg(Number(existing.best_weight), existing.best_unit);

  if (!beats(existingKg, existing?.best_reps ?? null, oldKg, old.best_reps ?? 0)) {
    log.info('best_effort.migrate_kept', { clientId, oldKey, newKey });
    return 'kept';
  }

  const { error: writeErr } = await supa.from('best_efforts').upsert(
    {
      client_id: clientId,
      exercise_name_key: newKey,
      best_weight: old.best_weight,
      best_unit: old.best_unit,
      best_reps: old.best_reps,
      source_set_id: old.source_set_id,
      updated_at: old.updated_at,
    },
    { onConflict: 'client_id,exercise_name_key' },
  );
  if (writeErr) {
    log.error('best_effort.migrate_write_failed', writeErr, { clientId, oldKey, newKey });
    return 'noop';
  }

  log.info('best_effort.migrated', { clientId, oldKey, newKey });
  return 'migrated';
}
