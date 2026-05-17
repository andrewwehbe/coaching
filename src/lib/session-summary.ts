import 'server-only';

import { db } from './supabase';
import { log } from './log';

const LB_TO_KG = 0.45359237;
const TIE_EPSILON_KG = 0.001;

function toKg(weight: number, unit: string | null | undefined): number {
  return unit === 'lb' ? weight * LB_TO_KG : weight;
}

function formatNumber(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export type TopSet = { weight: number; unit: 'kg' | 'lb' | string | null; reps: number };

type SetCandidate = {
  weight: number | null;
  unit: 'kg' | 'lb' | string | null;
  reps: number | null;
};

/**
 * Pure: pick the heaviest set, breaking ties by reps. Returns null when no
 * set has both weight and reps. Exported for unit tests.
 */
export function topSetOf(sets: SetCandidate[]): TopSet | null {
  let best: TopSet | null = null;
  let bestKg = -Infinity;
  for (const s of sets) {
    if (s.weight == null || s.reps == null) continue;
    const kg = toKg(s.weight, s.unit);
    if (
      kg > bestKg + TIE_EPSILON_KG ||
      (Math.abs(kg - bestKg) <= TIE_EPSILON_KG && (best == null || s.reps > best.reps))
    ) {
      best = { weight: s.weight, unit: s.unit, reps: s.reps };
      bestKg = kg;
    }
  }
  return best;
}

export type DeltaKind = 'first' | 'better' | 'tied' | 'worse';
export type ExerciseDelta =
  | { kind: 'first' }
  | { kind: 'better' | 'tied' | 'worse'; text: string };

/**
 * Pure: human-readable comparison of this session's top set vs the prior
 * session's top set for the same exercise. Exported for unit tests.
 */
export function exerciseDelta(current: TopSet, prior: TopSet | null): ExerciseDelta {
  if (prior == null) return { kind: 'first' };

  const curKg = toKg(current.weight, current.unit);
  const prevKg = toKg(prior.weight, prior.unit);

  // Tie band → compare reps.
  if (Math.abs(curKg - prevKg) <= TIE_EPSILON_KG) {
    const repDelta = current.reps - prior.reps;
    if (repDelta > 0) return { kind: 'better', text: `+${repDelta} reps vs last` };
    if (repDelta < 0) return { kind: 'worse', text: `${repDelta} reps vs last` };
    return { kind: 'tied', text: 'Matched last session' };
  }

  // Convert prior to current's unit so the delta is shown in the unit the
  // client logged in this session.
  const priorInCurUnit = current.unit === 'lb' ? prevKg / LB_TO_KG : prevKg;
  const delta = current.weight - priorInCurUnit;
  const unit = current.unit === 'lb' ? 'lb' : 'kg';
  if (delta > 0) return { kind: 'better', text: `+${formatNumber(delta)} ${unit} vs last` };
  return { kind: 'worse', text: `-${formatNumber(Math.abs(delta))} ${unit} vs last` };
}

export type ExerciseSummary = {
  exerciseId: string;
  name: string;
  topSet: TopSet | null;
  priorTopSet: TopSet | null;
  delta: ExerciseDelta;
  isPR: boolean;
  painReason: string | null;
};

export type SessionSummary = {
  workout: {
    id: string;
    clientId: string;
    dayLabel: string;
    startedAt: string;
    completedAt: string | null;
    durationMinutes: number | null;
    sessionRpe: number | null;
  };
  exercises: ExerciseSummary[];
  totals: {
    setCount: number;
    totalVolumeKg: number;
    prCount: number;
  };
  priorSessionDate: string | null;
};

/**
 * Builds the post-workout session summary. Returns null when the workout
 * doesn't exist. Each exercise compares its top set this session against
 * the same exercise's top set in the most recent prior workout that used
 * the same day.
 */
export async function buildSessionSummary(workoutId: string): Promise<SessionSummary | null> {
  const supa = db();

  const { data: workout, error: wErr } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, session_rpe, days(label)')
    .eq('id', workoutId)
    .maybeSingle();
  if (wErr || !workout) return null;

  const { data: logs } = await supa
    .from('exercise_logs')
    .select('id, exercise_id, pain_reason, exercises(name, position)')
    .eq('workout_id', workoutId);

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('id, exercise_log_id, weight, unit, reps')
        .in('exercise_log_id', logIds)
    : { data: [] as Array<{ id: string; exercise_log_id: string; weight: number | string | null; unit: string | null; reps: number | null }> };

  // Find prior workout: same client, same day_id, started before this one,
  // completed.
  const { data: prior } = await supa
    .from('workouts')
    .select('id, started_at')
    .eq('client_id', workout.client_id)
    .eq('day_id', workout.day_id)
    .lt('started_at', workout.started_at)
    .not('completed_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let priorLogs: Array<{ id: string; exercise_id: string }> | null = null;
  let priorSets: Array<{ exercise_log_id: string; weight: number | string | null; unit: string | null; reps: number | null }> | null = null;
  if (prior) {
    const { data: pl } = await supa
      .from('exercise_logs')
      .select('id, exercise_id')
      .eq('workout_id', prior.id);
    priorLogs = pl ?? [];
    const plIds = priorLogs.map((l) => l.id);
    if (plIds.length) {
      const { data: ps } = await supa
        .from('sets')
        .select('exercise_log_id, weight, unit, reps')
        .in('exercise_log_id', plIds);
      priorSets = ps ?? [];
    }
  }

  // PR detection: which sets from this workout are currently the source of a
  // best_efforts row?
  const setIds = (sets ?? []).map((s) => s.id);
  const { data: prRows } = setIds.length
    ? await supa
        .from('best_efforts')
        .select('source_set_id')
        .eq('client_id', workout.client_id)
        .in('source_set_id', setIds)
    : { data: [] as Array<{ source_set_id: string | null }> };
  const prSetIds = new Set<string>();
  for (const r of prRows ?? []) if (r.source_set_id) prSetIds.add(r.source_set_id);

  // Group sets by log.
  const setsByLog = new Map<string, SetCandidate[]>();
  const setIdToLog = new Map<string, string>();
  for (const s of sets ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      weight: s.weight === null ? null : Number(s.weight),
      unit: s.unit,
      reps: s.reps,
    });
    setsByLog.set(s.exercise_log_id, arr);
    setIdToLog.set(s.id, s.exercise_log_id);
  }

  const priorSetsByExercise = new Map<string, SetCandidate[]>();
  if (priorLogs && priorSets) {
    const priorLogToExercise = new Map<string, string>();
    for (const l of priorLogs) priorLogToExercise.set(l.id, l.exercise_id);
    for (const s of priorSets) {
      const exId = priorLogToExercise.get(s.exercise_log_id);
      if (!exId) continue;
      const arr = priorSetsByExercise.get(exId) ?? [];
      arr.push({
        weight: s.weight === null ? null : Number(s.weight),
        unit: s.unit,
        reps: s.reps,
      });
      priorSetsByExercise.set(exId, arr);
    }
  }

  const logsByExId = new Map<string, { id: string; exerciseName: string; position: number; painReason: string | null }>();
  for (const l of logs ?? []) {
    const exRaw = l.exercises as unknown;
    const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as
      | { name?: string; position?: number }
      | null;
    logsByExId.set(l.exercise_id, {
      id: l.id,
      exerciseName: ex?.name ?? '—',
      position: ex?.position ?? 0,
      painReason: l.pain_reason,
    });
  }

  type WithPosition = ExerciseSummary & { _position: number };
  const built: WithPosition[] = [];
  let totalVolumeKg = 0;
  let setCount = 0;
  for (const [exId, info] of logsByExId.entries()) {
    const thisSets = setsByLog.get(info.id) ?? [];
    const top = topSetOf(thisSets);
    const priorTop = topSetOf(priorSetsByExercise.get(exId) ?? []);
    const delta = top ? exerciseDelta(top, priorTop) : { kind: 'first' as const };

    let isPR = false;
    for (const s of sets ?? []) {
      if (s.exercise_log_id === info.id && prSetIds.has(s.id)) {
        isPR = true;
        break;
      }
    }
    for (const s of thisSets) {
      if (s.weight == null || s.reps == null) continue;
      totalVolumeKg += toKg(s.weight, s.unit) * s.reps;
      setCount++;
    }

    built.push({
      exerciseId: exId,
      name: info.exerciseName,
      topSet: top,
      priorTopSet: priorTop,
      delta,
      isPR,
      painReason: info.painReason,
      _position: info.position,
    });
  }
  built.sort((a, b) => a._position - b._position);
  const exercises: ExerciseSummary[] = built.map(({ _position, ...rest }) => rest);

  const dayRaw = workout.days as unknown;
  const day = (Array.isArray(dayRaw) ? dayRaw[0] : dayRaw) as { label?: string } | null;

  const durationMinutes =
    workout.completed_at && workout.started_at
      ? Math.max(
          0,
          Math.round((new Date(workout.completed_at).getTime() - new Date(workout.started_at).getTime()) / 60000),
        )
      : null;

  log.info('session_summary.built', {
    workoutId,
    setCount,
    prCount: prSetIds.size,
    exerciseCount: exercises.length,
  });

  return {
    workout: {
      id: workout.id,
      clientId: workout.client_id,
      dayLabel: day?.label ?? '—',
      startedAt: workout.started_at,
      completedAt: workout.completed_at,
      durationMinutes,
      sessionRpe: (workout as { session_rpe?: number | null }).session_rpe ?? null,
    },
    exercises,
    totals: {
      setCount,
      totalVolumeKg: Math.round(totalVolumeKg),
      prCount: prSetIds.size,
    },
    priorSessionDate: prior?.started_at ?? null,
  };
}
