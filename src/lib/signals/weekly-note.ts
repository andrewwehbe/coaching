/**
 * Stage 5 — buildWeeklyCoachingNote.
 *
 * Always-non-null catch-all that produces ONE client-facing coaching
 * message per (client, week). Fired by weekly-report.ts ONLY when no
 * structural suggestion fires for the client this week — disjoint by
 * call-site from the per-exercise suggestion path in suggestions.ts.
 *
 * Channel boundary (Stage 5):
 *   The cron's 'effort_gap' alert was retired in this same stage —
 *   high_rir_stall is now weekly-note-owned. The cron stays narrowed
 *   to time-sensitive 'stalled' alerts (coach-facing). The weekly
 *   note is the sole effort-gap surface.
 *
 * Priority order (highest to lowest, first non-null wins):
 *   1. PR celebration       — best_efforts updated this week.
 *   2. Effort-gap observation — top-set RIR persistently above target.
 *   3. This-week's RIR target — forward-looking coaching on a primary lift.
 *   4. Accessory tweak      — untagged exercise → coach-facing nudge.
 *   5. Hold-steady          — unconditional catch-all (the always-non-null payoff).
 *
 * The function is PURE — all signal selection happens at the caller in
 * weekly-report.ts. Each tier's input is either present or null; the
 * function picks the first tier whose input is non-null. This keeps
 * the priority logic auditable and the data-gathering decoupled.
 *
 * Why always-non-null:
 *   A clean "hold steady" week must still produce ONE client-facing
 *   coaching message — never silence. Silence on a healthy week reads
 *   as the coach disengaging, which is the retention failure mode the
 *   feels-coached design exists to prevent.
 */

import { RIR_EFFORT_GAP_THRESHOLD } from '../config';
import type { Suggestion } from '../suggestions';
import type { WeeklyNoteTemplate } from './client-context';

export type PRObservation = {
  exerciseName: string;
  weight: number;
  unit: 'kg' | 'lb';
  reps: number;
};

export type EffortGapObservation = {
  exerciseName: string;
  meanTopSetRir: number;
  /** The upper bound of the prescribed RIR target — "leave LESS gas
   *  in the tank than this" framing. */
  targetMax: number;
};

export type RirTargetObservation = {
  exerciseName: string;
  rirMin: number;
  rirMax: number;
  goal: 'strength' | 'hypertrophy' | 'mixed';
};

export type AccessoryTweakObservation = {
  exerciseName: string;
};

export type WeeklyCoachingNoteInput = {
  clientId: string;
  /** Optional — when omitted the body uses generic phrasing. */
  clientName?: string;
  /** Stage 6 Piece 3 tier 0 — present when getActiveClientContext
   *  returned a context with a non-null weeklyNoteTemplate (onboarding,
   *  health, at_risk). When set, the context-aware framing wins ABOVE
   *  PR celebration; the standard 5 tiers don't run. */
  contextTemplate: WeeklyNoteTemplate | null;
  topPR: PRObservation | null;
  effortGap: EffortGapObservation | null;
  primaryRirTarget: RirTargetObservation | null;
  untaggedExercise: AccessoryTweakObservation | null;
  /** 0..1 — used by the hold-steady catch-all so the message can
   *  acknowledge what's actually true about the week. */
  adherenceRatio: number;
};

function note(clientId: string, title: string, body: string): Suggestion {
  return {
    id: `weekly_note:${clientId}`,
    type: 'weekly_note',
    title,
    body,
    apply: null,
  };
}

/**
 * Stage 5 v2 — per-exercise effort-gap candidate computation.
 *
 * The classifier (classifyExercisePlateau) produces meanTopSetRir for
 * every exercise that has RIR-logged sets in the recent window. This
 * helper takes that scalar + the dynamically prescribed target's MAX
 * RIR and decides whether the gap is wide enough to surface in the
 * weekly note. The threshold is RIR_EFFORT_GAP_THRESHOLD (2 RIR above
 * target) — softer than the classifier's high_rir_stall branch (which
 * needs the absolute mean ≥ HIGH_RIR_THRESHOLD AND a plateau).
 *
 * Returns null when no candidate (no RIR data or gap below threshold).
 * Pure — caller pulls meanTopSetRir from PlateauResult and prescribedMax
 * from prescribeRir(...).max.
 */
export type EffortGapCandidate = {
  exerciseName: string;
  meanTopSetRir: number;
  targetMax: number;
  gap: number;
};

export function computeEffortGapCandidate(input: {
  exerciseName: string;
  meanTopSetRir: number | null;
  prescribedTargetMax: number;
}): EffortGapCandidate | null {
  if (input.meanTopSetRir == null) return null;
  const gap = input.meanTopSetRir - input.prescribedTargetMax;
  if (gap < RIR_EFFORT_GAP_THRESHOLD) return null;
  return {
    exerciseName: input.exerciseName,
    meanTopSetRir: input.meanTopSetRir,
    targetMax: input.prescribedTargetMax,
    gap,
  };
}

