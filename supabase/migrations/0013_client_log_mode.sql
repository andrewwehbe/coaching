-- Some clients prefer to log every set; others find that tedious and
-- just want to log one summary "best set" per exercise (since the cue
-- + plateau analysis only care about the top set anyway). This column
-- lets the coach configure the preferred mode per client.
--
--   sets — full per-set logging (default, existing behaviour)
--   best — one entry per exercise, treated as the session's best
--          (and the exercise marks complete on submit)

alter table clients
  add column if not exists log_mode text not null default 'sets'
  check (log_mode in ('sets','best'));
