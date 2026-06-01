/**
 * Stage 6 — client context. Pure, server-and-client safe.
 *
 * Single source the gate, the anomaly notifier (Piece 2), and the
 * weekly note (Piece 3 wiring) all read for "is something explaining
 * this client's behaviour right now and how should the app react."
 *
 * Two callable surfaces:
 *
 *   getActiveClientContext(input) → ActiveContext | null
 *     Pure decision over a snapshot. Caller fetches the persisted
 *     row + computes hasNoLogs + clientCreatedAt and passes them in.
 *     Returns:
 *       - the persisted unresolved row, when it exists AND its
 *         review_at is not stale (review_at IS NULL OR review_at >= at)
 *       - a SYNTHESIZED 'onboarding' context, when no persisted row
 *         applies AND the client is within CONTEXT_ONBOARDING_WEEKS of
 *         creation AND has no logged workouts
 *       - null otherwise
 *     Non-staleness is baked in here — callers can NEVER consume a
 *     stale context by accident.
 *
 *   getContextDirective(reasonCode) → ContextDirective
 *     Per-code behavior matrix. Every surface that reacts to context
 *     (Gate A, plateau classifier, weekly note, anomaly notifier)
 *     reads from THIS function — by construction every surface
 *     interprets a code the same way.
 *
 * Construction-consistency invariant: a synthesized onboarding context
 * and a persisted onboarding row produce BYTE-IDENTICAL directives.
 * Tests assert this so future code can't accidentally treat
 * auto-onboarded clients differently from manually-onboarded ones.
 */
import { CONTEXT_ONBOARDING_WEEKS } from '../config';

export type ReasonCode =
  | 'onboarding'
  | 'health'
  | 'injury'
  | 'travel'
  | 'life_stress'
  | 'planned_break'
  | 'at_risk'
  | 'paused';

export type AnomalyType =
  | 'adherence_drop'
  | 'returned_after_gap'
  | 'performance_cliff'
  | 'went_quiet';

export type WeeklyNoteTemplate =
  | 'getting_started'
  | 'ease_back_in'
  | 're_engagement';

/** Shape of a persisted client_context row as the helper consumes it.
 *  The DB column names are mapped at the caller; the pure helper takes
 *  a normalized object so it stays testable without a Supabase mock. */
export type PersistedContextRow = {
  id: string;
  reason_code: ReasonCode;
  note: string | null;
  created_at: Date;
  review_at: Date | null;
  resolved_at: Date | null;
};

export type ActiveContext = {
  reasonCode: ReasonCode;
  /** 'persisted' — a real client_context row. 'synthesized_onboarding'
   *  — read-time virtual context for new clients without logs. */
  source: 'persisted' | 'synthesized_onboarding';
  /** null when no review_at set (persisted with explicit null) or
   *  synthesized but window-bounded. For synthesized onboarding this
   *  is `clientCreatedAt + CONTEXT_ONBOARDING_WEEKS`. */
  reviewAt: Date | null;
  note: string | null;
  /** null for synthesized contexts. */
  contextId: string | null;
  createdAt: Date;
};

