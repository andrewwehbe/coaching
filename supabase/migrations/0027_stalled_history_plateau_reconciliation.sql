-- Stage 4.6 — stalled_history reconciled onto the signals/plateau
-- 8-stage week-based ladder.
--
-- Before: consecutive_stalled (integer, EXPOSURES) + stage (text,
-- 4-value enum: none|watch|adjust|swap_candidate). Both derived from
-- the retired plateau.countConsecutiveStalled wrapper.
--
-- After: weeks_stalled (smallint, WEEKS) + plateau_stage (text, 8-value
-- enum matching signals/plateau.PlateauStage). Both written by the
-- daily-analysis cron via the same signals/plateau.classifyExercisePlateau
-- helper that suggestions.ts and recommend-for-client.ts use — single
-- plateau definition in the system after Stage 4.6.
--
-- Existing 222 rows discarded (TRUNCATE) per the null-forward call:
--   - old consecutive_stalled is exposures, new weeks_stalled is weeks,
--     not 1:1 convertible
--   - Stage-0 audit proved the old numbers were contaminated by the
--     projection bug (ClientA × Wide Row was 34 from history projecting
--     into 2027) — conversion would propagate corrupt math forward
--   - daily cron runs nightly; every active (client × exercise) gets a
--     fresh row within 24h on the new scale
--
-- TRUNCATE before add-column lets NOT NULL stick on the new columns,
-- closing the door on the cron writing a partial row later.

alter table stalled_history drop column if exists consecutive_stalled;
alter table stalled_history drop column if exists stage;

truncate table stalled_history;

alter table stalled_history
  add column if not exists weeks_stalled smallint not null;

alter table stalled_history
  add column if not exists plateau_stage text not null
    check (plateau_stage in (
      'insufficient_data',
      'progressing',
      'load_progression',
      'high_rir_stall',
      'fatigue_stall',
      'watch',
      'progress',
      'swap_candidate'
    ));
