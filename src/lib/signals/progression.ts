/**
 * Layer 0 of the redesigned suggestion pipeline. Pure, server-and-client
 * safe. Builds a time-ordered per-exercise series with e1RM, volume-load,
 * and top-set RIR, and provides the MDC-aware stall detector that
 * replaces plateau.ts's strict weight>weight comparison.
 *
 * Noise model. Trained-lifter 1RM CV ≈ 3.3% (Grgic et al. 2020,
 * Sports Med Open 6:31; LoA ±4–5 kg bench, ±10–15 kg squat). A session
 * that fails to clear MDC = max(MDC_FLOOR_KG, MDC_PCT * prior_best_e1RM)
 * is within day-to-day variance and not a real improvement.
 *
 * e1RM. Epley's w*(1+reps/30). The formula is derived from low-rep
 * maxes and degrades past ~10–12 reps; sessions past
 * E1RM_MAX_REPS_FOR_CONFIDENCE are flagged 'low' and skipped by the
 * stall counter. They are still emitted in the series so downstream
 * (volume tracking, UI) can display them.
 *
 * Unit normalisation. Sets logged in lb are converted to kg up front so
 * all downstream math is single-unit. Null unit defaults to kg, matching
 * the existing in-app data convention.
 */
import {
  E1RM_MAX_REPS_FOR_CONFIDENCE,
  IMPLAUSIBLE_E1RM_JUMP_PCT,
  IMPLAUSIBLE_MIN_BASELINE,
  IMPLAUSIBLE_SUSTAIN_BUFFER,
  IMPLAUSIBLE_TRAILING_WINDOW,
  MDC_FLOOR_KG_MIN,
  MDC_LOAD_FRACTION,
  MDC_PCT,
} from '../config';

const LB_TO_KG = 0.45359237;

export type Unit = 'kg' | 'lb' | null;

export type SetMetric = {
  weight: number | null;
  reps: number | null;
  rir: number | null;
  unit: Unit;
};

export type SessionInput = {
  workoutId: string;
  workoutStartedAt: string;
  sets: SetMetric[];
};

/**
 * One pre-app exposure parsed from a coach's historical sheet. Mirrors
 * the schema of `historical_exposures` rows. RIR is never available for
 * historical data.
 */
export type HistoricalInput = {
  workoutId: string;
  workoutStartedAt: string;
  weight: number;
  unit: 'kg' | 'lb';
  reps: number;
};

export type SessionMetric = {
  workoutId: string;
  workoutStartedAt: string;
  topWeightKg: number;
  topReps: number;
  topSetRir: number | null;
  e1RM: number;
  e1RMConfidence: 'ok' | 'low' | 'implausible';
  volumeLoadKg: number;
};