/**
 * Pick the highest-gap candidate from a list, or null if empty.
 * Pure max-by-gap reduction — exported so the per-client tail in
 * suggestions.ts can call it directly. The decision is "noisiest
 * effort-gap wins this week's coaching slot."
 */
export function selectBestEffortGap(
  candidates: EffortGapCandidate[],
): EffortGapCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) => (cur.gap > best.gap ? cur : best));
}

export function buildWeeklyCoachingNote(
  input: WeeklyCoachingNoteInput,
): Suggestion {
  // Tier 0 — context-aware framing. Wins over EVERY other tier when an
  // active context provides a template. The coach has already explained
  // this client's situation; the weekly note must speak to that, not
  // ignore it. Three templates from the directive matrix in Piece 1:
  //   getting_started — onboarding (synthesized or persisted)
  //   ease_back_in    — health hold; client returning from illness
  //   re_engagement   — at_risk; client disengaging, coach watching
  if (input.contextTemplate) {
    switch (input.contextTemplate) {
      case 'getting_started':
        return note(
          input.clientId,
          'Getting started',
          "Welcome aboard. We're in the first couple of weeks together — the focus is showing up, learning the lifts, and getting comfortable with the format. The numbers will come; right now we're just building the habit. Log a session whenever you can and message me anything that's unclear.",
        );
      case 'ease_back_in':
        return note(
          input.clientId,
          'Easing back in',
          "Welcome back. First sessions after a break should feel light on purpose — start at about 70-80% of what you were lifting, two clean sets per exercise, and we'll ramp back to full volume over the next 2-3 weeks. The weights you used to hit are still in there; don't try to find them all in week one.",
        );
      case 're_engagement':
        return note(
          input.clientId,
          'Let\'s reset',
          "I've noticed it's been hard to get to the gym lately and that's okay — life happens. I'd rather we find one session this week than aim for four and miss them all. What's the smallest version of training that fits your week right now? Reply and we'll work backwards from there.",
        );
    }
  }

  // Tier 1 — PR celebration.
  if (input.topPR) {
    const { exerciseName, weight, unit, reps } = input.topPR;
    return note(
      input.clientId,
      `PR week — ${exerciseName}`,
      `New best on ${exerciseName}: ${weight} ${unit} × ${reps}. Hold the load next session and chase the rep — once you clear the top of the range, the load goes up.`,
    );
  }

  // Tier 2 — effort-gap observation. Soft signal: top-set RIR has been
  // sitting above target, but not enough to trigger the classifier's
  // high_rir_stall (which would have fired a per-exercise suggestion
  // and stopped the weekly note from running).
  if (input.effortGap) {
    const { exerciseName, meanTopSetRir, targetMax } = input.effortGap;
    return note(
      input.clientId,
      `Push closer to target — ${exerciseName}`,
      `Recent sets on ${exerciseName} have averaged about RIR ${meanTopSetRir.toFixed(1)} on the top set — target is ≤${targetMax}. Leave less in the tank next session. The exercise isn't the problem; the effort is.`,
    );
  }

  // Tier 3 — this-week's RIR target on a primary lift.
  if (input.primaryRirTarget) {
    const { exerciseName, rirMin, rirMax, goal } = input.primaryRirTarget;
    const range = rirMin === rirMax ? `RIR ${rirMin}` : `RIR ${rirMin}-${rirMax}`;
    const goalCue =
      goal === 'strength'
        ? 'Strength-biased — last rep should be a grind.'
        : goal === 'hypertrophy'
          ? 'Hypertrophy-biased — push close to failure on the top set.'
          : 'Mixed range — pick the harder end of the band.';
    return note(
      input.clientId,
      `This week on ${exerciseName}: ${range}`,
      `Target for the top set is ${range}. ${goalCue}`,
    );
  }

  // Tier 4 — accessory tweak / coach-facing gap note. Surfaces an
  // untagged exercise so the next program edit closes the gap (per-
  // muscle volume ceilings need the tag).
  if (input.untaggedExercise) {
    const { exerciseName } = input.untaggedExercise;
    return note(
      input.clientId,
      `Tag a muscle group on ${exerciseName}`,
      `${exerciseName} isn't tagged with a muscle group yet, so the per-muscle weekly volume math skips it. Worth tagging in the program editor next time you're in there — keeps the volume ceiling honest as we add sets.`,
    );
  }

  // Tier 5 — hold-steady catch-all. Always fires. The wording
  // acknowledges adherence honestly even though we know it's
  // ≥ ADHERENCE_GATE_RATIO (otherwise the adherence suggestion would
  // have fired and the weekly note wouldn't run).
  const adherencePct = Math.round(input.adherenceRatio * 100);
  return note(
    input.clientId,
    'Holding steady',
    `${adherencePct}% adherence this week, lifts trending the way we want, nothing structural to change. Stay the course — keep effort honest on the top sets and we'll re-check next week.`,
  );
}
