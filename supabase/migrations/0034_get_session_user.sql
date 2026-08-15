-- 0034: one-round-trip session resolution.
-- readSession previously cost 2 sequential queries (sessions, then coaches/clients)
-- plus an unconditional touch UPDATE on every request. This function does the
-- lookup + a throttled touch (at most once per 5 minutes) in a single call.
-- Returns null when the token is unknown, revoked, expired, or the user row
-- is gone.

create or replace function get_session_user(p_token text, p_ip text, p_ua text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.sessions%rowtype;
  result jsonb;
begin
  select * into s
  from public.sessions
  where id = p_token
    and not revoked
    and expires_at > now();

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
    where id = p_token;
  end if;

  return result;
end;
$$;
