-- Slice 2 of the program-recommender work — capture the per-client inputs
-- the decision tree needs to make programming recommendations that match
-- the lifter, not a default "intermediate hypertrophy" assumption.
--
-- All four columns are nullable so existing rows keep working. The
-- recommender will treat NULL as "intermediate / hypertrophy / full_gym /
-- no blacklist" until the coach fills them in.
--
--   training_age      novice / intermediate / advanced  — gates plateau,
--                     swap, mesocycle length, and deload cadence.
--   primary_goal      hypertrophy / strength / fat_loss / general  —
--                     changes which signals are interpreted as plateaus
--                     and biases the volume-vs-intensity branches.
--   equipment         full_gym / home_gym / dumbbells_only / bodyweight —
--                     constrains the swap candidate pool.
--   exercise_blacklist text[] of *display names* the coach has banned for
--                     this client (injury history, hated exercises). The
--                     swap branch must never recommend something on this
--                     list. Default empty so existing clients pass through
--                     unchanged.

alter table clients
  add column if not exists training_age text
    check (training_age is null or training_age in ('novice','intermediate','advanced')),
  add column if not exists primary_goal text
    check (primary_goal is null or primary_goal in ('hypertrophy','strength','fat_loss','general')),
  add column if not exists equipment text
    check (equipment is null or equipment in ('full_gym','home_gym','dumbbells_only','bodyweight')),
  add column if not exists exercise_blacklist text[] not null default '{}';

-- programs.uploaded_at is set by /api/coach/clients/[id]/program/commit
-- when a NEW sheet is uploaded, but the in-place edit at
-- /api/coach/clients/[id]/program/save mutates days/exercises without
-- touching the parent programs row. That made "edited X weeks ago" on the
-- coach roster misleading after edits. Adding last_edited_at lets us
-- distinguish "fresh upload" from "tweaked yesterday" without losing the
-- original upload date.
--
-- Nullable so it falls back to uploaded_at for rows that predate this
-- column (and that the coach hasn't touched since).

alter table programs
  add column if not exists last_edited_at timestamptz;
