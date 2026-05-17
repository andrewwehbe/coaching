import 'server-only';

import { subDays } from 'date-fns';

import { db } from './supabase';
import { computeClientRirDrift, pickTopSetRir, type RirExposure } from './rir-drift';

export type EffortWindow = {
  windowDays: number;
  avgSessionRpe: number | null;
  sessionRpeSampleCount: number;
  avgSetRir: number | null;
  setRirSampleCount: number;
  /** Mean per-exercise RIR drift across the trailing window. Positive =
   *  sets felt closer to failure over time (fatigue accumulating). null =
   *  fewer than 2 exercises had enough RIR-logged exposures at non-
   *  decreasing weights for a signal. */
  rirDrift: number | null;
  rirDriftExerciseCount: number;
};

/**
 * Trailing-window averages of session-level effort (workouts.session_rpe)
 * and per-set proximity-to-failure (sets.rir) for a single client. Both
 * averages skip nulls — the new fields are optional captures, and we'd
 * rather show "—" with a low sample count than mislead with a partial
 * mean. Default window matches the practitioner-standard 4-week lookback.
 *
 * Three round-trips:
 *   1. workouts (id + session_rpe) since `since`
 *   2. exercise_logs for those workout ids
 *   3. sets.rir for those log ids
 * No per-client loop — exits early if the client has no workouts in window.
 */
export async function loadEffortWindow(
  clientId: string,
  windowDays = 28,
  at: Date = new Date(),
): Promise<EffortWindow> {
  const supa = db();
  const since = subDays(at, windowDays).toISOString();

  const { data: workouts } = await supa
    .from('workouts')
    .select('id, started_at, session_rpe')
    .eq('client_id', clientId)
    .not('completed_at', 'is', null)
    .gte('completed_at', since);

  const rpes: number[] = [];
  for (const w of workouts ?? []) {
    if (w.session_rpe != null) rpes.push(w.session_rpe);
  }

  const workoutById = new Map((workouts ?? []).map((w) => [w.id, w]));
  const workoutIds = (workouts ?? []).map((w) => w.id);
  const rirs: number[] = [];
  const rirExposuresByExercise = new Map<string, RirExposure[]>();

  if (workoutIds.length > 0) {
    const { data: logs } = await supa
      .from('exercise_logs')
      .select('id, exercise_id, workout_id')
      .in('workout_id', workoutIds);
    const logIds = (logs ?? []).map((l) => l.id);
    if (logIds.length > 0) {
      const { data: sets } = await supa
        .from('sets')
        .select('exercise_log_id, weight, reps, rir')
        .in('exercise_log_id', logIds);

      const setsByLog = new Map<
        string,
        Array<{ weight: number | null; reps: number | null; rir: number | null }>
      >();
      for (const s of sets ?? []) {
        if (s.rir != null) rirs.push(s.rir);
        const arr = setsByLog.get(s.exercise_log_id) ?? [];
        arr.push({
          weight: s.weight === null ? null : Number(s.weight),
          reps: s.reps,
          rir: s.rir,
        });
        setsByLog.set(s.exercise_log_id, arr);
      }
      for (const l of logs ?? []) {
        const w = workoutById.get(l.workout_id);
        if (!w) continue;
        const top = pickTopSetRir(setsByLog.get(l.id) ?? []);
        if (!top) continue;
        const exposures = rirExposuresByExercise.get(l.exercise_id) ?? [];
        exposures.push({
          workoutStartedAt: w.started_at,
          topWeight: top.topWeight,
          topRir: top.topRir,
        });
        rirExposuresByExercise.set(l.exercise_id, exposures);
      }
    }
  }

  const driftResult = computeClientRirDrift(
    [...rirExposuresByExercise.entries()].map(([exerciseId, exposures]) => ({
      exerciseId,
      exposures,
    })),
  );

  return {
    windowDays,
    avgSessionRpe: rpes.length
      ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10
      : null,
    sessionRpeSampleCount: rpes.length,
    avgSetRir: rirs.length
      ? Math.round((rirs.reduce((a, b) => a + b, 0) / rirs.length) * 10) / 10
      : null,
    setRirSampleCount: rirs.length,
    rirDrift:
      driftResult.drift != null
        ? Math.round(driftResult.drift * 10) / 10
        : null,
    rirDriftExerciseCount: driftResult.exerciseCount,
  };
}
