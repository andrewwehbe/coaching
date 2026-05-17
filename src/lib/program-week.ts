/**
 * Pure date math for the "where is this client in their program" counters
 * surfaced on the coach screens.
 *
 *   - weekInProgram        — 1-indexed; week 1 is the week containing the
 *                            training anchor (training_start_at if the coach
 *                            set it for a mid-mesocycle transition, else
 *                            programs.uploaded_at).
 *   - weeksSinceUpload     — distance from the current week's Monday back to
 *                            the week of programs.uploaded_at. 0 = uploaded
 *                            this week. Stale program = larger number.
 *   - deloadCount          — count of client_deload_weeks rows whose
 *                            week_start is on or after the anchor week.
 *                            Deloads from a prior program don't count.
 *   - weeksSinceLastDeload — distance from this week's Monday back to the
 *                            most recent deload week_start. 0 = this week is
 *                            a deload. null = no deload has happened yet in
 *                            this program.
 *
 * Server-and-client safe — no node-only imports.
 */
import { differenceInCalendarWeeks, formatISO, startOfWeek } from 'date-fns';

export type ProgramContextInput = {
  trainingStartAt: string | null;
  uploadedAt: string;
  /**
   * Set by /api/coach/clients/[id]/program/save on every in-place edit.
   * When non-null we prefer it for weeksSinceUpload — `uploaded_at` only
   * moves when the coach uploads a fresh sheet, so without this the
   * "edited Xw ago" counter would stay stuck after coach edits.
   */
  lastEditedAt: string | null;
  deloadWeekStarts: string[];
};

export type ProgramContext = {
  weekInProgram: number | null;
  weeksSinceUpload: number | null;
  deloadCount: number;
  weeksSinceLastDeload: number | null;
};

export const EMPTY_PROGRAM_CONTEXT: ProgramContext = {
  weekInProgram: null,
  weeksSinceUpload: null,
  deloadCount: 0,
  weeksSinceLastDeload: null,
};

export function computeProgramContext(
  input: ProgramContextInput | null,
  at: Date = new Date(),
): ProgramContext {
  if (!input) return EMPTY_PROGRAM_CONTEXT;

  const anchor = new Date(input.trainingStartAt ?? input.uploadedAt);
  const uploaded = new Date(input.lastEditedAt ?? input.uploadedAt);

  const weekInProgram = Math.max(
    1,
    differenceInCalendarWeeks(at, anchor, { weekStartsOn: 1 }) + 1,
  );
  const weeksSinceUpload = Math.max(
    0,
    differenceInCalendarWeeks(at, uploaded, { weekStartsOn: 1 }),
  );

  const anchorMondayIso = formatISO(startOfWeek(anchor, { weekStartsOn: 1 }), {
    representation: 'date',
  });
  const relevant = input.deloadWeekStarts.filter((d) => d >= anchorMondayIso);
  const deloadCount = relevant.length;

  let weeksSinceLastDeload: number | null = null;
  if (relevant.length > 0) {
    const lastIso = [...relevant].sort()[relevant.length - 1];
    const last = new Date(`${lastIso}T00:00:00Z`);
    weeksSinceLastDeload = Math.max(
      0,
      differenceInCalendarWeeks(at, last, { weekStartsOn: 1 }),
    );
  }

  return { weekInProgram, weeksSinceUpload, deloadCount, weeksSinceLastDeload };
}
