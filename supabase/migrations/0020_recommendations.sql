-- Slice 6 of the program-recommender work — persist the recommender's
-- output AND the coach's decision so we can:
--   1. show the coach a history of what was recommended and what they did
--      with it (audit trail)
--   2. analyze decisions over time to tune the practitioner-heuristic
--      thresholds documented in config.ts
--
-- One row per coach action — not per page-load. The recommender runs
-- in-memory every time the client detail page renders; we only persist
-- when the coach explicitly decides ("applied" / "dismissed" / "snoozed" /
-- "acknowledged"). This avoids a row-per-pageview while still capturing
-- the meaningful event.
--
-- We snapshot the full recommendation payload (type, title, body,
-- rationale, data_gaps, forced_swaps) and the input signals (sessions,
-- adherence, RIR drift, stall counts, etc.) so a later analysis can
-- reproduce why a given decision was made even after the recommender
-- logic evolves.

create table if not exists recommendations (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  coach_id        uuid references coaches(id) on delete set null,
  created_at      timestamptz not null default now(),

  -- Recommendation snapshot
  rec_type        text not null,
  title           text not null,
  body            text not null,
  forced_swaps    jsonb not null default '[]'::jsonb,
  rationale       jsonb not null default '[]'::jsonb,
  data_gaps       jsonb not null default '[]'::jsonb,

  -- Input snapshot — enables retroactive analysis after threshold changes
  signals         jsonb not null default '{}'::jsonb,

  -- Coach decision (always present on insert — slice 6 only persists on
  -- coach action, not on page-load)
  decision        text not null check (decision in ('applied','dismissed','snoozed','acknowledged')),
  decision_note   text
);

create index if not exists recommendations_client_created_idx
  on recommendations (client_id, created_at desc);
