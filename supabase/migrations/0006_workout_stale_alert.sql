-- Add 'workout_stale' to allowed alert types. Fired by the
-- /api/cron/stale-workouts cron when a workout has been open for 2h+
-- without being marked done. Notifies both the client and the coach.
alter table alerts drop constraint alerts_type_check;
alter table alerts add constraint alerts_type_check check (type in (
  'pain','stalled','missed_workout',
  'workout_started','workout_completed','workout_stale',
  'check_in_due','check_in_submitted','missed_checkin'
));
