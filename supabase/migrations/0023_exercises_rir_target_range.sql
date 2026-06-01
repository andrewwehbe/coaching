-- Stage 3 of the suggestion redesign — dynamic RIR prescription.
--
-- The existing exercises.rir_target is a freeform text column parsed
-- straight from coach sheets (e.g. "3 RIR", "0-2", "RIR 2-3") and
-- preserved as the coach's manual override. The Stage-3 prescription
-- engine ramps a numeric min/max target across the block based on
-- goal (inferred from rep_max), program week, and deload state — see
-- src/lib/signals/rir-prescription.ts.
--
-- Both columns are nullable so existing rows survive. When the
-- coach hasn't set them and the prescription engine has data, /today
-- shows the computed range; when the coach HAS set them (manual
-- override), those win. (Override-vs-compute precedence is enforced
-- in cue.ts.)
--
-- smallint is right-sized: RIR realistically lives in 0..10.

alter table exercises
  add column if not exists rir_target_min smallint
    check (rir_target_min is null or rir_target_min between 0 and 10),
  add column if not exists rir_target_max smallint
    check (rir_target_max is null or rir_target_max between 0 and 10);

-- Range invariant: when both are set, min must be ≤ max.
alter table exercises drop constraint if exists exercises_rir_target_range_check;
alter table exercises add constraint exercises_rir_target_range_check
  check (
    rir_target_min is null
    or rir_target_max is null
    or rir_target_min <= rir_target_max
  );
