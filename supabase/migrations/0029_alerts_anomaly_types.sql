-- Stage 6 Piece 2 — alerts.type adds the four anomaly notification
-- values produced by signals/anomaly.ts.
--
--   adherence_drop      — client who cleared the gate over the prior
--                         2-week window has fallen below it this window.
--                         The CHANGE is the signal (chronic-low stays
--                         on Gate A).
--   returned_after_gap  — a session logged after ≥7d of no activity.
--                         The ClientD trigger.
--   performance_cliff   — ≥2 lifts dropped beyond MDC across a logging
--                         gap. Distinct from Gate B (which catches
--                         train-through fatigue). When returned_after_gap
--                         fires same evaluation, this is suppressed
--                         (one return → one notification).
--   went_quiet          — no completed workout in ≥10d. at_risk does
--                         NOT silence this (continued disengagement is
--                         signal, not noise).
--
-- Pattern matches 0004 / 0006 / 0025: drop the named check, re-add
-- with the new values included. Idempotent via DROP IF EXISTS.

alter table alerts drop constraint if exists alerts_type_check;
alter table alerts add constraint alerts_type_check check (type in (
  'pain','stalled','missed_workout',
  'workout_started','workout_completed','workout_stale',
  'check_in_due','check_in_submitted','missed_checkin',
  'deload','effort_gap',
  'adherence_drop','returned_after_gap','performance_cliff','went_quiet'
));
