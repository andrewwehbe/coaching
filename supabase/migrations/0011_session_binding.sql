-- Bind each session to the IP and User-Agent it was last used from. Lets
-- the user (coach or client) see and revoke individual sessions, instead
-- of "this cookie is valid for 365 days, no questions asked." Updated
-- whenever readSession() touches last_used_at, so the data tracks the
-- live device rather than only the issue-time fingerprint.

alter table sessions add column if not exists last_used_ip text;
alter table sessions add column if not exists last_used_ua text;
