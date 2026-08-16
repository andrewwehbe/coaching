-- 0040: movement identity + weekly exposure materialization (step 6).
--
-- PART A — movements. Exercise identity was a bare string ("d1::hack
-- squat") whose prefix depends on day order at save time; best_efforts,
-- stalled_history, exercise_self_notes, and historical_exposures all join
-- on it. A day reorder rekeys the exercise and, before this migration,
-- silently detached everything except best_efforts (which had a partial
-- copy-migration). movements gives every distinct exercise NAME per client
-- a stable uuid:
--   * movements.name_norm      normalized display name (matches the TS
--                              normalize() in lib/exercise-name.ts)
--   * movements.legacy_name_key the CURRENT operational name_key — the
--                              engine keeps joining on name_key, unchanged
--   * triggers keep exercises.movement_id + derived-table movement_id
--                              filled on every write, from any writer
--   * ensure_movement() migrates ALL derived rows atomically whenever a
--                              movement's key changes (reorders), closing
--                              the Karl/Samar orphaned-history class
-- Name CHANGES (typo fix / real swap) create a new movement, preserving
-- the app's existing "rename resets the cue" semantic; the TS
-- migrateBestEffortKey copy still covers the PR for those.
--
-- PART B — weekly_exposures. Per (client, name_key, ISO week): the top
-- loaded set (kg-normalized, ties by reps) + session count + e1RM.
-- Backfilled here, refreshed nightly by daily-analysis via
-- refresh_weekly_exposures(). The queryable analytical record that
-- per-request engine scans can migrate onto.
--
-- Plus get_block_bests(): the workout-screen block-best (previously 5-6
-- sequential PostgREST calls on the hottest client path) as one RPC with
-- IDENTICAL semantics — program-scoped, block-start bounded, includes
-- in-progress sessions.

-- ---------------------------------------------------------------------------
-- Normalizer — must match normalize() in src/lib/exercise-name.ts.
-- ---------------------------------------------------------------------------
create or replace function movement_norm(p_name text) returns text
language sql immutable as $$
  select regexp_replace(
    btrim(regexp_replace(lower(coalesce(p_name, '')), '\s+', ' ', 'g')),
    '[\s\-_.,;:!?''"()\[\]{}]+$', ''
  );
$$;

-- ---------------------------------------------------------------------------
-- movements
-- ---------------------------------------------------------------------------
create table if not exists movements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  canonical_name text not null,
  name_norm text not null,
  legacy_name_key text not null,
  created_at timestamptz not null default now(),
  unique (client_id, name_norm)
);
create index if not exists movements_client_key_idx
  on movements (client_id, legacy_name_key);

-- Backfill: one movement per (client, normalized name) across ALL
-- programs; the operational key comes from the active program first,
-- newest upload otherwise, live rows before archived.
insert into movements (client_id, canonical_name, name_norm, legacy_name_key)
select distinct on (p.client_id, movement_norm(e.name))
  p.client_id, e.name, movement_norm(e.name), e.name_key
from exercises e
join days d on d.id = e.day_id
join programs p on p.id = d.program_id
where movement_norm(e.name) <> ''
order by p.client_id, movement_norm(e.name),
  p.active desc, p.uploaded_at desc, e.archived_at asc nulls first
on conflict (client_id, name_norm) do nothing;

-- ---------------------------------------------------------------------------
-- movement_id columns
-- ---------------------------------------------------------------------------
alter table exercises add column if not exists movement_id uuid references movements(id) on delete set null;
alter table best_efforts add column if not exists movement_id uuid references movements(id) on delete set null;
alter table stalled_history add column if not exists movement_id uuid references movements(id) on delete set null;
alter table exercise_self_notes add column if not exists movement_id uuid references movements(id) on delete set null;
alter table historical_exposures add column if not exists movement_id uuid references movements(id) on delete set null;

-- Backfill exercises by normalized name (cross-program identity).
update exercises e
set movement_id = m.id
from days d, programs p, movements m
where d.id = e.day_id and p.id = d.program_id
  and m.client_id = p.client_id and m.name_norm = movement_norm(e.name)
  and e.movement_id is null;

