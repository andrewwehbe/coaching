-- 0042: close the PostgREST surface (Supabase advisor findings, and one
-- real hole of our own making).
--
-- 1. RLS on the three tables missing it: exercise_self_notes (predates
--    the RLS pass) and the new movements / weekly_exposures from 0040.
--    Enabled with NO policies = deny-all for anon/authenticated; the app
--    only ever connects with the service role, which bypasses RLS.
-- 2. The serious one: our SECURITY DEFINER functions were executable by
--    the anon role via /rest/v1/rpc/* (Postgres grants EXECUTE to PUBLIC
--    by default). log_set/get_session_user gate on a session token, but
--    commit_program / save_program_edit / swap_exercises /
--    increment_prescribed_sets trust the route-layer coach guard — so
--    anyone holding the anon key could have rewritten programs. Revoke
--    EXECUTE from public/anon/authenticated on every custom function;
--    the service role keeps access.
-- 3. Pin search_path on the 0040 functions (mutable-search-path lint).

alter table exercise_self_notes enable row level security;
alter table movements enable row level security;
alter table weekly_exposures enable row level security;

alter function movement_norm(text) set search_path = public;
alter function migrate_movement_key(uuid, text, text) set search_path = public;
alter function ensure_movement(uuid, text, text) set search_path = public;
alter function trg_exercises_movement() set search_path = public;
alter function trg_derived_movement() set search_path = public;
alter function get_block_bests(uuid, uuid, text[]) set search_path = public;
alter function refresh_weekly_exposures(date) set search_path = public;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'movement_norm(text)',
    'migrate_movement_key(uuid, text, text)',
    'ensure_movement(uuid, text, text)',
    'trg_exercises_movement()',
    'trg_derived_movement()',
    'get_block_bests(uuid, uuid, text[])',
    'refresh_weekly_exposures(date)',
    'get_session_user(text, text, text)',
    'log_set(text, uuid, uuid, int, numeric, text, int, int, int, text, text)',
    'commit_program(uuid, uuid, text, jsonb)',
    'save_program_edit(uuid, uuid, jsonb, uuid[])',
    'swap_exercises(uuid, uuid[], text)',
    'increment_prescribed_sets(uuid, uuid[])'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

-- New functions created later must not silently regain PUBLIC execute.
alter default privileges in schema public revoke execute on functions from public;
