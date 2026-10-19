-- Coach alerts for skips and client-written notes.
--
-- Pain already raised a coach alert. Skip reasons, set notes and
-- notes-to-self only ever landed in the logs, where they show as small
-- text on the session page, so the coach missed them (Christy's wrist
-- and EZ-bar notes, 2026-09). Two new alert types carry them to the
-- alerts feed and the coach's phone:
--
--   skipped      a client skipped an exercise (with their reason)
--   client_note  a client wrote a set note or a note to self
--
-- Same drop-and-recreate pattern as 0025/0029/0030.

alter table alerts drop constraint if exists alerts_type_check;
alter table alerts add constraint alerts_type_check check (type in (
  'pain','stalled','missed_workout',
  'workout_started','workout_completed','workout_stale',
  'check_in_due','check_in_submitted','missed_checkin',
  'deload','effort_gap',
  'adherence_drop','returned_after_gap','performance_cliff','went_quiet',
  'weekly_note_sent',
  'skipped','client_note'
));
