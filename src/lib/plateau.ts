/**
 * Pure plateau-detection logic, ported from gym_tracker_v7.6.gs
 * (getExerciseExposureHistory_ + countRecentStalledExposures_).
 *
 * One "exposure" = one workout in which the exercise was logged. Per
 * exposure we keep the best set (max weight, tiebreak max reps), then
 * count how many trailing exposures failed to strictly improve over
 * the prior best.
 */

export type SetRow = {
  weight: number | null;
  reps: number | null;
};

export type ExerciseLogRow = {
  workoutId: string;
  workoutStartedAt: string;
  sets: SetRow[];
};

export type Exposure = {
  weight: number;
  reps: number;
  workoutId: string;
  workoutStartedAt: string;
};

export type Stage = 'none' | 'watch' | 'adjust' | 'swap_candidate';

export function buildExposureHistory(logs: ExerciseLogRow[]): Exposure[] {
  const exposures: Exposure[] = [];
  for (const log of logs) {
    let bestW = -Infinity;
    let bestR = -Infinity;
    let any = false;
    for (const s of log.sets) {
      if (s.weight === null || s.reps === null) continue;
      any = true;
      if (s.weight > bestW || (s.weight === bestW && s.reps > bestR)) {
        bestW = s.weight;
        bestR = s.reps;
      }
    }
    if (!any) continue;
    exposures.push({
      weight: bestW,
      reps: bestR,
      workoutId: log.workoutId,
      workoutStartedAt: log.workoutStartedAt,
    });
  }
  exposures.sort((a, b) => a.workoutStartedAt.localeCompare(b.workoutStartedAt));
  return exposures;
}

export function countConsecutiveStalled(history: Exposure[]): number {
  if (history.length === 0) return 0;
  if (history.length === 1) return 1;

  const priorBest: { weight: number; reps: number }[] = new Array(history.length);
  priorBest[0] = { weight: -Infinity, reps: -Infinity };
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const last = priorBest[i - 1];
    let bw = last.weight;
    let br = last.reps;
    if (prev.weight > bw) {
      bw = prev.weight;
      br = prev.reps;
    } else if (prev.weight === bw && prev.reps > br) {
      br = prev.reps;
    }
    priorBest[i] = { weight: bw, reps: br };
  }

  let stalled = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cur = history[i];
    const best = priorBest[i];
    let improved = false;
    if (best.weight !== -Infinity) {
      improved =
        cur.weight > best.weight ||
        (cur.weight === best.weight && cur.reps > best.reps);
    }
    if (improved) break;
    stalled++;
  }
  return stalled;
}

export function stageFor(consecutiveStalled: number): Stage {
  if (consecutiveStalled >= 8) return 'swap_candidate';
  if (consecutiveStalled >= 6) return 'adjust';
  if (consecutiveStalled >= 4) return 'watch';
  return 'none';
}

const STAGE_RANK: Record<Stage, number> = {
  none: 0,
  watch: 1,
  adjust: 2,
  swap_candidate: 3,
};

export function isEscalation(prev: Stage, next: Stage): boolean {
  return STAGE_RANK[next] > STAGE_RANK[prev];
}
