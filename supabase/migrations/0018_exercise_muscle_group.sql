-- Slice 5a of the program-recommender work — tag exercises with their
-- primary muscle group so the recommender's systemic-stall branch can
-- target "drop volume on quads" rather than "drop volume across the
-- block" (a much more actionable suggestion for the coach).
--
-- Single primary muscle (not array). Secondary muscles complicate the
-- volume-accounting model significantly — for v1 we accept the loss of
-- precision in exchange for a clean per-muscle aggregation.
--
-- 'other' is the escape valve for accessories that don't fit one of the
-- 10 major groups (forearms, grip work, traps, etc.). Recommender ignores
-- 'other' rows when computing per-muscle stall concentrations.
--
-- Nullable so existing exercises survive — the recommender treats
-- untagged exercises as 'other' for aggregation but still counts their
-- stalls for the global breadth check.

alter table exercises
  add column if not exists muscle_group text
  check (muscle_group is null or muscle_group in (
    'chest','back','quads','hamstrings','glutes',
    'shoulders','biceps','triceps','calves','abs','other'
  ));

create index if not exists exercises_muscle_group_idx
  on exercises (muscle_group)
  where muscle_group is not null;