-- Backfill derived tables by their CURRENT operational key. Rows whose
-- key no longer maps to a live movement (historical orphans) stay null.
update best_efforts t set movement_id = m.id
from movements m
where m.client_id = t.client_id and m.legacy_name_key = t.exercise_name_key
  and t.movement_id is null;
update stalled_history t set movement_id = m.id
from movements m
where m.client_id = t.client_id and m.legacy_name_key = t.exercise_name_key
  and t.movement_id is null;
update exercise_self_notes t set movement_id = m.id
from movements m
where m.client_id = t.client_id and m.legacy_name_key = t.exercise_name_key
  and t.movement_id is null;
update historical_exposures t set movement_id = m.id
from movements m
where m.client_id = t.client_id and m.legacy_name_key = t.exercise_name_key
  and t.movement_id is null;

-- ---------------------------------------------------------------------------
-- Rekey migration: move every derived row from one operational key to
-- another. Called by ensure_movement inside the same transaction as the
-- exercise write that rekeyed the movement.
-- Merge rules:
--   best_efforts        keep the better lift (kg-normalized, ties by reps)
--   stalled_history     the actively-maintained source row wins
--   exercise_self_notes source wins (it is the live note)
--   historical_exposures / weekly_exposures  move; drop source dupes
-- ---------------------------------------------------------------------------
create or replace function migrate_movement_key(
  p_client_id uuid, p_old_key text, p_new_key text
) returns void
language plpgsql as $$
declare
  o record;
  n record;
  o_kg numeric;
  n_kg numeric;
begin
  if p_old_key is null or p_new_key is null or p_old_key = p_new_key then
    return;
  end if;

  -- best_efforts: PR semantics — the max survives.
  select * into o from best_efforts
    where client_id = p_client_id and exercise_name_key = p_old_key;
  if found then
    select * into n from best_efforts
      where client_id = p_client_id and exercise_name_key = p_new_key;
    if found then
      o_kg := case when o.best_unit = 'lb' then o.best_weight * 0.45359237 else o.best_weight end;
      n_kg := case when n.best_unit = 'lb' then n.best_weight * 0.45359237 else n.best_weight end;
      if o.best_weight is not null and (
           n.best_weight is null
           or o_kg > n_kg + 0.001
           or (o_kg >= n_kg - 0.001 and coalesce(o.best_reps, 0) > coalesce(n.best_reps, 0))
         ) then
        update best_efforts
        set best_weight = o.best_weight, best_unit = o.best_unit,
            best_reps = o.best_reps, source_set_id = o.source_set_id,
            pinned = o.pinned, updated_at = o.updated_at
        where client_id = p_client_id and exercise_name_key = p_new_key;
      end if;
      delete from best_efforts
        where client_id = p_client_id and exercise_name_key = p_old_key;
    else
      update best_efforts set exercise_name_key = p_new_key
        where client_id = p_client_id and exercise_name_key = p_old_key;
    end if;
  end if;

  -- stalled_history / self notes: the source row is the live one.
  delete from stalled_history
    where client_id = p_client_id and exercise_name_key = p_new_key
      and exists (select 1 from stalled_history
                  where client_id = p_client_id and exercise_name_key = p_old_key);
  update stalled_history set exercise_name_key = p_new_key
    where client_id = p_client_id and exercise_name_key = p_old_key;

  delete from exercise_self_notes
    where client_id = p_client_id and exercise_name_key = p_new_key
      and exists (select 1 from exercise_self_notes
                  where client_id = p_client_id and exercise_name_key = p_old_key);
  update exercise_self_notes set exercise_name_key = p_new_key
    where client_id = p_client_id and exercise_name_key = p_old_key;

  -- historical_exposures: move, dropping source rows that collide.
  delete from historical_exposures s
    where s.client_id = p_client_id and s.exercise_name_key = p_old_key
      and exists (select 1 from historical_exposures t
                  where t.client_id = p_client_id
                    and t.exercise_name_key = p_new_key
                    and t.week_index = s.week_index);
  update historical_exposures set exercise_name_key = p_new_key
    where client_id = p_client_id and exercise_name_key = p_old_key;

  -- weekly_exposures: same treatment (table created below; guarded so the
  -- function body stays valid mid-migration).
  if to_regclass('public.weekly_exposures') is not null then
    delete from weekly_exposures s
      where s.client_id = p_client_id and s.exercise_name_key = p_old_key
        and exists (select 1 from weekly_exposures t
                    where t.client_id = p_client_id
                      and t.exercise_name_key = p_new_key
                      and t.week_start = s.week_start);
    update weekly_exposures set exercise_name_key = p_new_key
      where client_id = p_client_id and exercise_name_key = p_old_key;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- ensure_movement: find-or-create by normalized name; on key change,
