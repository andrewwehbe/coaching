-- Stage 3 of the suggestion redesign — is_compound flag.
--
-- Feeds the Stage-3 RIR prescriber: compound lifts get a floor of
-- COMPOUND_RIR_FLOOR (1 RIR) regardless of goal band, because (a)
-- heavy compounds have worse RIR-estimation accuracy in trained
-- lifters, (b) skill cost of a missed rep is higher on free-weight
-- multi-joint movements, and (c) the brief explicitly anchors the
-- "rarely 0 RIR on compounds" rule.
--
-- Nullable so existing rows survive. The coach can edit this in the
-- program editor; a separate one-shot backfill script
-- (scripts/backfill-is-compound.ts) seeds initial values from
-- name_key keyword heuristics. The backfill is intentionally NOT in
-- this migration per the established pattern (migrations stay schema-
-- only; data seeding lives in scripts/ where the coach can review
-- the dry-run output before applying).
--
-- Null on this column means "unclassified" — the prescriber treats
-- nulls conservatively (no compound floor applied).

alter table exercises
  add column if not exists is_compound boolean;

create index if not exists exercises_is_compound_idx
  on exercises (is_compound)
  where is_compound is not null;
