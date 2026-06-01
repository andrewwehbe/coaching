/**
 * Single source of truth for the alerts.type union.
 *
 * The DB-side CHECK constraint on alerts.type is the actual authority
 * (see migrations 0001/0004/0006/0025/0029/0030). This module mirrors
 * those exact values so every consumer — notify.insertAlert, the
 * coach UI Alerts list, the cron routes — references the SAME union.
 *
 * Pure module (no 'server-only' guard) so client components can
 * import AlertType freely. Adding a new alert type:
 *   1. Add the value to the CHECK constraint via a new migration
 *      (pattern: drop-and-recreate, see 0025/0029/0030).
 *   2. Add the literal to AlertType below.
 *   3. Add a TYPE_CHIPS entry in coach/alerts/alerts-list.tsx so the
 *      UI renders a chip instead of crashing. (The UI also has a
 *      runtime fallback, but per-type styling is the right answer.)
 *   4. If insertAlert should auto-push the coach, add to PUSHABLE
 *      in lib/notify.ts.
 */

export type AlertType =
  // 0001 baseline.
  | 'pain'
  | 'stalled'
  | 'missed_workout'
  | 'workout_started'
  | 'workout_completed'
  // 0006.
  | 'workout_stale'
  // 0001.
  | 'check_in_due'
  | 'check_in_submitted'
  // 0004.
  | 'missed_checkin'
  // 0025 — Stage 4 deload / effort signals.
  | 'deload'
  | 'effort_gap'
  // 0029 — Stage 6 Piece 2 anomaly notifications.
  | 'adherence_drop'
  | 'returned_after_gap'
  | 'performance_cliff'
  | 'went_quiet'
  // 0030 — Stage 6 Piece 4 per-client per-week dedup row.
  | 'weekly_note_sent';

/** Runtime list of every alert type. Use this when iterating to build
 *  Records keyed by AlertType so a future addition compile-errors at
 *  Record construction sites until they're handled. */
export const ALL_ALERT_TYPES: ReadonlyArray<AlertType> = [
  'pain',
  'stalled',
  'missed_workout',
  'workout_started',
  'workout_completed',
  'workout_stale',
  'check_in_due',
  'check_in_submitted',
  'missed_checkin',
  'deload',
  'effort_gap',
  'adherence_drop',
  'returned_after_gap',
  'performance_cliff',
  'went_quiet',
  'weekly_note_sent',
];