-- update the dictionary and migrate every derived row.
-- ---------------------------------------------------------------------------
create or replace function ensure_movement(
  p_client_id uuid, p_name text, p_name_key text
) returns uuid
language plpgsql as $$
declare
  v_norm text := movement_norm(p_name);
  v_id uuid;
  v_old_key text;
  v_canonical text;
begin
  if v_norm = '' or p_name_key is null then
    return null;
  end if;

  select id, legacy_name_key, canonical_name into v_id, v_old_key, v_canonical
  from movements
  where client_id = p_client_id and name_norm = v_norm;

  if v_id is null then
    insert into movements (client_id, canonical_name, name_norm, legacy_name_key)
    values (p_client_id, p_name, v_norm, p_name_key)
    on conflict (client_id, name_norm) do update set canonical_name = excluded.canonical_name
    returning id into v_id;
    return v_id;
  end if;

  if v_old_key is distinct from p_name_key then
    update movements
    set legacy_name_key = p_name_key, canonical_name = p_name
    where id = v_id;
    perform migrate_movement_key(p_client_id, v_old_key, p_name_key);
  elsif v_canonical is distinct from p_name then
    update movements set canonical_name = p_name where id = v_id;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers: every writer (RPCs, routes, crons, scripts) maintains
-- movement identity without knowing about it.
-- ---------------------------------------------------------------------------
create or replace function trg_exercises_movement() returns trigger
language plpgsql as $$
declare
  v_client uuid;
begin
  -- Fast path for writes that don't touch identity (position stashes etc.)
  if tg_op = 'UPDATE'
     and new.name = old.name
     and new.name_key = old.name_key
     and new.movement_id is not null then
    return new;
  end if;
  select p.client_id into v_client
  from days d join programs p on p.id = d.program_id
  where d.id = new.day_id;
  if v_client is null then
    return new;
  end if;
  new.movement_id := ensure_movement(v_client, new.name, new.name_key);
  return new;
end;
$$;
drop trigger if exists exercises_movement on exercises;
create trigger exercises_movement
  before insert or update on exercises
  for each row execute function trg_exercises_movement();

create or replace function trg_derived_movement() returns trigger
language plpgsql as $$
begin
  new.movement_id := (
    select id from movements
    where client_id = new.client_id and legacy_name_key = new.exercise_name_key
  );
  return new;
end;
$$;
drop trigger if exists best_efforts_movement on best_efforts;
create trigger best_efforts_movement
  before insert or update of exercise_name_key on best_efforts
  for each row execute function trg_derived_movement();
drop trigger if exists stalled_history_movement on stalled_history;
create trigger stalled_history_movement
  before insert or update of exercise_name_key on stalled_history
  for each row execute function trg_derived_movement();
drop trigger if exists exercise_self_notes_movement on exercise_self_notes;
create trigger exercise_self_notes_movement
  before insert or update of exercise_name_key on exercise_self_notes
  for each row execute function trg_derived_movement();
drop trigger if exists historical_exposures_movement on historical_exposures;
create trigger historical_exposures_movement
  before insert or update of exercise_name_key on historical_exposures
  for each row execute function trg_derived_movement();