/** Epley estimated 1RM. */
export function epleyE1RM(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

/** Whether reps fall in the band where Epley's e1RM is trustworthy. */
export function isHighConfidenceE1RM(reps: number): boolean {
  return reps >= 1 && reps <= E1RM_MAX_REPS_FOR_CONFIDENCE;
}

/**
 * Load-scaled minimal detectable change in e1RM, in kg. Takes a
 * reference e1RM AND the load that produced it (typically the prior-
 * best session's e1RM and topWeightKg) so the threshold scales sensibly
 * for both 200 kg compounds and 7 kg isolations.
 *
 *   MDC = max(FLOOR_MIN, PCT * referenceE1RM, LOAD_FRACTION * referenceLoadKg)
 */
export function mdcForSession(
  referenceE1RM: number,
  referenceLoadKg: number,
  opts?: { pct?: number; loadFraction?: number; floorMin?: number },
): number {
  const pct = opts?.pct ?? MDC_PCT;
  const loadFraction = opts?.loadFraction ?? MDC_LOAD_FRACTION;
  const floorMin = opts?.floorMin ?? MDC_FLOOR_KG_MIN;
  return Math.max(floorMin, pct * referenceE1RM, loadFraction * referenceLoadKg);
}

function toKg(weight: number, unit: Unit): number {
  return unit === 'lb' ? weight * LB_TO_KG : weight;
}

/**
 * Per-session aggregate. Picks the top set (max kg-weight, tiebreak on
 * reps), produces e1RM + volume-load, and carries the top set's RIR
 * forward. Returns null when no set has both weight and reps logged.
 */
export function buildSessionMetric(input: SessionInput): SessionMetric | null {
  let topWeightKg = -Infinity;
  let topReps = -Infinity;
  let topSetRir: number | null = null;
  let volumeLoadKg = 0;
  let any = false;
  for (const s of input.sets) {
    if (s.weight == null || s.reps == null) continue;
    any = true;
    const wKg = toKg(s.weight, s.unit);
    volumeLoadKg += wKg * s.reps;
    if (wKg > topWeightKg || (wKg === topWeightKg && s.reps > topReps)) {
      topWeightKg = wKg;
      topReps = s.reps;
      topSetRir = s.rir;
    }
  }
  if (!any) return null;
  return {
    workoutId: input.workoutId,
    workoutStartedAt: input.workoutStartedAt,
    topWeightKg,
    topReps,
    topSetRir,
    e1RM: epleyE1RM(topWeightKg, topReps),
    e1RMConfidence: isHighConfidenceE1RM(topReps) ? 'ok' : 'low',
    volumeLoadKg,
  };
}

/**
 * Historical row → SessionMetric. RIR is null (never captured in pre-app
 * data); volume-load is computed from the single recorded top set since
 * sheets only carry one weight × reps cell per week.
 */
export function buildHistoricalSessionMetric(h: HistoricalInput): SessionMetric {
  const wKg = toKg(h.weight, h.unit);
  return {
    workoutId: h.workoutId,
    workoutStartedAt: h.workoutStartedAt,
    topWeightKg: wKg,
    topReps: h.reps,
    topSetRir: null,
    e1RM: epleyE1RM(wKg, h.reps),
    e1RMConfidence: isHighConfidenceE1RM(h.reps) ? 'ok' : 'low',
    volumeLoadKg: wKg * h.reps,
  };
}

/**
 * Splice historical + logged sessions into a single time-ordered series.
 * Matches the prepend-historical pattern in suggestions.ts so plateau
 * math sees the full mesocycle for clients who transitioned mid-cycle.
 * Runs flagImplausibleSpikes at the end so consumers see e1RM-confidence
 * tags that already reflect the spike guard.
 */
export function buildProgressionSeries(input: {
  historical: HistoricalInput[];
  logged: SessionInput[];
}): SessionMetric[] {
  const out: SessionMetric[] = [];
  for (const h of input.historical) out.push(buildHistoricalSessionMetric(h));
  for (const l of input.logged) {
    const m = buildSessionMetric(l);
    if (m) out.push(m);
  }
  out.sort((a, b) => a.workoutStartedAt.localeCompare(b.workoutStartedAt));
  return flagImplausibleSpikes(out);
}

/**
 * Synthesize timestamps for historical_exposures rows so they fit BEFORE
 * the first app workout for the same exercise. Replaces the inline
 * projection in suggestions.ts:288-303, which silently dated historical
 * sessions past app data whenever programs.training_start_at was null
 * and uploaded_at was recent.
 *
 * Mechanism: anchor = programs.training_start_at ?? programs.uploaded_at
 * (existing semantics). If projecting from that anchor would land the
 * highest-week_index session at-or-after firstAppWorkoutAt, the entire
 * block is back-dated so the highest-week_index session lands exactly
 * one week before firstAppWorkoutAt; inter-week spacing is preserved.
 *
 * firstAppWorkoutAt is the per-exercise first app workout, not the
 * client's overall first workout — a client can have logged other
 * exercises before this one started showing up.
 *
 * When firstAppWorkoutAt is null (client has no app data for this
 * exercise yet) the anchor is used unchanged.
 */
export function synthesizeHistoricalTimestamps(
  rows: {
    exercise_name_key: string;
    week_index: number;
    weight: number;
    unit: 'kg' | 'lb';
    reps: number;
  }[],
  opts: { anchor: Date; firstAppWorkoutAt: Date | null },
): HistoricalInput[] {
  if (rows.length === 0) return [];
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const sorted = [...rows].sort((a, b) => a.week_index - b.week_index);
  const maxIdx = sorted[sorted.length - 1].week_index;

  let effectiveAnchorMs = opts.anchor.getTime();
  if (opts.firstAppWorkoutAt) {
    const capMs = opts.firstAppWorkoutAt.getTime() - maxIdx * WEEK_MS;
    if (effectiveAnchorMs > capMs) effectiveAnchorMs = capMs;
  }

  return sorted.map((h) => ({
    workoutId: `hist:${h.exercise_name_key}:${h.week_index}`,
    workoutStartedAt: new Date(
      effectiveAnchorMs + (h.week_index - 1) * WEEK_MS,
    ).toISOString(),
    weight: h.weight,
    unit: h.unit,
    reps: h.reps,
  }));
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
}

/**
 * Flag obvious unit-log / data-entry spikes. Returns a new array where
 * sessions whose e1RM jumps ≥(1 + IMPLAUSIBLE_E1RM_JUMP_PCT) over the
 * trailing median AND drop back to within IMPLAUSIBLE_SUSTAIN_BUFFER of
 * that median in the very next valid session are tagged 'implausible'.
 *
 * Conservative by design — only catches obvious one-off corruption, not
 * real PRs:
 *   - needs ≥IMPLAUSIBLE_MIN_BASELINE prior valid sessions for a baseline,
 *   - needs a follow-up session (most recent session is never flagged),
 *   - looks only at the NEXT valid session for the sustain check (a
 *     genuine PR sustains; a fat-finger reverts).
 *
 * Idempotent — re-running it on an already-flagged series is a no-op
 * because flagged sessions are skipped from baseline.
 */
export function flagImplausibleSpikes(
  series: SessionMetric[],
  opts?: {
    jumpPct?: number;
    sustainBuffer?: number;
    windowSize?: number;
    minBaseline?: number;
  },
): SessionMetric[] {
  const jumpPct = opts?.jumpPct ?? IMPLAUSIBLE_E1RM_JUMP_PCT;
  const sustainBuffer = opts?.sustainBuffer ?? IMPLAUSIBLE_SUSTAIN_BUFFER;
  const windowSize = opts?.windowSize ?? IMPLAUSIBLE_TRAILING_WINDOW;
  const minBaseline = opts?.minBaseline ?? IMPLAUSIBLE_MIN_BASELINE;

  const result = series.map((m) => ({ ...m }));
  for (let i = 0; i < result.length; i++) {
    if (result[i].e1RMConfidence !== 'ok') continue;

    // Trailing window of 'ok' sessions before i (skips already-flagged).
    const trailing: number[] = [];
    for (let j = i - 1; j >= 0 && trailing.length < windowSize; j--) {
      if (result[j].e1RMConfidence === 'ok') trailing.push(result[j].e1RM);
    }
    if (trailing.length < minBaseline) continue;

    const baseline = median(trailing);
    if (result[i].e1RM < baseline * (1 + jumpPct)) continue;

    // Find next 'ok' session for the sustain check.
    let nextE1RM: number | null = null;
    for (let j = i + 1; j < result.length; j++) {
      if (result[j].e1RMConfidence === 'ok') {
        nextE1RM = result[j].e1RM;
        break;
      }
    }
    if (nextE1RM === null) continue; // no follow-up — lean conservative
    if (nextE1RM > baseline * (1 + sustainBuffer)) continue; // sustained

    result[i].e1RMConfidence = 'implausible';
  }
  return result;
}

/**
 * MDC-aware stall counter. Walks the series in time order keeping the
 * running prior-best e1RM among high-confidence sessions; a session
 * "improves" only when its e1RM exceeds prior best by MORE than MDC at
 * that performance level. Returns the count of trailing sessions that
 * did not improve.
 *
 * Low-confidence sessions (reps > E1RM_MAX_REPS_FOR_CONFIDENCE) are
 * filtered out entirely — they neither set a prior best nor count toward
 * the streak. The first valid session has no prior best and is treated
 * as stalled (preserves the existing convention that a series of length
 * one returns 1).
 */
export function countConsecutiveStalledByMdc(
  series: SessionMetric[],
  opts?: { pct?: number; loadFraction?: number; floorMin?: number },
): number {
  const valid = series.filter((m) => m.e1RMConfidence === 'ok');
  if (valid.length === 0) return 0;

  // Track the full prior-best session (not just e1RM) so we can pass its
  // load into mdcForSession.
  const priorBest: (SessionMetric | null)[] = new Array(valid.length);
  priorBest[0] = null;
  for (let i = 1; i < valid.length; i++) {
    const last = priorBest[i - 1];
    const prev = valid[i - 1];
    priorBest[i] = !last || prev.e1RM > last.e1RM ? prev : last;
  }

  let stalled = 0;
  for (let i = valid.length - 1; i >= 0; i--) {
    const best = priorBest[i];
    if (!best) {
      stalled++;
      break;
    }
    const mdc = mdcForSession(best.e1RM, best.topWeightKg, opts);
    const improved = valid[i].e1RM - best.e1RM > mdc;
    if (improved) break;
    stalled++;
  }
  return stalled;
}
