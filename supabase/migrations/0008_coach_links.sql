-- Coaches who also train with the program (e.g., the head coach trains
-- alongside their clients) need to be able to "switch to client" and back.
-- Previously this was driven by a single hardcoded UUID in
-- COACH_LINKED_CLIENT_ID env, which breaks the moment a second coach
-- joins. The link table makes the relationship first-class.
--
-- Each row: a coach has a personal client account they can switch to.
-- (coach_id, client_id) is unique on both sides — a coach can only be
-- linked to one client and a client to one coach.

create table if not exists coach_links (
  coach_id   uuid not null references coaches(id) on delete cascade,
  client_id  uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (coach_id),
  unique (client_id)
);

create index if not exists coach_links_client_idx on coach_links (client_id);
