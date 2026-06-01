-- Stage 4 of the suggestion redesign — new alert types.
--
-- 'deload'      — fired when a coach applies the kind:'deload' suggestion
--                 (signals/fatigue.shouldDeload true). Mirrors the
--                 client_deload_weeks mark + workouts.is_deload flip onto
--                 the alerts feed so the coach status timeline and the
--                 client's own /today acknowledgement flow both see it.
-- 'effort_gap'  — reserved for Stage 5's "feels-coached" weekly note
--                 path. When the prescribed RIR is dropping but the
--                 client's logged top-set RIR has sat persistently
--                 ≥RIR_EFFORT_GAP_THRESHOLD above target across the
--                 recent window, surface a coaching cue. Added now
--                 because the constraint-update pattern is one migration
--                 per round-trip and bundling them keeps the migration
--                 ledger tidy.
--
-- Pattern matches 0004 / 0006: drop the named constraint, re-add it with
-- the new value(s) included. Idempotent via IF EXISTS.

alter table alerts drop constraint if exists alerts_type_check;
alter table alerts add constraint alerts_type_check check (type in (
  'pain','stalled','missed_workout',
  'workout_started','workout_completed','workout_stale',
  'check_in_due','check_in_submitted','missed_checkin',
  'deload','effort_gap'
));
