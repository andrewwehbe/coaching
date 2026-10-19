-- One exercise, one track: the same exercise on several days of a program
-- shares one name_key, so its best, cue and plateau tracking stay in step
-- across the week (Andrew, 2026-10-19).
--
-- The editor, sheet upload and spec script already collate (first day's
-- key wins). Two gaps left programs split:
--
--   1. swap_exercises (suggestion apply) built each replacement's key
--      from its own day ('d' || day_index), so swapping a lift that sits
--      on Day 1 and Day 3 produced d1:: and d3:: twins. It now reuses the
--      key the program already has for that exercise, else the key of
--      the lowest day being swapped.
--   2. Programs created before collation existed. Backfilled below.
--
-- Rekeying an exercises row fires the movement trigger, which re-points
-- the movement and migrates derived rows; migrate_movement_key is called
-- again per pair as a no-op safety net (best_efforts: the better lift
-- survives).

create or replace function swap_exercises(
  p_client_id uuid,
  p_exercise_ids uuid[],
  p_replacement_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_foreign int;
  v_active_ids uuid[];
  v_replaced int;
  v_program_id uuid;
  v_key text;
begin
  select count(*) into v_foreign
  from unnest(p_exercise_ids) as t(id)
  where not exists (
    select 1
    from public.exercises ex
    join public.days dd on dd.id = ex.day_id
    join public.programs p on p.id = dd.program_id
    where ex.id = t.id and p.client_id = p_client_id
  );
  if v_foreign > 0 then
    return jsonb_build_object('error', 'ownership_mismatch');
  end if;

  select coalesce(array_agg(ex.id), '{}') into v_active_ids
  from public.exercises ex
  join public.days dd on dd.id = ex.day_id
  join public.programs p on p.id = dd.program_id
  where ex.id = any(p_exercise_ids)
    and ex.archived_at is null
    and p.client_id = p_client_id;

  if coalesce(array_length(v_active_ids, 1), 0) = 0 then
    return jsonb_build_object('error', 'no_active_matches');
  end if;

  -- One key for every replacement row: the program's existing key for
  -- this exercise if it already appears on a day we are not swapping,
  -- else the lowest swapped day's key.
  select dd.program_id into v_program_id
  from public.exercises ex join public.days dd on dd.id = ex.day_id
  where ex.id = v_active_ids[1];

  select ex.name_key into v_key
  from public.exercises ex join public.days dd on dd.id = ex.day_id
  where dd.program_id = v_program_id
    and ex.archived_at is null
    and not (ex.id = any(v_active_ids))
    and movement_norm(ex.name) = movement_norm(p_replacement_name)
  order by dd.day_index, ex.position
  limit 1;

  if v_key is null then
    select 'd' || min(dd.day_index) || '::' || movement_norm(p_replacement_name) into v_key
    from public.exercises ex join public.days dd on dd.id = ex.day_id
    where ex.id = any(v_active_ids);
  end if;

  update public.exercises
  set archived_at = now()
  where id = any(v_active_ids);

  insert into public.exercises
    (day_id, position, name, name_key, prescription_raw, prescribed_sets,
     rep_min, rep_max, rir_target, is_cardio, cardio_type)
  select
    ex.day_id, ex.position, p_replacement_name, v_key,
    ex.prescription_raw, ex.prescribed_sets, ex.rep_min, ex.rep_max,
    ex.rir_target, false, null
  from public.exercises ex
  where ex.id = any(v_active_ids);

  get diagnostics v_replaced = row_count;
  return jsonb_build_object('ok', true, 'replaced', v_replaced);
end;
$$;

-- create or replace keeps the existing ACL (0042: no PUBLIC/anon/
-- authenticated execute); restated so this file stands on its own.
revoke execute on function swap_exercises(uuid, uuid[], text) from public, anon, authenticated;

-- Backfill: in every active program, each exercise takes the key of its
-- first occurrence (lowest day, then position).
do $$
declare
  r record;
begin
  for r in
    with rows as (
      select p.client_id, p.id as program_id, e.id, e.name_key, d.day_index, e.position,
             movement_norm(e.name) as norm
      from exercises e
      join days d on d.id = e.day_id
      join programs p on p.id = d.program_id and p.active
      where e.archived_at is null
    ),
    canon as (
      select distinct on (program_id, norm) program_id, norm, name_key as canon_key
      from rows
      order by program_id, norm, day_index, position
    )
    select rows.client_id, rows.id, rows.name_key as old_key, canon.canon_key
    from rows join canon using (program_id, norm)
    where rows.name_key <> canon.canon_key
  loop
    update exercises set name_key = r.canon_key where id = r.id;
    perform migrate_movement_key(r.client_id, r.old_key, r.canon_key);
  end loop;
end $$;
