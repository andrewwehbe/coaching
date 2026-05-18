-- Add a third log_mode 'all'. UX: multi-set logging on ONE screen per
-- exercise (no per-set "Next" affordance) and, on next session, show the
-- full set of prior sets instead of a Beat-X cue. Per ClientE's request.
alter table clients drop constraint if exists clients_log_mode_check;
alter table clients add constraint clients_log_mode_check
  check (log_mode in ('sets','best','all'));
