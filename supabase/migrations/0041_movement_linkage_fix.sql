-- 0041: two linkage refinements on 0040.
-- 1. trg_derived_movement only fills movement_id when it's null, so
--    writers that already know the movement (refresh_weekly_exposures
--    below) aren't overwritten by the legacy-key lookup — which misses
--    rows keyed under an OLD program's key.
-- 2. refresh_weekly_exposures sources movement_id straight from the
--    exercise row (exercises.movement_id is authoritative), linking
--    exposures from old programs that the legacy-key lookup can't reach.

create or replace function trg_derived_movement() returns trigger
language plpgsql as $$
begin
  if new.movement_id is null then
    new.movement_id := (
      select id from movements
      where client_id = new.client_id and legacy_name_key = new.exercise_name_key
    );
  end if;
  return new;
end;
$$;

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
      e.movement_id,
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
      client_id, name_key, movement_id, ws, weight, unit, reps, rir, kg
    from candidate
    order by client_id, name_key, ws, kg desc, reps desc
  ),
  counts as (
    select client_id, name_key, ws, count(distinct workout_id) as n
    from candidate
    group by 1, 2, 3
  )
  insert into weekly_exposures
    (client_id, exercise_name_key, movement_id, week_start, top_weight,
     top_unit, top_reps, top_set_rir, session_count, top_e1rm_kg)
  select
    t.client_id, t.name_key, t.movement_id, t.ws, t.weight, t.unit,
    t.reps, t.rir, c.n, t.kg * (1 + t.reps / 30.0)
  from tops t
  join counts c
    on c.client_id = t.client_id and c.name_key = t.name_key and c.ws = t.ws;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Re-run the full backfill with movement sourcing.
select refresh_weekly_exposures('2020-01-01'::date);
