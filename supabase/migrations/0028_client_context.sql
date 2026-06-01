-- Stage 6 Piece 1 — client_context store.
--
-- Persistent, app-remembered explanation of why a client's
-- adherence/behaviour looks the way it does. Single source the gate,
-- the anomaly notifier (Piece 2), and the weekly note all read via
-- signals/client-context.getActiveClientContext.
--
-- Single-active-per-client enforced BY CONSTRUCTION via a partial
-- unique index on (client_id) WHERE resolved_at IS NULL — a second
-- unresolved row for the same client fails at the database, no
-- application-level check needed. Supersede flow (Piece 3) wraps
-- "resolved_at = now() on prior, INSERT new" in a transaction so the
-- index never sees two unresolved rows simultaneously.
--
-- Non-destructive: contexts are never deleted; expiry is a timestamp
-- (resolved_at). A row whose review_at is past `now` is treated as
-- STALE by the helper and stops applying — but the row stays for
-- audit.
--
-- reason_code enum lives in the CHECK constraint. Adding a code
-- requires a constraint-update migration (0004/0006 drop-and-recreate
-- pattern) plus the signals/client-context.getContextDirective switch
-- arm in the same commit. The directive is the single source — every
-- downstream surface reads it.

create table if not exists client_context (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  reason_code text not null check (reason_code in (
    'onboarding',
    'health',
    'injury',
    'travel',
    'life_stress',
    'planned_break',
    'at_risk',
    'paused'
  )),
  note text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  review_at timestamptz,
  resolved_at timestamptz
);

-- Single-active enforcement by construction.
create unique index if not exists client_context_one_active_per_client
  on client_context (client_id)
  where resolved_at is null;

-- For the per-client history view (Piece 3 coach UI eventually shows
-- the timeline of resolved contexts).
create index if not exists client_context_client_id_idx
  on client_context (client_id);