export type ContextDirective = {
  reasonCode: ReasonCode;
  /** Suppress Gate A's "chase them about showing up" emission entirely. */
  suppressGateA: boolean;
  /** Emit Gate A with softened wording (life_stress) instead of the
   *  standard behavioral-barrier framing. Mutually exclusive with
   *  suppressGateA at the consumer; if both are false, normal Gate A. */
  softenGateA: boolean;
  /** Suppress per-exercise plateau suggestions (watch / progress /
   *  swap_candidate / high_rir_stall) for ALL of this client's
   *  exercises this week. */
  suppressPlateauSuggestions: boolean;
  /** Hold the program completely — no add_set / swap / archive_day
   *  / deload apply emissions. life_stress sets this true alongside
   *  softenGateA so we stop changing things while the client is
   *  capacity-limited. */
  suppressAllProgramChanges: boolean;
  /** Health: filter lifts whose e1RM dropped during a session-time
   *  gap ≥ DETRAINING_GAP_DAYS out of stall counting. Per-exercise
   *  filter — does NOT blanket-suppress plateau. */
  detrainingExcluded: boolean;
  /** Injury: protect the affected movement pattern from auto-
   *  prescription and flag affected lifts for coach review. */
  injuryAreaProtected: boolean;
  /** Above-PR-celebration tier in buildWeeklyCoachingNote when set;
   *  null means the existing 5-tier path runs. */
  weeklyNoteTemplate: WeeklyNoteTemplate | null;
  /** Anomaly silencing — Stage 6 Q2 carve-out.
   *  'all' = uniform silence (default for most codes — "coach already
   *    knows" eliminates redundant pings).
   *  Set<AnomalyType> = explicit silence list. at_risk uses this to
   *    KEEP went_quiet and adherence_drop firing because for an at-
   *    risk client, continued disengagement is EXACTLY the signal
   *    the coach wanted to watch for — silencing it defeats the
   *    purpose. */
  silencesAnomalyTypes: 'all' | ReadonlySet<AnomalyType>;
  /** Stage 6 Piece 4 — exclude this client from the approval-gated
   *  weekly client-note push entirely. true for the codes that
   *  explicitly silence the coaching relationship this week (paused,
   *  planned_break, travel). false for "still-active" codes —
   *  onboarding/health/at_risk send their tier-0 framed note when
   *  approved; injury and life_stress send the standard 5-tier note.
   *  Single source — the send dispatcher reads ONLY this flag, never
   *  inspects reasonCode itself. */
  suppressClientWeeklyMessage: boolean;
};

/**
 * Per-code directive. Single source of truth. Adding a reason code:
 *   1. Add to the ReasonCode union here.
 *   2. Add a case to this switch.
 *   3. Add to the CHECK constraint via a migration.
 *   4. Compile error in this function until step 1+2 are done — by
 *      design (switch exhaustiveness).
 */
export function getContextDirective(reasonCode: ReasonCode): ContextDirective {
  switch (reasonCode) {
    case 'onboarding':
      return {
        reasonCode,
        suppressGateA: true,
        softenGateA: false,
        suppressPlateauSuggestions: true,
        suppressAllProgramChanges: true,
        detrainingExcluded: false,
        injuryAreaProtected: false,
        weeklyNoteTemplate: 'getting_started',
        silencesAnomalyTypes: 'all',
        suppressClientWeeklyMessage: false,
      };
    case 'health':
      return {
        reasonCode,
        suppressGateA: true,
        softenGateA: false,
        // Don't blanket-suppress — health uses detrainingExcluded for
        // per-lift filtering instead. Lifts that didn't drop during the
        // gap still get normal classification.
        suppressPlateauSuggestions: false,
        suppressAllProgramChanges: false,
        detrainingExcluded: true,
        injuryAreaProtected: false,
        weeklyNoteTemplate: 'ease_back_in',
        silencesAnomalyTypes: 'all',
        suppressClientWeeklyMessage: false,
      };
    case 'injury':
      return {
        reasonCode,
        suppressGateA: false,
        softenGateA: false,
        suppressPlateauSuggestions: false,
        suppressAllProgramChanges: false,
        detrainingExcluded: false,
        injuryAreaProtected: true,
        weeklyNoteTemplate: null,
        silencesAnomalyTypes: 'all',
        suppressClientWeeklyMessage: false,
      };
    case 'travel':
      return {
        reasonCode,
        suppressGateA: true,
        softenGateA: false,
        suppressPlateauSuggestions: true,
        suppressAllProgramChanges: true,
        detrainingExcluded: false,
        injuryAreaProtected: false,
        weeklyNoteTemplate: null,
        silencesAnomalyTypes: 'all',
        suppressClientWeeklyMessage: true,
      };
    case 'life_stress':
      return {
        reasonCode,
        suppressGateA: false,
        softenGateA: true,
        suppressPlateauSuggestions: false,
        suppressAllProgramChanges: true,
        detrainingExcluded: false,
        injuryAreaProtected: false,
        weeklyNoteTemplate: null,
        silencesAnomalyTypes: 'all',
        suppressClientWeeklyMessage: false,
      };
    case 'planned_break':
      return {
        reasonCode,
        suppressGateA: true,
        softenGateA: false,
        suppressPlateauSuggestions: true,
        suppressAllProgramChanges: true,
        detrainingExcluded: false,
        injuryAreaProtected: false,
        weeklyNoteTemplate: null,
        silencesAnomalyTypes: 'all',
        suppressClientWeeklyMessage: true,
      };
    case 'at_risk':
      return {
        reasonCode,
        // Don't suppress Gate A — the coach explicitly wants to know
        // they're still skipping. The Gate A note IS the at-risk
        // tracking surface.
        suppressGateA: false,
        softenGateA: false,
        suppressPlateauSuggestions: true,
        suppressAllProgramChanges: true,
        detrainingExcluded: false,
        injuryAreaProtected: false,
        weeklyNoteTemplate: 're_engagement',
        // Q2 carve-out (Stage 6 sign-off): for an at-risk client,
        // went_quiet and adherence_drop are SIGNAL, not noise — they
        // confirm the disengagement the coach is watching for.
        // Silence the two anomalies whose info is already implied by
        // the at-risk classification (returned_after_gap is "they came
        // back" which we'd notice anyway; performance_cliff after a
        // gap is expected).
        silencesAnomalyTypes: new Set<AnomalyType>([
          'returned_after_gap',
          'performance_cliff',
        ]),
        suppressClientWeeklyMessage: false,
      };
    case 'paused':
      return {
        reasonCode,
        suppressGateA: true,
        softenGateA: false,
        suppressPlateauSuggestions: true,
        suppressAllProgramChanges: true,
        detrainingExcluded: false,
        injuryAreaProtected: false,
        weeklyNoteTemplate: null,
        silencesAnomalyTypes: 'all',
        suppressClientWeeklyMessage: true,
      };
  }
}

