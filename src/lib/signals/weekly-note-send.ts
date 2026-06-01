/**
 * Stage 6 Piece 4 — pure selection logic for the approval-gated
 * weekly client-note send. Server-and-client safe.
 *
 * This module is the testable, pure half of the weekly-note-send
 * helper. DB-bound code (buildWeeklyNoteSendInputs,
 * dispatchApprovedWeeklyNotes) lives in src/lib/weekly-note-send.ts
 * and consumes these types and the selectEligibleSendCandidates
 * function. The split exists so unit tests can import this module
 * without paying the 'server-only' import-time error.
 */
import { startOfWeek, formatISO, subDays, endOfDay } from 'date-fns';

import type { ClientWeekRow } from '../weekly-report';
import type { ContextDirective, ReasonCode } from './client-context';

export type WeeklyNoteSendCandidate = {
  clientId: string;
  clientName: string;
  title: string;
  body: string;
  reasonCode: ReasonCode | null;
  contextSource: 'persisted' | 'synthesized_onboarding' | null;
};

export type WeeklyNoteSendInputRow = {
  row: ClientWeekRow;
  /** From getContextDirective(activeContext.reasonCode), or null when
   *  no active context applies. */
  directive: ContextDirective | null;
  reasonCode: ReasonCode | null;
  contextSource: 'persisted' | 'synthesized_onboarding' | null;
  alreadySentThisWeek: boolean;
};

/**
 * Pure selection: given the per-client report rows + each client's
 * directive + the "already sent this week" set, returns the eligible
 * send list. Pure for testability — DB-bound caller assembles the
 * inputs.
 *
 * Eligibility rules (ALL must hold):
 *   - The row has a Suggestion with type === 'weekly_note'.
 *   - directive?.suppressClientWeeklyMessage is NOT true. (null
 *     directive = no active context = still eligible.)
 *   - alreadySentThisWeek === false.
 */
export function selectEligibleSendCandidates(
  inputs: ReadonlyArray<WeeklyNoteSendInputRow>,
): WeeklyNoteSendCandidate[] {
  const out: WeeklyNoteSendCandidate[] = [];
  for (const input of inputs) {
    if (input.alreadySentThisWeek) continue;
    if (input.directive?.suppressClientWeeklyMessage === true) continue;
    const note = input.row.suggestions.find((s) => s.type === 'weekly_note');
    if (!note) continue;
    out.push({
      clientId: input.row.clientId,
      clientName: input.row.name,
      title: note.title,
      body: note.body,
      reasonCode: input.reasonCode,
      contextSource: input.contextSource,
    });
  }
  return out;
}

/**
 * Compute the week_start ISO date the approval row keys on for a
 * given `at`. Matches startOfWeek with Monday-anchored week the rest
 * of the report uses.
 */
export function weekStartIsoFor(at: Date): string {
  return formatISO(startOfWeek(at, { weekStartsOn: 1 }), {
    representation: 'date',
  });
}

/**
 * Returns the moment of evaluation for the weekly review — end of
 * the most recently completed (or in-progress Sunday) calendar week.
 *
 *   - On Mon–Sat: end of LAST Sunday (the prior week just closed).
 *   - On Sunday: end of TODAY (the week being closed by tonight).
 *
 * Use this everywhere the Sunday-approve / Monday-send split needs
 * to agree on which week is being reviewed:
 *   - The Sunday preview UI (any access day).
 *   - The Monday send cron (after the week has closed).
 *   - The manual /dispatch failure-recovery route.
 *
 * weekStartIsoFor(reviewAtFor(now)) is the same ISO date Monday-Sunday
 * within a given Mon–Sun calendar week, so all three surfaces key
 * the approval row on the same value.
 */
export function reviewAtFor(now: Date): Date {
  const dow = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const lastSunday = dow === 0 ? now : subDays(now, dow);
  return endOfDay(lastSunday);
}
