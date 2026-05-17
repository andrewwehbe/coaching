-- Snapshot history for the active program. The existing program/save
-- route mutates days + exercises in place (that's the editing model),
-- which means after a few edits we lose "what did this program look
-- like when the recommendation fired?" — important for the audit log
-- introduced in 0020_recommendations.
--
-- Pure additive:
--   - new program_revisions table (inserts only)
--   - the save and commit routes will insert a row alongside their
--     existing writes (separate concern from the mutate-in-place flow)
--   - one row per active program is backfilled below so existing
--     programs have a baseline revision; programs / days / exercises
--     themselves are NOT touched.
--
-- snapshot is the full days + exercises payload as JSON so the
-- revision is interpretable on its own without joining back to
-- (potentially-mutated) days/exercises rows.

create table if not exists program_revisions (
  id              uuid primary key default gen_random_uuid(),
  program_id      uuid not null references programs(id) on delete cascade,
  version_number  int  not null,
  created_at      timestamptz not null default now(),
  edited_by       uuid references coaches(id) on delete set null,
  -- 'sheet_upload' = new program created from .xlsx (commit route)
  -- 'edit'         = in-place mutation via the editor (save route)
  -- 'backfill'     = one-time snapshot of pre-existing programs at
  --                  migration time
  reason          text not null
                  check (reason in ('sheet_upload','edit','backfill')),
  snapshot        jsonb not null,
  unique (program_id, version_number)
);

create index if not exists program_revisions_program_created_idx
  on program_revisions (program_id, created_at desc);

-- One-time backfill: snapshot the current state of every program as
-- version 1, reason 'backfill'. Skips programs that already have a
-- revision row (idempotent — safe to re-run). No writes to
-- programs/days/exercises.
insert into program_revisions (program_id, version_number, reason, snapshot)
select
  p.id,
  1,
  'backfill',
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'day_id', d.id,
          'day_index', d.day_index,
          'label', d.label,
          'exercises', coalesce(
            (
              select jsonb_agg(
                jsonb_build_object(
                  'id', e.id,
                  'position', e.position,
                  'name', e.name,
                  'name_key', e.name_key,
                  'prescription_raw', e.prescription_raw,
                  'prescribed_sets', e.prescribed_sets,
                  'rep_min', e.rep_min,
                  'rep_max', e.rep_max,
                  'rir_target', e.rir_target,
                  'is_cardio', e.is_cardio,
                  'coach_note', e.coach_note,
                  'muscle_group', e.muscle_group,
                  'archived_at', e.archived_at
                )
                order by e.position
              )
              from exercises e
              where e.day_id = d.id
            ),
            '[]'::jsonb
          )
        )
        order by d.day_index
      )
      from days d
      where d.program_id = p.id
    ),
    '[]'::jsonb
  )
from programs p
where not exists (
  select 1 from program_revisions r where r.program_id = p.id
);