/**
 * Helper used by the anomaly notifier (Piece 2): does an active
 * context's directive silence a specific anomaly type? Encapsulates
 * the 'all' vs Set<AnomalyType> branch so callers don't repeat it.
 */
export function anomalyIsSilenced(
  directive: ContextDirective,
  anomaly: AnomalyType,
): boolean {
  if (directive.silencesAnomalyTypes === 'all') return true;
  return directive.silencesAnomalyTypes.has(anomaly);
}

export type ActiveContextInput = {
  at: Date;
  /** The most recent unresolved row for the client, or null if none.
   *  Caller fetches via:
   *    SELECT * FROM client_context
   *    WHERE client_id = $1 AND resolved_at IS NULL
   *    ORDER BY created_at DESC LIMIT 1
   *  The partial unique index on (client_id) WHERE resolved_at IS NULL
   *  guarantees at most one such row. */
  persistedRow: PersistedContextRow | null;
  clientCreatedAt: Date;
  /** True when the client has zero completed workouts. */
  hasNoLogs: boolean;
};

export function getActiveClientContext(
  input: ActiveContextInput,
): ActiveContext | null {
  // Persisted path — return only when row exists, is not resolved,
  // and is not past its review_at. Non-staleness baked in.
  if (input.persistedRow) {
    const row = input.persistedRow;
    if (row.resolved_at === null) {
      const isStale = row.review_at != null && row.review_at < input.at;
      if (!isStale) {
        return {
          reasonCode: row.reason_code,
          source: 'persisted',
          reviewAt: row.review_at,
          note: row.note,
          contextId: row.id,
          createdAt: row.created_at,
        };
      }
      // Stale: fall through to synthesized-onboarding evaluation. A
      // stale context behaves as if it never existed — that's the
      // whole point of the non-staleness rule (no permanent silent
      // suppression). If the client somehow meets onboarding criteria
      // again, the synthesized path catches them; otherwise → null,
      // normal handling resumes.
    }
  }

  // Synthesized onboarding — read-time virtual context. No DB write.
  // Auto-resolves naturally when:
  //   - the client logs anything (hasNoLogs becomes false), OR
  //   - CONTEXT_ONBOARDING_WEEKS elapse from clientCreatedAt.
  const onboardingMs = CONTEXT_ONBOARDING_WEEKS * 7 * 24 * 60 * 60 * 1000;
  const onboardingWindowEnd = new Date(
    input.clientCreatedAt.getTime() + onboardingMs,
  );
  if (
    input.hasNoLogs &&
    input.clientCreatedAt <= input.at &&
    onboardingWindowEnd >= input.at
  ) {
    return {
      reasonCode: 'onboarding',
      source: 'synthesized_onboarding',
      reviewAt: onboardingWindowEnd,
      note: null,
      contextId: null,
      createdAt: input.clientCreatedAt,
    };
  }

  return null;
}
