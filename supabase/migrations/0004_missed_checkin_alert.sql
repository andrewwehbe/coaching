-- Add 'missed_checkin' to allowed alert types so the Monday 5pm follow-up
-- can mark a missed weekly check-in and notify both the client and coach.
alter table alerts drop constraint alerts_type_check;
alter table alerts add constraint alerts_type_check check (type in (
  'pain','stalled','missed_workout',
  'workout_started','workout_completed',
  'check_in_due','check_in_submitted','missed_checkin'
));
