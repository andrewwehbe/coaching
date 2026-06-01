/**
 * Pure program-update recommender. Implements the gated decision tree from
 * Appendix A of the research brief (see docs/superpowers/research/...).
 *
 *   Gate 0  adherence (data validity)
 *   Gate 1  pain (safety — co-emits as forced swaps)
 *   Gate 2  deload (pre-empts plateau interpretation)
 *   Gate 3  bodyweight × strength
 *   Gate 4  phase transition (end of block, no deload signals)
 *   Gate 5  plateau (5a day-level, 5b systemic, 5c isolated swap)
 *   Gate 6  split rotation (lowest priority, NOT a plateau fix)
 *
 * The function is intentionally pure: all data fetching happens in the
 * server gatherer (lib/recommend-for-client.ts). All numeric thresholds
 * are imported from lib/config and exposed via the rationale array so the
 * coach can see WHY a recommendation fired.
 *
 * IMPORTANT — every threshold here is practitioner-heuristic, NOT
 * RCT-derived. The brief documents this. Surface that caveat in the UI.
 *
 * Server-and-client safe — no node-only imports.
 */
import {
  ADHERENCE_GATE_RATIO,
  BLOCK_LENGTH_BY_AGE,
  BLOCK_LENGTH_DEFAULT,
  BW_AGGRESSIVE_LOSS_PCT_PER_WEEK,
  BW_DEFICIT_SLOPE_PCT_PER_WEEK,
  DAY_LEVEL_STALL_COUNT,
  PAIN_INCIDENT_THRESHOLD,
  SPLIT_ROTATION_CADENCE_WEEKS,
  SYSTEMIC_STALL_DAY_COUNT,
  swapMinProgramWeekFor,
  type TrainingAge,
} from './config';
import type { AdherenceSignal } from './signals/adherence';
import type { FatigueSignal } from './signals/fatigue';

export type PrimaryGoal = 'hypertrophy' | 'strength' | 'fat_loss' | 'general';

export type StrengthTrend = 'up' | 'flat' | 'down' | 'insufficient';

export type RecommendationType =
  | 'hold'
  | 'refer_adherence'
  | 'trigger_deload'
  | 'refer_recovery'
  | 'phase_transition'
  | 'exercise_reorder'
  | 'rotate_day'
  | 'volume_adjust'
  | 'intensity_adjust'
  | 'single_exercise_swap'
  | 'refer_technique_or_loading'
  | 'split_rotation';

export type PainType = 'joint' | 'tendon' | 'muscle';

export type ForcedSwap = {
  exerciseId: string;
  exerciseName: string;
  reason: 'joint_pain' | 'tendon_pain' | 'recurring_pain_untyped';
};

export type MuscleGroup =
  | 'chest'
  | 'back'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'calves'
  | 'abs'
  | 'other';

export type StallSignal = {
  exerciseId: string;
  exerciseName: string;
  dayId: string;
  dayLabel: string;
  programWeek: number;
  /** Whether at least one OTHER exercise on the same day is progressing.
   *  True → the stall is isolated (likely swap candidate). False → may be
   *  a recovery/order issue. */
  othersOnDayProgressing: boolean;
  /** Primary muscle worked, when the exercise has been tagged. Drives
   *  Gate 5b targeting ("drop a set on quads" vs. generic). null when
   *  the program editor hasn't been used to assign a muscle yet. */
  muscleGroup: MuscleGroup | null;
  /** Stage-4.5: the PlateauStage that the signals/plateau classifier
   *  emitted for this exercise this week. Always one of
   *  'watch' | 'progress' | 'swap_candidate' (the structural-action
   *  stages). Forward-compat info for finer Gate 5 decisions; the
   *  current recommender still reads only stallSignals.length and
   *  othersOnDayProgressing. Optional so prior callers/test fixtures
   *  that omit it still type-check. */
  stage?: 'watch' | 'progress' | 'swap_candidate';
};

export type PainEvent = {
  exerciseId: string;
  exerciseName: string;
  incidentCountInWindow: number;
  /** Highest-severity pain type reported in the window: joint > tendon >
   *  muscle. null = no incident was typed (legacy reports), treated under
   *  the conservative joint rule. */
  worstPainType: PainType | null;
};

