-- Mark a calendar week as a deload for a specific client. Previously the
-- coach UI flipped is_deload on already-created workouts, but if the
-- client hadn't started anything yet for the week, the toggle silently
-- no-op'd. With a dedicated table:
--   - coach can mark deload before any workout is started
--   - /api/client/workout/start propagates is_deload to the new row
--   - /today renders a visible deload-week badge
--   - cue display can append a load-reduction reminder
--
-- One row per (client, week_start). Removing the row exits deload.

create table if not exists client_deload_weeks (
  client_id   uuid not null references clients(id) on delete cascade,
  week_start  date not null,
  marked_at   timestamptz not null default now(),
  marked_by   uuid references coaches(id) on delete set null,
  primary key (client_id, week_start)
);

create index if not exists client_deload_weeks_week_idx
  on client_deload_weeks (week_start);
