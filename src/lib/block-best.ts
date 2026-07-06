import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Best } from './cue';

/**
 * "Best of the current block" — the anchor for the workout cue.
 *
 * Background: the "Beat X" cue used to read straight from `best_efforts`,
 * which is the client's ALL-TIME max for a name_key (deduped across every
 * day and every date, and it only ever ratchets up). That means a months-old
 * peak, a set from a previous block, or a fat-finger entry becomes a
 * permanent target the client can't shake. Coaching-wise the useful anchor is
 * what they're actually lifting THIS block, not their historical high.
 *
 * Rule (per Andrew): when a client is on a new program and has logged the
 * movement within it, we only care about the new block's weights. Until they
 * have — the opening "just log your weight" sessions of a fresh block — we
 * fall back to the old all-time best so there's still a target on screen.
 *
 * So callers do: `buildCue(blockBest ?? oldBestEffort, rx)`.
 *
 * `best_efforts` is untouched and still powers the all-time "New PR" badge.
 *
 * The block is the active program, anchored at `training_start_at` (for
 * mid-cycle transfers) falling back to `uploaded_at`. A brand-new program
 * upload naturally starts an empty block, so the fallback-to-old kicks in
 * for the first sessions exactly as intended.
 *
 * Never throws: any read failure or empty result yields an empty map, so the
 * cue silently degrades to the previous all-time behaviour rather than
 * breaking the workout screen.
 */

const LB_TO_KG = 0.45359237;

function toKg(weight: number, unit: string | null | undefined): number {
  return unit === 'lb' ? weight * LB_TO_KG : weight;
}

type SetRow = {
  nameKey: string;
  weight: number | null;
  unit: string | null;
  reps: number | null;
};

/**
 * Pure: reduce raw sets to the best per name_key. Best = max weight
 * (kg-normalised so 60lb doesn't beat 30kg), ties broken by more reps.
 * Mirrors the rule in best-effort.ts. Exported for tests.
 */
export function pickBlockBests(rows: SetRow[]): Map<string, Best> {
  const best = new Map<string, Best>();
  for (const r of rows) {
    if (r.weight == null || r.reps == null) continue;
    const rKg = toKg(Number(r.weight), r.unit);
    const cur = best.get(r.nameKey);
    if (cur == null) {
      best.set(r.nameKey, { weight: Number(r.weight), unit: r.unit, reps: r.reps });
      continue;
    }
    const curKg = toKg(Number(cur.weight), cur.unit);
    const beats =
      rKg > curKg + 1e-9 ||
      (Math.abs(rKg - curKg) <= 1e-9 && r.reps > (cur.reps ?? 0));
    if (beats) {
      best.set(r.nameKey, { weight: Number(r.weight), unit: r.unit, reps: r.reps });
    }
  }
  return best;
}

/**
 * Loads the block-best per name_key for a client within one program. Done as
 * a few simple keyed reads rather than one deep join so it's predictable and
 * easy to reason about; the whole thing is wrapped so a failure just returns
 * an empty map (caller falls back to all-time best_efforts).
 */
export async function loadBlockBests(
  supa: SupabaseClient,
  clientId: string,
  programId: string | null | undefined,
  nameKeys: string[],
): Promise<Map<string, Best>> {
  if (!programId || nameKeys.length === 0) return new Map();

  try {
    // Block start: training_start_at (mid-cycle transfer) else uploaded_at.
    const { data: prog } = await supa
      .from('programs')
      .select('uploaded_at, training_start_at')
      .eq('id', programId)
      .maybeSingle();
    const blockStartRaw = prog?.training_start_at ?? prog?.uploaded_at ?? null;
    const blockStart = blockStartRaw ? String(blockStartRaw).slice(0, 10) : null;

    // All days in the program (a movement can recur across days under one
    // name_key — the block-best spans every session of it).
    const { data: days } = await supa
      .from('days')
      .select('id')
      .eq('program_id', programId);
    const dayIds = (days ?? []).map((d) => d.id as string);
    if (dayIds.length === 0) return new Map();

    // Exercise rows in those days matching the name_keys we care about.
    const { data: exs } = await supa
      .from('exercises')
      .select('id, name_key')
      .in('day_id', dayIds)
      .in('name_key', nameKeys);
    const exIdToKey = new Map((exs ?? []).map((e) => [e.id as string, e.name_key as string]));
    if (exIdToKey.size === 0) return new Map();

    // This client's workouts in the program, on/after the block start.
    let wq = supa
      .from('workouts')
      .select('id')
      .eq('client_id', clientId)
      .in('day_id', dayIds);
    if (blockStart) wq = wq.gte('week_start', blockStart);
    const { data: wkts } = await wq;
    const workoutIds = (wkts ?? []).map((w) => w.id as string);
    if (workoutIds.length === 0) return new Map();

    // Logs joining those workouts to the exercises of interest.
    const { data: logs } = await supa
      .from('exercise_logs')
      .select('id, exercise_id')
      .in('workout_id', workoutIds)
      .in('exercise_id', Array.from(exIdToKey.keys()));
    const logIdToKey = new Map<string, string>();
    for (const l of logs ?? []) {
      const k = exIdToKey.get(l.exercise_id as string);
      if (k) logIdToKey.set(l.id as string, k);
    }
    if (logIdToKey.size === 0) return new Map();

    // Their sets.
    const { data: sets } = await supa
      .from('sets')
      .select('exercise_log_id, weight, unit, reps')
      .in('exercise_log_id', Array.from(logIdToKey.keys()));

    const rows: SetRow[] = (sets ?? [])
      .map((s) => ({
        nameKey: logIdToKey.get(s.exercise_log_id as string) ?? '',
        weight: s.weight as number | null,
        unit: s.unit as string | null,
        reps: s.reps as number | null,
      }))
      .filter((r) => r.nameKey !== '');

    return pickBlockBests(rows);
  } catch {
    return new Map();
  }
}