export type RecommenderInput = {
  trainingAge: TrainingAge | null;
  primaryGoal: PrimaryGoal | null;

  /** Computed by signals/adherence.computeAdherence — single source of
   *  truth shared with suggestions.ts. */
  adherenceSignal: AdherenceSignal;

  /** Program-week context from lib/program-week. */
  weekInProgram: number;
  weeksSinceLastDeload: number | null;

  /** Pain incidents per exercise within PAIN_INCIDENT_WINDOW_DAYS. */
  painEvents: PainEvent[];

  /** Bodyweight slope as %/week over a recent window. null = insufficient
   *  check-in data to compute. */
  bodyWeightSlopePctPerWeek: number | null;
  strengthTrend: StrengthTrend;

  /** Aggregated stall analysis from lib/plateau. */
  stallSignals: StallSignal[];

  /** Computed by signals/fatigue.evaluateFatigueTriggers — single source
   *  of truth shared with suggestions.ts. Replaces the per-signal fields
   *  (rirDriftAcrossBlock, fractionPrimaryLiftsStalled,
   *  newPainExerciseCount) used by the deleted countDeloadSignals. */
  fatigueSignal: FatigueSignal;

  /** How long the client has been on the current split. Drives Gate 6. */
  weeksOnCurrentSplit: number;
};

export type Recommendation = {
  type: RecommendationType;
  title: string;
  body: string;
  forcedSwaps: ForcedSwap[];
  /** Ordered trace of which gate fired and why. The UI surfaces this so the
   *  coach can audit the decision rather than treating it as black-box. */
  rationale: string[];
  /** Inputs that would sharpen the answer but were unavailable. Surfaced
   *  alongside the recommendation so the coach knows the model's blind
   *  spots (e.g. "no pain type captured — treating all pain as joint"). */
  dataGaps: string[];
};

/** Pure: derive forced swaps from recurring pain. Independent of any other
 *  gate because pain is safety, not optimization — co-emits with whatever
 *  the rest of the tree decides.
 *
 *  Per the research brief Q5:
 *    - joint  → 2 incidents on same exercise in window → forced swap
 *    - tendon → 2 incidents → forced swap (we approximate the "rising or
 *               not settling" rule with the same count threshold until
 *               we capture severity per incident)
 *    - muscle → never auto-swap (DOMS is a normal response)
 *    - null   → treated as joint (conservative — better safe than sorry
 *               for legacy/untyped reports)
 *
 *  Exported for tests. */
export function deriveForcedSwaps(painEvents: PainEvent[]): ForcedSwap[] {
  const out: ForcedSwap[] = [];
  for (const p of painEvents) {
    if (p.incidentCountInWindow < PAIN_INCIDENT_THRESHOLD) continue;
    if (p.worstPainType === 'muscle') continue;
    const reason: ForcedSwap['reason'] =
      p.worstPainType === 'tendon'
        ? 'tendon_pain'
        : p.worstPainType === 'joint'
          ? 'joint_pain'
          : 'recurring_pain_untyped';
    out.push({
      exerciseId: p.exerciseId,
      exerciseName: p.exerciseName,
      reason,
    });
  }
  return out;
}

function defaultDataGaps(input: RecommenderInput): string[] {
  const gaps: string[] = [];
  if (!input.fatigueSignal.rirDrift.available) {
    gaps.push(
      'RIR drift not yet computable — client needs ≥2 weeks of RIR-logged sets at fixed loads.',
    );
  }
  if (
    input.painEvents.some(
      (p) => p.incidentCountInWindow > 0 && p.worstPainType == null,
    )
  ) {
    gaps.push(
      'Some pain reports lack a pain type — applying the conservative joint-pain rule to those incidents.',
    );
  }
  if (input.bodyWeightSlopePctPerWeek == null) {
    gaps.push(
      'Bodyweight slope unavailable — needs ≥2 check-ins in the recent window for the BW × strength gate to fire.',
    );
  }
  if (input.trainingAge == null) {
    gaps.push('Client training_age not set — defaulting to intermediate thresholds.');
  }
  if (input.primaryGoal == null) {
    gaps.push('Client primary_goal not set — defaulting to hypertrophy interpretation.');
  }
  // Systemic stall branch is generic until exercises carry a muscle_group tag.
  if (input.stallSignals.length > 0) {
    gaps.push(
      'Exercises do not yet carry muscle-group tags — volume/intensity adjustments are generic, not per-muscle.',
    );
  }
  return gaps;
}

/** The decision tree. Returns exactly one primary recommendation per call,
 *  per the "one change per cycle" rule (Q8 of the brief), with forced
 *  pain-swaps co-emitted alongside. */
