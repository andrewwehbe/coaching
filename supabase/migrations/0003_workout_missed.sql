-- Client-flagged "I won't be doing this one" marker. Distinct from a
-- completed-but-empty session (which means they did it but didn't log).
-- A missed workout has is_missed=true, completed_at set to the moment
-- the client tapped the button, and no exercise_logs.
alter table workouts add column if not exists is_missed boolean not null default false;
