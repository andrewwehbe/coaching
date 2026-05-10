-- The original unique(day_id, position) constraint includes archived rows.
-- That forces every archive flow to also vacate the slot (e.g., +1000) so a
-- replacement can claim the same position. With a partial index the
-- constraint only applies to live exercises, which:
--   1. Lets archived rows keep their original position (history-friendly).
--   2. Lets the swap and approve flows insert at the original slot without
--      a position-bump dance.
--   3. Makes future "delete vs. soft-archive" decisions less error-prone.
--
-- Safe to apply: pre-existing data already obeys the partial constraint
-- because archived rows that share a position with a live row would
-- already be violating the original full constraint.

alter table exercises drop constraint if exists exercises_day_id_position_key;

create unique index if not exists exercises_active_day_position_idx
  on exercises (day_id, position)
  where archived_at is null;
