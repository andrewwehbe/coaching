-- Some clients transitioned mid-mesocycle from Google Sheets / paper /
-- another app. The coach uploaded their program here, but they're not
-- actually on week 1 — they're on week 5 (or whatever) of the same
-- training block. Without this distinction:
--   - programWeekNumber (used by suggestions.ts) sees uploaded_at and
--     thinks they're week 1, so swap_candidate stages are downgraded
--     to "adjust" for the first 6 weeks
--   - Coach can't distinguish "fresh program start" from "mid-cycle
--     transition" for the analytics
--
-- training_start_at is nullable. When set, plateau / suggestion logic
-- uses it as the program-week anchor. When null, falls back to
-- uploaded_at so existing programs behave as before.

alter table programs
  add column if not exists training_start_at timestamptz;
