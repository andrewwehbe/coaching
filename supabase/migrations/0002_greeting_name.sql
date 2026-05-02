-- Per-client greeting override. The `name` column stays the canonical name
-- the coach sees (e.g. "ClientH M", "ClientH Lastname"); `greeting_name`
-- is what we say to the client themselves on /today (e.g. "Hey, George").
-- Falls back to `name` when null.
alter table clients add column if not exists greeting_name text;
