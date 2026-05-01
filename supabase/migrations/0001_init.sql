-- Coaching app schema (M1 baseline).
-- Apply via Supabase SQL editor or `supabase db push`.

create extension if not exists "pgcrypto";

-- =============================================================
-- Identity
-- =============================================================

create table coaches (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  pin_hash        text not null,
  pin_attempts    int  not null default 0,
  pin_locked_until timestamptz,
  created_at      timestamptz not null default now()
);

create table clients (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  pin_hash                 text not null,
  pin_attempts             int  not null default 0,
  pin_locked_until         timestamptz,
  active                   boolean not null default true,
  weekly_day_target        int  not null default 4,
  body_weight_freq         text not null default 'none'
                           check (body_weight_freq in ('none','daily','3x','weekly')),
  photo_check_in_enabled   boolean not null default false,
  meal_plan_enabled        boolean not null default false,
  created_at               timestamptz not null default now(),
  deactivated_at           timestamptz
);

create index clients_active_idx on clients (active);

-- =============================================================
-- Sessions and devices (cookie-backed auth)
-- =============================================================

create table devices (
  id                uuid primary key default gen_random_uuid(),
  user_type         text not null check (user_type in ('coach','client')),
  user_id           uuid not null,
  device_label      text,
  user_agent        text,
  push_subscription jsonb,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

create index devices_user_idx on devices (user_type, user_id);

create table sessions (
  -- id IS the cookie value; generated server-side as a long random hex.
  id           text primary key,
  user_type    text not null check (user_type in ('coach','client')),
  user_id      uuid not null,
  device_id    uuid references devices(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked      boolean not null default false,
  last_used_at timestamptz not null default now()
);

create index sessions_user_idx on sessions (user_type, user_id);
create index sessions_active_idx on sessions (revoked, expires_at);

-- IP-level rate limiting for PIN attempts.
create table rate_limits (
  ip            text primary key,
  attempts_15m  int not null default 0,
  window_15m    timestamptz not null default now(),
  attempts_24h  int not null default 0,
  window_24h    timestamptz not null default now()
);

-- =============================================================
-- Programs (parsed from uploaded sheets)
-- =============================================================

create table programs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  source_filename text,
  uploaded_at     timestamptz not null default now(),
  active          boolean not null default true
);

create index programs_client_idx on programs (client_id, active);

create table days (
  id          uuid primary key default gen_random_uuid(),
  program_id  uuid not null references programs(id) on delete cascade,
  day_index   int  not null,
  label       text not null,
  unique (program_id, day_index)
);

create table exercises (
  id              uuid primary key default gen_random_uuid(),
  day_id          uuid not null references days(id) on delete cascade,
  position        int  not null,
  name            text not null,
  -- Normalized lower-case key, used to dedupe "same exercise across days"
  -- when computing best efforts and stalled history.
  name_key        text not null,
  prescription_raw text,
  prescribed_sets int,
  rep_min         int,
  rep_max         int,
  rir_target      text,
  is_cardio       boolean not null default false,
  cardio_type     text check (cardio_type in ('treadmill','elliptical','stairmaster')),
  coach_note      text,
  archived_at     timestamptz,
  unique (day_id, position)
);

create index exercises_namekey_idx on exercises (name_key);

-- =============================================================
-- Workouts and logs
-- =============================================================

create table workouts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  day_id        uuid not null references days(id) on delete restrict,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  -- Calendar week (Monday-anchored, in client's local time at start_at).
  week_start    date not null,
  is_deload     boolean not null default false
);

create index workouts_client_week_idx on workouts (client_id, week_start);
create index workouts_open_idx on workouts (client_id, completed_at)
  where completed_at is null;

create table exercise_logs (
  id           uuid primary key default gen_random_uuid(),
  workout_id   uuid not null references workouts(id) on delete cascade,
  exercise_id  uuid not null references exercises(id) on delete restrict,
  -- 'completed' = at least one set logged; 'skipped' = explicitly skipped
  -- with reason; 'pain' = pain reported (notification fired).
  status       text not null default 'completed'
               check (status in ('completed','skipped','pain')),
  skip_reason  text,
  pain_reason  text,
  client_note  text,
  created_at   timestamptz not null default now(),
  unique (workout_id, exercise_id)
);

create table sets (
  id               uuid primary key default gen_random_uuid(),
  exercise_log_id  uuid not null references exercise_logs(id) on delete cascade,
  set_number       int  not null,
  weight           numeric,
  unit             text check (unit in ('kg','lb')),
  reps             int,
  rir              int,
  cardio_minutes   int,
  video_url        text,
  notes            text,
  created_at       timestamptz not null default now(),
  unique (exercise_log_id, set_number)
);

-- Cached "best ever" set per (client, exercise name key). Updated on
-- every set insert. Used for cue computation.
create table best_efforts (
  client_id        uuid not null references clients(id) on delete cascade,
  exercise_name_key text not null,
  best_weight      numeric,
  best_unit        text,
  best_reps        int,
  source_set_id    uuid references sets(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (client_id, exercise_name_key)
);

-- =============================================================
-- Plateau staging and swap proposals
-- =============================================================

create table stalled_history (
  client_id            uuid not null references clients(id) on delete cascade,
  exercise_name_key    text not null,
  weekly_exposures     jsonb not null,
  consecutive_stalled  int not null default 0,
  stage                text not null default 'none'
                       check (stage in ('none','watch','adjust','swap_candidate')),
  computed_at          timestamptz not null default now(),
  primary key (client_id, exercise_name_key)
);

create table swap_proposals (
  id                       uuid primary key default gen_random_uuid(),
  client_id                uuid not null references clients(id) on delete cascade,
  exercise_id              uuid not null references exercises(id) on delete cascade,
  reason                   text,
  status                   text not null default 'pending'
                           check (status in ('pending','approved','rejected')),
  replacement_exercise_id  uuid references exercises(id),
  proposed_at              timestamptz not null default now(),
  resolved_at              timestamptz
);

create index swap_proposals_open_idx on swap_proposals (client_id, status);

-- =============================================================
-- Coach inbox / alerts
-- =============================================================

create table alerts (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete cascade,
  type             text not null
                   check (type in ('pain','stalled','missed_workout',
                                   'workout_started','workout_completed',
                                   'check_in_due','check_in_submitted')),
  message          text not null,
  data             jsonb,
  created_at       timestamptz not null default now(),
  acknowledged_at  timestamptz
);

create index alerts_client_idx on alerts (client_id);
create index alerts_unack_idx on alerts (acknowledged_at) where acknowledged_at is null;

-- =============================================================
-- Check-ins (body weight + photos)
-- =============================================================

create table check_ins (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,
  date              date not null,
  body_weight       numeric,
  body_weight_unit  text check (body_weight_unit in ('kg','lb')),
  notes             text,
  created_at        timestamptz not null default now(),
  unique (client_id, date)
);

create table check_in_photos (
  id           uuid primary key default gen_random_uuid(),
  check_in_id  uuid not null references check_ins(id) on delete cascade,
  label        text not null check (label in ('front','side','back','extra')),
  storage_url  text not null,
  created_at   timestamptz not null default now()
);

-- =============================================================
-- Audit log (security-relevant actions)
-- =============================================================

create table audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_type   text not null check (actor_type in ('coach','client','system')),
  actor_id     uuid,
  action       text not null,
  target_type  text,
  target_id    uuid,
  details      jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_created_idx on audit_log (created_at desc);
