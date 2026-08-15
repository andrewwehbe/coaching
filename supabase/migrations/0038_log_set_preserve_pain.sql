-- 0038: stop set edits from clobbering a pain status.
-- log_set's exercise_log upsert unconditionally set status='completed', so
-- a client who reported pain (status='pain') and then edited an earlier
-- set — e.g. fixing a typo on set 1 logged before the pain report — had
-- the pain flag silently erased. Pain classification feeds the signals
-- engine's recurrence ladder, so that's clinical data loss.
--
-- New rule: 'pain' is preserved; anything else ('skipped', null,
-- 'completed') becomes 'completed' — logging actual work means the
-- exercise wasn't skipped. Only the ON CONFLICT branch changes.

create or replace function log_set(
  p_token text,
  p_workout_id uuid,
  p_exercise_id uuid,
  p_set_number int,
  p_weight numeric,
  p_unit text,
  p_reps int,
  p_rir int,
  p_cardio_minutes int,
  p_video_path text,
  p_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hashed text := 'sha256:' || encode(sha256(convert_to(p_token, 'utf8')), 'hex');
  v_session public.sessions%rowtype;
  v_client_id uuid;
  v_workout public.workouts%rowtype;
  v_exercise public.exercises%rowtype;
  v_log_id uuid;
  v_set_id uuid;
  v_best public.best_efforts%rowtype;
  v_had_best boolean := false;
  v_new_kg numeric;
  v_cur_kg numeric;
  v_is_pr boolean := false;
  v_prev jsonb := null;
begin
  select * into v_session
  from public.sessions
  where id in (v_hashed, p_token) and not revoked and expires_at > now()
  limit 1;
  if not found or v_session.user_type <> 'client' then
    return jsonb_build_object('error', 'unauthorized');
  end if;

  select id into v_client_id
  from public.clients
  where id = v_session.user_id and active;
  if not found then
    return jsonb_build_object('error', 'unauthorized');
  end if;

  select * into v_workout
  from public.workouts
  where id = p_workout_id and client_id = v_client_id and completed_at is null;
  if not found then
    return jsonb_build_object('error', 'unauthorized');
  end if;

  select * into v_exercise
  from public.exercises
  where id = p_exercise_id and day_id = v_workout.day_id;
  if not found then
    return jsonb_build_object('error', 'exercise_mismatch');
  end if;

  -- Storage paths are namespaced {clientId}/... by the presign routes.
  if p_video_path is not null and p_video_path not like v_client_id || '/%' then
    return jsonb_build_object('error', 'invalid_video_path');
  end if;

  insert into public.exercise_logs (workout_id, exercise_id, status)
  values (p_workout_id, p_exercise_id, 'completed')
  on conflict (workout_id, exercise_id) do update
    -- Preserve a pain report; logging work overrides 'skipped'.
    set status = case
      when exercise_logs.status = 'pain' then exercise_logs.status
      else 'completed'
    end
  returning id into v_log_id;

  insert into public.sets
    (exercise_log_id, set_number, weight, unit, reps, rir,
     cardio_minutes, video_url, notes)
  values
    (v_log_id, p_set_number, p_weight, p_unit, p_reps, p_rir,
     p_cardio_minutes, p_video_path, p_notes)
  on conflict (exercise_log_id, set_number) do update set
    weight = excluded.weight,
    unit = excluded.unit,
    reps = excluded.reps,
    rir = excluded.rir,
    cardio_minutes = excluded.cardio_minutes,
    video_url = excluded.video_url,
    notes = excluded.notes
  returning id into v_set_id;

  if not coalesce(v_exercise.is_cardio, false)
     and p_weight is not null
     and p_reps is not null
     and coalesce(v_exercise.name_key, '') <> '' then

    select * into v_best
    from public.best_efforts
    where client_id = v_client_id and exercise_name_key = v_exercise.name_key;
    v_had_best := found;

    v_new_kg := case when p_unit = 'lb' then p_weight * 0.45359237 else p_weight end;

    if not v_had_best or v_best.best_weight is null then
      v_is_pr := true;
    else
      v_cur_kg := case when v_best.best_unit = 'lb'
                       then v_best.best_weight * 0.45359237
                       else v_best.best_weight end;
      if v_new_kg > v_cur_kg + 0.001 then
        v_is_pr := true;
      elsif v_new_kg >= v_cur_kg - 0.001 then
        -- Tie band: more reps wins.
        v_is_pr := (v_best.best_reps is null or p_reps > v_best.best_reps);
      end if;
    end if;

    if v_is_pr then
      if v_had_best and v_best.best_weight is not null then
        v_prev := jsonb_build_object(
          'weight', v_best.best_weight,
          'unit', v_best.best_unit,
          'reps', v_best.best_reps
        );
      end if;
      insert into public.best_efforts
        (client_id, exercise_name_key, best_weight, best_unit, best_reps,
         source_set_id, pinned, updated_at)
      values
        (v_client_id, v_exercise.name_key, p_weight, p_unit, p_reps,
         v_set_id, false, now())
      on conflict (client_id, exercise_name_key) do update set
        best_weight = excluded.best_weight,
        best_unit = excluded.best_unit,
        best_reps = excluded.best_reps,
        source_set_id = excluded.source_set_id,
        -- An automatic PR clears any manual pin.
        pinned = false,
        updated_at = now();
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'set_id', v_set_id,
    'log_id', v_log_id,
    'pr', case when v_is_pr then jsonb_build_object('prev', v_prev) else null end
  );
end;
$$;
