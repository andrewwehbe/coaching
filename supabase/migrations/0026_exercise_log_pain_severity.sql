-- Stage 4 — structured pain severity on exercise_logs.
--
-- Until now the graded-pain ladder (signals/pain.ts) classifies severity
-- from keyword scanning of pain_reason + client_note. That works for
-- mild/recurring/red_flag triage but it can't distinguish a 4/10 ache
-- from an 8/10 sharp pain inside the "mild" bucket — both miss the
-- red-flag regex. A structured 0..10 column lets the client log a
-- severity number directly (UI prompts when pain_reason is set), and
-- signals/pain.ts can prefer the explicit number over the keyword guess
-- when both are present.
--
-- Nullable so existing rows survive. signals/pain.ts treats null as
-- "not provided, fall back to keyword scan" — preserves the current
-- behavior for un-migrated rows.

alter table exercise_logs
  add column if not exists pain_severity smallint
    check (pain_severity is null or pain_severity between 0 and 10);
