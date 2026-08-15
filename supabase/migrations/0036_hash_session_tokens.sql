-- 0036: stop storing raw session bearer tokens.
-- sessions.id previously held the raw cookie token, so any DB read leak
-- yielded live 365-day credentials for every user. New sessions store
-- 'sha256:' || hex(sha256(token)) as the id; the cookie keeps the raw
-- token and lookups hash it. Raw tokens and sha256 hex are both 64 hex
-- chars, so the 'sha256:' prefix is what distinguishes migrated rows.
--
-- Rollout order (dual-lookup makes every step safe):
--   1. this function update (hashed lookup with raw fallback)
--   2. app deploy (inserts hashed ids, compares both forms)
--   3. one-time rehash of remaining raw rows:
--      update sessions
--        set id = 'sha256:' || encode(sha256(convert_to(id, 'utf8')), 'hex')
--        where id not like 'sha256:%';

create or replace function get_session_user(p_token text, p_ip text, p_ua text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.sessions%rowtype;
  v_hashed text := 'sha256:' || encode(sha256(convert_to(p_token, 'utf8')), 'hex');
  result jsonb;
begin
  select * into s
  from public.sessions
  where id = v_hashed
    and not revoked
    and expires_at > now();

  if not found then
    -- Legacy raw-token row (pre-0036 session). Kept until the one-time
    -- rehash converts them; harmless afterwards.
    select * into s
    from public.sessions
    where id = p_token
      and not revoked
      and expires_at > now();
  end if;

  if not found then
    return null;
  end if;

  if s.user_type = 'coach' then
    select jsonb_build_object(
      'type', 'coach',
      'id', c.id,
      'name', c.name
    ) into result
    from public.coaches c
    where c.id = s.user_id;
  else
    select jsonb_build_object(
      'type', 'client',
      'id', c.id,
      'name', c.name,
      'greeting_name', c.greeting_name,
      'active', c.active
    ) into result
    from public.clients c
    where c.id = s.user_id;
  end if;

  if result is null then
    return null;
  end if;

  -- Throttled touch: the /settings session list only needs coarse freshness.
  if s.last_used_at is null or s.last_used_at < now() - interval '5 minutes' then
    update public.sessions
    set last_used_at = now(),
        last_used_ip = coalesce(p_ip, last_used_ip),
        last_used_ua = coalesce(p_ua, last_used_ua)
    where id = s.id;
  end if;

  return result;
end;
$$;
