<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Post-migration checklist (every migration that touches the DB)

The app talks to Supabase exclusively through the service role
(`src/lib/supabase.ts`), which bypasses RLS and privilege checks — so the
correct posture for the PostgREST surface is deny-everything for the web
roles (`public`, `anon`, `authenticated`). Migration 0042 established
this; every migration after it must keep it true. History says this gets
forgotten: 0032 shipped a table without RLS, 0040 shipped two more plus
six functions with default PUBLIC execute — anon could call
program-mutating RPCs until 0042 closed it.

For every **new table**:

- [ ] `alter table <t> enable row level security;` in the same migration.
      No policies — deny-all is the design, not an omission.

For every **new function**:

- [ ] Pin the search path: `set search_path = public` in the definition
      (or `alter function ... set search_path = public`).
- [ ] Web roles must not be able to execute it. 0042 altered default
      privileges so new functions no longer get PUBLIC execute
      automatically, but verify — and never `grant execute ... to anon /
      authenticated / public`. Only `service_role` (plus trigger use)
      should be able to call anything.
- [ ] If it's `security definer`, treat the two lines above as mandatory,
      not advisory: definer functions run with owner privileges and most
      of ours do auth in the route layer, not in SQL.

After applying:

- [ ] Run the Supabase security advisor (dashboard → Advisors, or the MCP
      `get_advisors` tool) and get back to zero ERROR/WARN findings.
      INFO-level "RLS enabled, no policy" on every table is the expected
      steady state.
- [ ] Migrations are applied to prod by hand/MCP, so before adding a
      constraint that assumes existing state (uniques, CHECKs), drift-check
      prod first; use `not valid` when historical rows can't conform yet.
