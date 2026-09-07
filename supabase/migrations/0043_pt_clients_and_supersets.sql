-- 0043: personal-training clients + supersets.
--
-- Two unrelated-looking additions that share one migration because both are
-- pure column adds on existing tables and both need the program-write RPCs
-- from 0039 re-issued.
--
-- 1. client_type
--    The roster has always been one kind of person: an online client who
--    signs in with a PIN and logs their own sets. In-person PT clients do
--    not sign in at all — the coach logs every session on their behalf via
--    /coach/clients/[id]/log. Marking them lets the UI drop PIN affordances
--    for them instead of issuing a credential nobody uses.
--
-- 2. pin_hash becomes nullable
--    Follows directly from the above: a PT client has no PIN, so there is no
--    hash to store. A sentinel value would be worse — it would be a real
--    bcrypt hash of *something*, and therefore loginable. NULL is the honest
--    representation. attemptPinLogin (src/lib/auth.ts) grows an explicit
--    guard so a null hash can never satisfy checkPin, and generateUniquePin
--    (src/lib/pin.ts) filters nulls out of its collision scan.
--
-- 3. superset_group
--    Exercises on the same day sharing a non-null superset_group are
--    performed as a superset: one set of each, then rest, then repeat.
--    Null means the exercise stands alone, which is every existing row.
--    The group is scoped per day, not per program — the same pairing on
--    Day 1 and Day 3 gets its own number on each, matching how position
--    and name_key already behave.
--
--    Deliberately a plain smallint rather than a supersets table: a group
--    carries no attributes of its own, and the editor already rewrites the
--    whole day's exercise list on every save, so a join table would add a
--    second thing to keep in sync for no gain. The UI restricts a group to
--    two exercises; the column does not, so trisets are a UI change later.

alter table clients
  add column if not exists client_type text not null default 'online'
    check (client_type in ('online', 'pt'));

alter table clients
  alter column pin_hash drop not null;

alter table exercises
  add column if not exists superset_group smallint;

-- Partial: the vast majority of rows are solo and would only bloat the index.
create index if not exists exercises_superset_idx
  on exercises (day_id, superset_group)
  where superset_group is not null;

-- No new tables, so no RLS statements: both tables already have RLS enabled
-- and deny-all for the web roles (0042), and adding a column inherits that.

-- ---------------------------------------------------------------------------
-- Re-issue the two program-write functions from 0039 so superset_group
-- survives a sheet commit and an in-place edit. Everything else about them
-- is unchanged; both keep `security definer` + a pinned search_path, and
-- `create or replace` preserves the existing (service_role-only) grants
-- established by 0042.
-- ---------------------------------------------------------------------------

create or replace function commit_program(
  p_client_id uuid,
  p_program_id uuid,
  p_source_filename text,
  p_days jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d jsonb;
  e jsonb;
  v_day_id uuid;
  di int := 0;
  ei int;
begin
  perform 1 from public.clients where id = p_client_id;
  if not found then
    return jsonb_build_object('error', 'client_not_found');
  end if;

  update public.programs
  set active = false
  where client_id = p_client_id and active;

  insert into public.programs (id, client_id, source_filename, active)
  values (p_program_id, p_client_id, p_source_filename, true);

  for d in select * from jsonb_array_elements(p_days) loop
    di := di + 1;
    insert into public.days (program_id, day_index, label)
    values (p_program_id, di, d->>'label')
    returning id into v_day_id;

    ei := 0;
    for e in select * from jsonb_array_elements(d->'exercises') loop
      ei := ei + 1;
      insert into public.exercises
        (day_id, position, name, name_key, prescription_raw, prescribed_sets,
         rep_min, rep_max, rir_target, is_cardio, cardio_type, superset_group)
      values
        (v_day_id, ei, e->>'name', e->>'name_key', e->>'prescription_raw',
         (e->>'prescribed_sets')::int, (e->>'rep_min')::int,
         (e->>'rep_max')::int, e->>'rir_target',
         coalesce((e->>'is_cardio')::boolean, false), e->>'cardio_type',
         (e->>'superset_group')::smallint);
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'program_id', p_program_id);
end;
$$;

create or replace function save_program_edit(
  p_client_id uuid,
  p_program_id uuid,
  p_days jsonb,
  p_archive_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d jsonb;
  e jsonb;
  v_day_id uuid;
begin
  perform 1 from public.programs
  where id = p_program_id and client_id = p_client_id and active;
  if not found then
    return jsonb_build_object('error', 'program_not_found');
  end if;

  set constraints public.days_program_id_day_index_key deferred;

  if coalesce(array_length(p_archive_ids, 1), 0) > 0 then
    update public.exercises ex
    set archived_at = now()
    from public.days dd
    where ex.id = any(p_archive_ids)
      and ex.day_id = dd.id
      and dd.program_id = p_program_id
      and ex.archived_at is null;
  end if;

  update public.exercises ex
  set position = ex.position + 100000
  from public.days dd
  where ex.day_id = dd.id
    and dd.program_id = p_program_id
    and ex.archived_at is null;

  for d in select * from jsonb_array_elements(p_days) loop
    v_day_id := (d->>'id')::uuid;
    if (d->>'is_new')::boolean then
      insert into public.days (id, program_id, day_index, label)
      values (v_day_id, p_program_id, (d->>'day_index')::int, d->>'label');
    else
      update public.days
      set day_index = (d->>'day_index')::int, label = d->>'label'
      where id = v_day_id and program_id = p_program_id;
      if not found then
        raise exception 'day % is not part of program %', v_day_id, p_program_id;
      end if;
    end if;

    for e in select * from jsonb_array_elements(d->'exercises') loop
      if (e->>'is_new')::boolean then
        insert into public.exercises
          (id, day_id, position, name, name_key, prescription_raw,
           prescribed_sets, rep_min, rep_max, rir_target, is_cardio,
           coach_note, muscle_group, superset_group)
        values
          ((e->>'id')::uuid, v_day_id, (e->>'position')::int, e->>'name',
           e->>'name_key', e->>'prescription_raw', (e->>'prescribed_sets')::int,
           (e->>'rep_min')::int, (e->>'rep_max')::int, e->>'rir_target',
           coalesce((e->>'is_cardio')::boolean, false),
           e->>'coach_note', e->>'muscle_group',
           (e->>'superset_group')::smallint);
      else
        update public.exercises
        set position = (e->>'position')::int,
            name = e->>'name',
            name_key = e->>'name_key',
            prescription_raw = e->>'prescription_raw',
            prescribed_sets = (e->>'prescribed_sets')::int,
            rep_min = (e->>'rep_min')::int,
            rep_max = (e->>'rep_max')::int,
            rir_target = e->>'rir_target',
            is_cardio = coalesce((e->>'is_cardio')::boolean, false),
            coach_note = e->>'coach_note',
            muscle_group = e->>'muscle_group',
            superset_group = (e->>'superset_group')::smallint,
            archived_at = null
        where id = (e->>'id')::uuid and day_id = v_day_id;
        if not found then
          raise exception 'exercise % is not part of day %', e->>'id', v_day_id;
        end if;
      end if;
    end loop;
  end loop;

  perform 1
  from public.exercises ex
  join public.days dd on dd.id = ex.day_id
  where dd.program_id = p_program_id
    and ex.archived_at is null
    and ex.position >= 100000;
  if found then
    raise exception 'payload did not account for all live exercises';
  end if;

  update public.programs
  set last_edited_at = now()
  where id = p_program_id;

  return jsonb_build_object('ok', true);
end;
$$;
