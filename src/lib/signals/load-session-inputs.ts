import 'server-only';

import { db } from '../supabase';
import type { SetMetric, SessionInput } from './progression';

/**
 * The shared session-input gatherer (sweep report step 6). The
 * "fetch workouts → exercise_logs → sets → group" pipeline was
 * re-implemented five times (suggestions.ts twice, recommend-for-client,
 * daily-analysis twice) with drifting fetch windows and filters. This is
 * now the single implementation:
 *  - completed workouts only (this also unifies the old cron drift where
 *    analyzeClient counted sets from in-progress workouts)
 *  - rows keep the raw snake_case + nested-exercises shape the consumers
 *    already destructure, so adopting it is a fetch swap, not a rewrite
 *  - .in() id lists are chunked so a long history can't blow the
 *    PostgREST URL-length limit
 */

export type GatheredWorkout = {
  id: string;
  client_id: string;
  day_id: string;
  started_at: string;
  completed_at: string | null;
  week_start: string;
};

export type GatheredLog = {
  id: string;
  workout_id: string;
  exercise_id: string;
  pain_reason: string | null;
  pain_type: string | null;
  client_note: string | null;
  exercises: unknown; // nested { name, name_key } (object or 1-array per PostgREST)
};

export type SessionInputsBundle = {
  workouts: GatheredWorkout[];
  logs: GatheredLog[];
  setsByLog: Map<string, SetMetric[]>;
};

const IN_CHUNK = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Logs (with exercise name/name_key + pain fields) and sets for a set of workouts. */
export async function loadLogsAndSets(
  workoutIds: string[],
): Promise<{ logs: GatheredLog[]; setsByLog: Map<string, SetMetric[]> }> {
  const supa = db();
  const logs: GatheredLog[] = [];
  for (const ids of chunk(workoutIds, IN_CHUNK)) {
    const { data } = await supa
      .from('exercise_logs')
      .select(
        'id, workout_id, exercise_id, pain_reason, pain_type, client_note, exercises(name, name_key)',
      )
      .in('workout_id', ids);
    for (const l of data ?? []) logs.push(l as unknown as GatheredLog);
  }

  const setsByLog = new Map<string, SetMetric[]>();
  for (const ids of chunk(logs.map((l) => l.id), IN_CHUNK)) {
    const { data } = await supa
      .from('sets')
      .select('exercise_log_id, weight, reps, rir, unit')
      .in('exercise_log_id', ids);
    for (const s of data ?? []) {
      const arr = setsByLog.get(s.exercise_log_id) ?? [];
      arr.push({
        weight: s.weight === null ? null : Number(s.weight),
        reps: s.reps === null ? null : Number(s.reps),
        rir: s.rir,
        unit: s.unit,
      });
      setsByLog.set(s.exercise_log_id, arr);
    }
  }

  return { logs, setsByLog };
}

/**
 * Completed workouts for a client set since a cutoff, plus their logs and
 * sets. Workouts come back ordered by started_at ascending.
 */
export async function loadSessionInputs(
  clientIds: string[],
  since: Date,
): Promise<SessionInputsBundle> {
  if (clientIds.length === 0) {
    return { workouts: [], logs: [], setsByLog: new Map() };
  }
  const supa = db();
  const { data: workouts } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, week_start')
    .in('client_id', clientIds)
    .not('completed_at', 'is', null)
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: true });

  const rows = (workouts ?? []) as GatheredWorkout[];
  const { logs, setsByLog } = await loadLogsAndSets(rows.map((w) => w.id));
  return { workouts: rows, logs, setsByLog };
}

/**
 * Group a bundle's logs into per-exercise SessionInput[] — the shape
 * buildProgressionSeries consumes. keyOf picks the grouping key (usually
 * exercise_id); logs with no sets are skipped when skipEmpty is set.
 */
export function groupSessions(
  logs: GatheredLog[],
  setsByLog: Map<string, SetMetric[]>,
  workoutStartedAt: Map<string, string>,
  opts?: { skipEmpty?: boolean },
): Map<string, SessionInput[]> {
  const out = new Map<string, SessionInput[]>();
  for (const l of logs) {
    const startedAt = workoutStartedAt.get(l.workout_id);
    if (!startedAt) continue;
    const sets = setsByLog.get(l.id) ?? [];
    if (opts?.skipEmpty && sets.length === 0) continue;
    const arr = out.get(l.exercise_id) ?? [];
    arr.push({ workoutId: l.workout_id, workoutStartedAt: startedAt, sets });
    out.set(l.exercise_id, arr);
  }
  return out;
}
