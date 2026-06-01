-- Stage 6 Piece 4 — approval-gated weekly client push.
--
-- Two pieces of schema:
--   1. weekly_note_approvals — single source for "is this week
--      approved to send to clients." The cron PREPARE step inserts a
--      row with approved_at NULL on Monday morning; the coach UI's
--      approve action flips approved_at to NOW(). dispatch() reads
--      THIS row to decide whether to send a single push. The unique
--      index on week_start guarantees at most one approval per week —
--      a second prepare-cron firing or a duplicate insert noops.
--
--   2. alerts.type_check — extend with 'weekly_note_sent'. Per-client
--      per-week dedup: dispatch() inserts ONE row of type
--      weekly_note_sent with data.week_start = the week start; a
--      subsequent dispatch in the same week skips clients with a
--      matching row. Two independent gates (approval row + per-client
--      sent row) provide bulletproof no-double-send.
--
-- Pattern matches 0004/0006/0025/0029: drop-and-recreate the named
-- alerts check constraint with the new value included. Idempotent via
-- DROP IF EXISTS and CREATE TABLE IF NOT EXISTS.

create table if not exists weekly_note_approvals (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  prepared_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  total_eligible int,
  total_sent int,
  total_skipped int
);

create index if not exists weekly_note_approvals_week_idx
  on weekly_note_approvals (week_start);

alter table alerts drop constraint if exists alerts_type_check;
alter table alerts add constraint alerts_type_check check (type in (
  'pain','stalled','missed_workout',
  'workout_started','workout_completed','workout_stale',
  'check_in_due','check_in_submitted','missed_checkin',
  'deload','effort_gap',
  'adherence_drop','returned_after_gap','performance_cliff','went_quiet',
  'weekly_note_sent'
));
