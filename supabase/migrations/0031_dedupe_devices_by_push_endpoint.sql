-- A push endpoint identifies one physical browser, and that browser shows
-- exactly one person's notifications at a time. On a shared device (e.g. a
-- coach switching between client accounts) the same endpoint stayed attached to
-- every account that ever logged in there, so each account fired its own push
-- to that one device — the "double notifications" bug.
--
-- Collapse to the most recently seen row per endpoint, then enforce that an
-- endpoint maps to a single device row going forward. The subscribe route
-- claims an endpoint for the current user (evicting other accounts' rows) and
-- logout detaches it, so this invariant holds at the application layer too.

delete from devices d
using (
  select id,
         row_number() over (
           partition by push_subscription->>'endpoint'
           order by last_seen_at desc nulls last, created_at desc
         ) as rn
  from devices
  where push_subscription->>'endpoint' is not null
) ranked
where d.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists devices_push_endpoint_uniq
  on devices ((push_subscription->>'endpoint'))
  where push_subscription->>'endpoint' is not null;
