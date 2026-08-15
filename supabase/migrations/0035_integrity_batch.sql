-- 0035: integrity batch (sweep report step 2).
-- Drift-checked against prod 2026-08-15 before applying:
--   * days unique(program_id, day_index) exists → safe to swap for deferrable
--   * no duplicate active programs, no duplicate open workouts → uniques apply clean
--   * name_key format violations: 0 → CHECK applies as valid
--   * sets outliers: 1 fat-finger (2706kg) + 4 negative weights → sanity CHECKs
--     added NOT VALID so history is tolerated but new writes are guarded

-- ---- FK / hot-path indexes (Postgres does not auto-index FK columns) ----
create index if not exists workouts_day_idx on workouts (day_id);
create index if not exists workouts_client_started_idx on workouts (client_id, started_at desc);
create index if not exists exercise_logs_exercise_idx on exercise_logs (exercise_id);
create index if not exists check_in_photos_checkin_idx on check_in_photos (check_in_id);
-- The only day_id index on exercises is the partial unique (archived_at IS
-- NULL); queries that include archived rows can't use it.
create index if not exists exercises_day_idx on exercises (day_id);

-- ---- Corruption guards ----
-- Closes the most likely "duplicate days" vector: two active programs after
-- a failed deactivate-then-insert commit.
create unique index if not exists programs_one_active_per_client
  on programs (client_id) where active;

-- Double-tap / offline-replay protection: at most one open workout per
-- client per program-day per week.
create unique index if not exists workouts_one_open_per_day
  on workouts (client_id, day_id, week_start) where completed_at is null;

-- Serves the stale-workout cron's idempotency lookup on data->>'workout_id'.
create index if not exists alerts_workout_dedup_idx
  on alerts ((data->>'workout_id')) where (data->>'workout_id') is not null;

-- ---- Deferrable day ordering ----
-- Lets a future transactional save renumber day_index in one transaction
-- without tripping the constraint mid-flight. No code uses this constraint
-- as an ON CONFLICT arbiter (verified — deferrable uniques can't back upserts).
alter table days drop constraint days_program_id_day_index_key;
alter table days add constraint days_program_id_day_index_key
  unique (program_id, day_index) deferrable initially deferred;

-- ---- Data sanity CHECKs ----
-- All existing rows conform (verified above), so this applies as VALID.
alter table exercises add constraint exercises_name_key_format
  check (name_key ~ '^d[0-9]+::');

-- NOT VALID: 5 historical outlier rows are tolerated (flagged for manual
-- cleanup); new writes are bounded. Run VALIDATE CONSTRAINT after cleanup.
alter table sets add constraint sets_weight_sane
  check (weight is null or (weight >= 0 and weight <= 1500)) not valid;
alter table sets add constraint sets_reps_sane
  check (reps is null or (reps >= 0 and reps <= 200)) not valid;