export function decideRecommendation(input: RecommenderInput): Recommendation {
  const rationale: string[] = [];
  const gaps = defaultDataGaps(input);
  const forcedSwaps = deriveForcedSwaps(input.painEvents);
  if (forcedSwaps.length > 0) {
    rationale.push(
      `Forced swap(s): ${forcedSwaps.length} exercise(s) with ≥${PAIN_INCIDENT_THRESHOLD} pain incidents in window.`,
    );
  }

  const adherence = input.adherenceSignal.ratio;
  const adherencePct = Math.round(adherence * 100);
  const gateRatioPct = Math.round(input.adherenceSignal.gateRatio * 100);

  // ---- Gate 0: adherence (single-threshold behavioral gate) ----
  // The two-band (low / mid) refer-adherence logic and the "consider
  // reducing the program" body were both removed in the Stage-1 redesign:
  // missed sessions are an adherence problem, not evidence the program
  // is too big. The body is now purely behavioral.
  if (input.adherenceSignal.isLow) {
    rationale.push(`Gate 0: adherence ${adherencePct}% < ${gateRatioPct}%.`);
    const missing = input.adherenceSignal.missingDayLabels;
    const missingClause =
      missing.length > 0
        ? ` Days not trained in the last ${input.adherenceSignal.lookbackWeeks} weeks: ${missing.join(', ')}.`
        : '';
    return {
      type: 'refer_adherence',
      title: 'Adherence below threshold',
      body:
        `Adherence ${adherencePct}% (${input.adherenceSignal.daysCompletedInWindow}/${input.adherenceSignal.daysExpectedInWindow} sessions over the last ${input.adherenceSignal.lookbackWeeks} weeks).` +
        missingClause +
        ' Surface the scheduling/motivation barrier with the client — what is blocking the missed sessions, and can they make them up. Plateau-driven recommendations are suppressed until adherence recovers; pain alerts still apply. Do NOT change the program for adherence.',
      forcedSwaps,
      rationale,
      dataGaps: gaps,
    };
  }
  const plateauLogicEnabled = true;

  // ---- Gate 2: deload (pre-empts plateau interpretation) ----
  // Reads input.fatigueSignal — computed by signals/fatigue and shared
  // with suggestions.ts so both surfaces agree on shouldDeload.
  if (input.fatigueSignal.shouldDeload) {
    rationale.push(
      `Gate 2: fatigue triggers fired (${input.fatigueSignal.firedTriggers.join(', ')}).`,
    );
    return {
      type: 'trigger_deload',
      title: 'Trigger deload',
      body:
        'Fatigue signals are coinciding. Cut volume by ~40–60% this week while keeping ' +
        'intensity (load × RIR target) close to normal — fewer sets, not lighter weights ' +
        '(Coleman 2024: complete-cessation deloads can slightly hurt strength). Hold all ' +
        'other program changes until next block; you cannot diagnose a plateau through ' +
        'accumulated fatigue.',
      forcedSwaps,
      rationale,
      dataGaps: gaps,
    };
  }

  // ---- Gate 3: bodyweight × strength ----
  if (input.bodyWeightSlopePctPerWeek != null) {
    const slope = input.bodyWeightSlopePctPerWeek;
    const downStrength =
      input.strengthTrend === 'down' || input.strengthTrend === 'flat';

    if (downStrength && slope <= BW_DEFICIT_SLOPE_PCT_PER_WEEK) {
      rationale.push(
        `Gate 3: strength ${input.strengthTrend}, BW slope ${slope.toFixed(2)}%/wk ≤ ${BW_DEFICIT_SLOPE_PCT_PER_WEEK}%/wk (deficit).`,
      );
      const tooAggressive = slope <= BW_AGGRESSIVE_LOSS_PCT_PER_WEEK;
      if (input.primaryGoal === 'fat_loss' && !tooAggressive) {
        return {
          type: 'hold',
          title: 'Hold — stall expected in deficit',
          body:
            'Strength is flat-or-down while bodyweight is dropping at an appropriate fat-loss rate. ' +
            'This is the expected pattern; do not change the program. Suppressing swap/volume/intensity ' +
            'recommendations.',
          forcedSwaps,
          rationale,
          dataGaps: gaps,
        };
      }
      return {
        type: 'refer_recovery',
        title: 'Refer recovery / nutrition',
        body:
          tooAggressive
            ? `Bodyweight is dropping at ${slope.toFixed(2)}%/wk — too aggressive a deficit. ` +
              'Accelerated loss erodes strength and adherence. Talk nutrition before touching the program.'
            : 'Strength stall is explained by the energy deficit, not by programming. Address ' +
              'recovery/nutrition before changing the program.',
        forcedSwaps,
        rationale,
        dataGaps: gaps,
      };
    }
    if (input.strengthTrend === 'down' && slope >= 0) {
      rationale.push(
        `Gate 3: strength down but BW slope ${slope.toFixed(2)}%/wk ≥ 0 — under-recovery red flag.`,
      );
      return {
        type: 'refer_recovery',
        title: 'Refer recovery',
        body:
          'Strength is down while bodyweight is stable or rising. Suggests under-recovery, poor ' +
          'session quality, or measurement/technique drift. Check sleep, adherence, and form before ' +
          'changing the program.',
        forcedSwaps,
        rationale,
        dataGaps: gaps,
      };
    }
  }

  // ---- Gate 4: phase transition ----
  const blockLen = input.trainingAge
    ? BLOCK_LENGTH_BY_AGE[input.trainingAge]
    : BLOCK_LENGTH_DEFAULT;
  if (
    input.weeksSinceLastDeload != null &&
    input.weeksSinceLastDeload >= blockLen &&
    !input.fatigueSignal.shouldDeload
  ) {
    rationale.push(
      `Gate 4: weeks_since_deload ${input.weeksSinceLastDeload} ≥ block length ${blockLen} but no fatigue triggers firing.`,
    );
    return {
      type: 'phase_transition',
      title: 'End of accumulation block',
      body:
        `The client has been progressing for ${input.weeksSinceLastDeload} weeks without a deload, ` +
        `at the end of the typical ${blockLen}-week accumulation block. Plan the next block: shift ` +
        'rep ranges, swap a primary lift or two, or move from accumulation to intensification.',
      forcedSwaps,
      rationale,
      dataGaps: gaps,
    };
  }

  // ---- Gate 5: plateau interpretation ----
  // Under Stage 1, low adherence already returned refer_adherence at
  // Gate 0 — there is no "mid band" suppression here anymore. The
  // plateauLogicEnabled flag is always true at this point and was
  // removed.
  // Diverges from the Appendix A pseudocode, which returned HOLD here on
  // an empty stall list. That ordering would mask Gate 6 (split rotation),
  // which is a variety/staleness cue not predicated on stalls — so we
  // defer the no-stalls HOLD until Gate 6 has had a chance to fire.
  const noStalls = input.stallSignals.length === 0;
  if (noStalls && input.weeksOnCurrentSplit < SPLIT_ROTATION_CADENCE_WEEKS) {
    rationale.push('Gate 5: no stalls detected.');
    return {
      type: 'hold',
      title: 'Hold',
      body: 'No stalls, no pain pile-up, no deload signals. Keep progressing.',
      forcedSwaps,
      rationale,
      dataGaps: gaps,
    };
  }

  // 5a: day-level stall (≥2 stalled exercises on the same day).
  const stallsByDay = new Map<string, StallSignal[]>();
  for (const s of input.stallSignals) {
    const arr = stallsByDay.get(s.dayId) ?? [];
    arr.push(s);
    stallsByDay.set(s.dayId, arr);
  }
  for (const [, arr] of stallsByDay) {
    if (arr.length >= DAY_LEVEL_STALL_COUNT) {
      const dayLabel = arr[0].dayLabel;
      rationale.push(
        `Gate 5a: ${arr.length} stalled exercises on day "${dayLabel}" — structural, not exercise-level.`,
      );
      return {
        type: 'exercise_reorder',
        title: `Reorder day: ${dayLabel}`,
        body:
          `${arr.length} compounds on "${dayLabel}" are stalled together. Move the highest-priority ` +
          'stalled lift to the front of the session and retry one block before considering a full ' +
          'rotation of that day.',
        forcedSwaps,
        rationale,
        dataGaps: gaps,
      };
    }
  }

  // 5b: systemic stall (breadth ≥ SYSTEMIC_STALL_DAY_COUNT distinct days).
  if (stallsByDay.size >= SYSTEMIC_STALL_DAY_COUNT) {
    // Find the muscle group with the most stalled exercises. Ignore 'other'
    // and untagged — they don't represent a single targetable muscle.
    const stallsByMuscle = new Map<MuscleGroup, number>();
    for (const s of input.stallSignals) {
      if (!s.muscleGroup || s.muscleGroup === 'other') continue;
      stallsByMuscle.set(s.muscleGroup, (stallsByMuscle.get(s.muscleGroup) ?? 0) + 1);
    }
    let worstMuscle: MuscleGroup | null = null;
    let worstCount = 0;
    for (const [muscle, count] of stallsByMuscle) {
      if (count > worstCount) {
        worstMuscle = muscle;
        worstCount = count;
      }
    }

    if (worstMuscle != null && worstCount >= 2) {
      rationale.push(
        `Gate 5b: stalls spread across ${stallsByDay.size} days; worst muscle = "${worstMuscle}" (${worstCount} stalled exercises).`,
      );
      return {
        type: 'volume_adjust',
        title: `Volume adjustment — ${worstMuscle}`,
        body:
          `${worstCount} ${worstMuscle} exercises are stalled across ${stallsByDay.size} different ` +
          'training days. Bias the adjustment toward this muscle: drop a working set per exercise, ' +
          'or — if volume is already near MAV — shift the next block to lower-RIR/heavier loading.',
        forcedSwaps,
        rationale,
        dataGaps: gaps,
      };
    }

    rationale.push(
      `Gate 5b: stalls spread across ${stallsByDay.size} days but no single muscle dominates (or muscle tags missing).`,
    );
    return {
      type: 'volume_adjust',
      title: 'Volume adjustment',
      body:
        `Stalls are distributed across ${stallsByDay.size} training days. Drop a set per primary ` +
        'lift across the block, or add intensity if volume is already at MAV. Tag exercises with ' +
        'muscle groups in the program editor for per-muscle targeting next cycle.',
      forcedSwaps,
      rationale,
      dataGaps: gaps,
    };
  }

  // 5c: isolated stall — single-exercise swap candidate, gated by training_age.
  const swapMin = swapMinProgramWeekFor(input.trainingAge);
  for (const s of input.stallSignals) {
    if (!s.othersOnDayProgressing) continue;
    if (input.trainingAge === 'novice') {
      rationale.push(
        `Gate 5c: novice stall on "${s.exerciseName}" — route to technique/loading, never swap.`,
      );
      return {
        type: 'refer_technique_or_loading',
        title: `Check technique / loading — ${s.exerciseName}`,
        body:
          'Novice stalls are almost always a loading or technique issue, not an exercise problem. ' +
          'Verify the prescribed jump matches the client and review form before suggesting a swap.',
        forcedSwaps,
        rationale,
        dataGaps: gaps,
      };
    }
    if (s.programWeek >= swapMin) {
      rationale.push(
        `Gate 5c: isolated stall on "${s.exerciseName}" at week ${s.programWeek} ≥ ${swapMin === Number.POSITIVE_INFINITY ? '∞' : swapMin}.`,
      );
      return {
        type: 'single_exercise_swap',
        title: `Swap candidate: ${s.exerciseName}`,
        body:
          `"${s.exerciseName}" has stalled while other exercises on the same day are still ` +
          'progressing. Replace it with a lateral variant (same movement pattern and loading ' +
          'profile). Skip anything on the client\'s blacklist.',
        forcedSwaps,
        rationale,
        dataGaps: gaps,
      };
    }
    rationale.push(
      `Gate 5c: isolated stall on "${s.exerciseName}" at week ${s.programWeek} < ${swapMin} — too early to swap.`,
    );
    return {
      type: 'hold',
      title: 'Hold — too early to swap',
      body:
        `"${s.exerciseName}" has stalled but the client is only ${s.programWeek} weeks into the ` +
        `program; ${swapMin}+ weeks is the gate for swap candidates at this training age. Keep ` +
        'progressing — a stall this early is usually loading-noise.',
      forcedSwaps,
      rationale,
      dataGaps: gaps,
    };
  }

  // ---- Gate 6: split rotation (lowest priority) ----
  if (input.weeksOnCurrentSplit >= SPLIT_ROTATION_CADENCE_WEEKS) {
    rationale.push(
      `Gate 6: weeks_on_split ${input.weeksOnCurrentSplit} ≥ ${SPLIT_ROTATION_CADENCE_WEEKS} cadence.`,
    );
    return {
      type: 'split_rotation',
      title: 'Consider split rotation (variety)',
      body:
        'The client has been on the current split long enough that rotation makes sense for ' +
        'variety / staleness — NOT as a fix for any plateau (the evidence is that split choice is ' +
        'a delivery mechanism for volume, not an adaptation driver). Choose a split that fits the ' +
        'current schedule first.',
      forcedSwaps,
      rationale,
      dataGaps: gaps,
    };
  }

  rationale.push('No gate fired; stalls exist but are confined to exercises whose neighbors also stalled.');
  return {
    type: 'hold',
    title: 'Hold',
    body:
      'Stalls exist but the pattern does not match any gate. Investigate manually before changing ' +
      'the program.',
    forcedSwaps,
    rationale,
    dataGaps: gaps,
  };
}