-- ---------------------------------------------------------------------------
-- weekly_exposures — materialized top set per (client, key, ISO week).
-- ---------------------------------------------------------------------------
create table if not exists weekly_exposures (
  client_id uuid not null references clients(id) on delete cascade,
  exercise_name_key text not null,
  movement_id uuid references movements(id) on delete set null,
  week_start date not null,
  top_weight numeric,
  top_unit text,
  top_reps int,
  top_set_rir int,
  session_count int not null default 0,
  top_e1rm_kg numeric,
  updated_at timestamptz not null default now(),
  primary key (client_id, exercise_name_key, week_start)
);
create index if not exists weekly_exposures_client_week_idx
  on weekly_exposures (client_id, week_start);
create index if not exists weekly_exposures_movement_idx
  on weekly_exposures (movement_id) where movement_id is not null;

drop trigger if exists weekly_exposures_movement on weekly_exposures;
create trigger weekly_exposures_movement
  before insert or update of exercise_name_key on weekly_exposures
  for each row execute function trg_derived_movement();

-- Rebuild all rows for weeks >= p_since from completed workouts. Only
-- loaded sets (weight + reps present) count; cardio is excluded.
create or replace function refresh_weekly_exposures(p_since date) returns int
language plpgsql as $$
declare
  v_count int;
begin
  delete from weekly_exposures where week_start >= p_since;

  with candidate as (
    select
      w.client_id,
      e.name_key,
      w.week_start::date as ws,
      w.id as workout_id,
      s.weight, s.unit, s.reps, s.rir,
      (case when s.unit = 'lb' then s.weight * 0.45359237 else s.weight end) as kg
    from sets s
    join exercise_logs el on el.id = s.exercise_log_id
    join workouts w on w.id = el.workout_id
    join exercises e on e.id = el.exercise_id
    where w.completed_at is not null
      and w.week_start >= p_since
      and s.weight is not null
      and s.reps is not null
  ),
  tops as (
    select distinct on (client_id, name_key, ws)
      client_id, name_key, ws, weight, unit, reps, rir, kg
    from candidate
    order by client_id, name_key, ws, kg desc, reps desc
  ),
  counts as (
    select client_id, name_key, ws, count(distinct workout_id) as n
    from candidate
    group by 1, 2, 3
  )
  insert into weekly_exposures
    (client_id, exercise_name_key, week_start, top_weight, top_unit,
     top_reps, top_set_rir, session_count, top_e1rm_kg)
  select
    t.client_id, t.name_key, t.ws, t.weight, t.unit, t.reps, t.rir,
    c.n, t.kg * (1 + t.reps / 30.0)
  from tops t
  join counts c
    on c.client_id = t.client_id and c.name_key = t.name_key and c.ws = t.ws;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Initial full backfill.
select refresh_weekly_exposures('2020-01-01'::date);

-- ---------------------------------------------------------------------------
-- get_block_bests — the workout-screen hot path in one round trip.
-- Semantics identical to the old loadBlockBests chain: scoped to the
-- program's days (both the workout's day and the exercise's day), bounded
-- at training_start_at falling back to uploaded_at, and NOT filtered on
-- completed_at so the in-progress session's earlier sets count.
-- ---------------------------------------------------------------------------
create or replace function get_block_bests(
  p_client_id uuid, p_program_id uuid, p_name_keys text[]
) returns table (name_key text, weight numeric, unit text, reps int)
language sql stable as $$
  with prog as (
    select coalesce(training_start_at, uploaded_at)::date as block_start
    from programs where id = p_program_id
  ),
  prog_days as (
    select id from days where program_id = p_program_id
  )
  select distinct on (e.name_key)
    e.name_key, s.weight, s.unit, s.reps
  from sets s
  join exercise_logs el on el.id = s.exercise_log_id
  join workouts w on w.id = el.workout_id
  join exercises e on e.id = el.exercise_id
  where w.client_id = p_client_id
    and w.day_id in (select id from prog_days)
    and e.day_id in (select id from prog_days)
    and e.name_key = any(p_name_keys)
    and s.weight is not null
    and s.reps is not null
    and ((select block_start from prog) is null
         or w.week_start >= (select block_start from prog))
  order by e.name_key,
    (case when s.unit = 'lb' then s.weight * 0.45359237 else s.weight end) desc,
    s.reps desc;
$$;
