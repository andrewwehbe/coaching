-- Client-authored "note to self" on an exercise. Keyed by exercise_name_key
-- (the movement identity), mirroring best_efforts, so a note a client writes
-- persists across programs and re-surfaces every time they train that movement
-- again — not tied to a single program's exercise row.

create table if not exists exercise_self_notes (
  client_id         uuid not null references clients(id) on delete cascade,
  exercise_name_key text not null,
  note              text not null,
  updated_at        timestamptz not null default now(),
  primary key (client_id, exercise_name_key)
);
