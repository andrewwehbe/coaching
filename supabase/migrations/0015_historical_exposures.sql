-- Pre-app training history imported from per-client Google Sheets.
-- One row per (exercise, training week) successfully parsed from the
-- sheet AND matched to an exercise currently in the client's active
-- app program.
--
-- The weekly report's plateau analysis reads this table alongside the
-- in-app exercise_logs+sets, ordering: historical (by week_index asc)
-- then app workouts (by started_at asc). Lets plateau detection see
-- the full mesocycle for clients who transitioned mid-cycle.
--
-- Strictly read-only by the rest of the app — never touched by the
-- workout / cue / log endpoints. Inserts come only from
-- scripts/import-history.ts; deletes are the only way to undo.

create table if not exists historical_exposures (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  exercise_name_key text not null,
  -- 1-based, oldest sheet week first. Skips the latest sheet week
  -- (caller responsibility — that's the "ignore the last week" rule).
  week_index int not null,
  weight numeric not null,
  unit text not null check (unit in ('kg','lb')),
  reps int not null,
  raw_cell text,
  source text not null default 'sheet',
  created_at timestamptz not null default now(),
  unique (client_id, exercise_name_key, week_index)
);

create index if not exists historical_exposures_client_key_idx
  on historical_exposures (client_id, exercise_name_key);
