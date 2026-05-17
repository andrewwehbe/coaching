-- Slice 3 of the program-recommender work — capture session-level effort
-- so the recommender can detect fatigue drift across a block (sRPE rising
-- at constant load is the cleanest objective deload trigger in the brief).
--
-- 1–10 Borg CR-10 scale, matching the resistance-training literature:
--   1  = trivially easy
--   5  = moderate
--   7  = hard but sustainable
--   9  = ~1 RIR left across the session
--   10 = absolute max effort, could not have done more
--
-- Nullable so workouts logged before this column survive, and so the
-- client can complete a workout without rating it (we won't block the
-- "Done" button on it). Stored on workouts because it's session-level —
-- per-set effort lives on sets.rir (already exists from migration 0001).

alter table workouts
  add column if not exists session_rpe smallint
  check (session_rpe is null or (session_rpe between 1 and 10));
