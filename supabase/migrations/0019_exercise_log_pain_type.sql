-- Slice 5b of the program-recommender work — capture pain TYPE alongside
-- the free-text reason so the recommender can apply distinct rules per
-- the clinical model (see research brief Q5):
--
--   joint   — sharp, in-joint (knee/shoulder). Most conservative:
--             2 incidents on the same exercise within 2 weeks → mandatory
--             swap. Worst risk asymmetry.
--   tendon  — localized to a tendon (patellar, Achilles, elbow). Loads
--             often help; only escalates to a mandatory swap when pain
--             rises across exposures or fails to settle within 24h.
--   muscle  — diffuse, post-session DOMS-like. Never auto-removes; this
--             is a normal training response.
--
-- Nullable so existing pain_reason rows survive and the recommender can
-- treat them under the conservative joint rule until the client picks a
-- type on subsequent reports.

alter table exercise_logs
  add column if not exists pain_type text
  check (pain_type is null or pain_type in ('joint','tendon','muscle'));
