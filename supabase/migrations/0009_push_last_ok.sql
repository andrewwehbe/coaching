-- Track when each push subscription last successfully delivered. Without
-- this, expired-but-not-yet-rejected subs sit in the devices table forever
-- and consume per-push round-trips.
--
-- Cleanup heuristic: a device whose `last_pushed_ok_at` is null AND
-- whose `created_at` is older than 30 days has likely never delivered;
-- a device whose `last_pushed_ok_at` is older than 60 days has gone
-- silent. Pruning happens in the daily-analysis cron.

alter table devices add column if not exists last_pushed_ok_at timestamptz;

create index if not exists devices_last_pushed_ok_idx on devices (last_pushed_ok_at);
