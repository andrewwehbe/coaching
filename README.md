# Coaching

A production fitness-coaching PWA used by a real coach and roughly 50 paying clients. Clients log workouts on their phone; a nightly analysis engine detects plateaus, fatigue, RIR drift and pain flags, then drafts a weekly note the coach approves in one tap.

## Stack

- **Next.js 16** (App Router, React 19, Tailwind CSS 4) deployed on Vercel
- **Supabase / Postgres** as the only data store - 33 SQL migrations in `supabase/migrations/`, all access through the server via the service-role key (no client-side Supabase)
- **PIN auth** - 5-digit PINs, bcrypt-hashed with an optional HMAC fast-path lookup (`PIN_HMAC_KEY`), lockout after repeated failures, and 15-minute / 24-hour rate limits. Sessions are server-side rows bound to an httpOnly cookie; each session records last-used IP and user agent and can be revoked individually from `/settings`
- **Web push** (VAPID) for workout reminders, check-in follow-ups and coach anomaly alerts
- **Offline-first PWA** - installable manifest, a service worker that precaches an `/offline` fallback and never caches API responses, and an offline queue that replays workout logs when the connection returns

## How it works

Clients open the app on their phone, see today's workout, and log sets (weight, reps, RIR, pain). Vercel cron jobs drive the analysis:

| Cron | Schedule | Job |
| --- | --- | --- |
| `daily-analysis` | daily 06:00 | recompute per-exercise signals for every client |
| `weekly-report` | Sun 05:00 | build the coach's weekly report and suggestions |
| `weekly-note-prepare` | Sun 06:00 | draft one coaching note per client |
| `weekly-note-send` | Mon 06:00 | send the notes the coach approved |
| `checkin-followup` | Mon 04:00/14:00 | nudge clients who missed check-in |
| `stale-workouts` | every 30 min | close out abandoned workout sessions |

The coach reviews drafted notes and structural suggestions (deload, exercise swap, day restructure) and approves or dismisses each in one tap.

## Signals engine (`src/lib/signals/`)

All detectors are pure, server-and-client safe modules - each is the single computation site for its signal:

- `progression.ts` - time-ordered per-exercise series (e1RM, volume-load, top-set RIR) with an MDC-aware stall detector that tolerates normal session-to-session noise
- `plateau.ts` - week-based, RIR-branched plateau ladder per exercise, including an explicit "load up, reps down" hold state so a deliberate load-progression trade is not flagged as a stall
- `fatigue.ts` - deload gate built from four triggers (RIR drift at matched load, performance drop, and related markers)
- `rir-drift.ts` (in `src/lib/`) feeding `rir-prescription.ts` - dynamic RIR targets that ramp across the training block by goal classification, with a compound floor and deload backoff
- `pain.ts` - graded traffic-light pain classifier (mild / recurring / red-flag) based on the Smith et al. 2017 BJSM pain-monitoring framework, replacing the old "any pain means swap" rule
- `adherence.ts` - completed-days-vs-target ratio over a lookback window; low adherence suppresses plateau and volume suggestions
- `anomaly.ts` - behaviour-change detection (informational, coach-only pushes, never auto-changes a program)
- `client-context.ts` - "is something explaining this client's behaviour right now" gate shared by the anomaly notifier and the weekly note
- `weekly-note.ts` - always-non-null weekly coaching note, tiered by the client's real signals, produced only when no structural suggestion fired
- `weekly-note-send.ts` - pure selection logic for the approval-gated note send

## Running locally

1. Copy `.env.example` to `.env.local` and fill in the values (Supabase URL and service-role key, `SESSION_SECRET`, `PIN_HMAC_KEY`, `CRON_SECRET`, VAPID keys).
2. Apply the migrations in `supabase/migrations/` to your Supabase project (in order).
3. Install and seed:

```bash
npm install
npm run seed   # 1 coach (PIN 12345) + 1 test client (PIN 67890) with a 4-day program
npm run dev    # http://localhost:3000
```

4. Run the test suite:

```bash
npm test
```

## Utility scripts

`scripts/` contains operational tools, all driven by CLI arguments and `.env.local` (no hardcoded data):

- `seed.ts` - dev seed data
- `apply-history.ts` / `inspect-history.ts` - import or inspect a client's historical training spreadsheet
- `set-client-pin.ts` / `set-coach-pin.ts` - rotate PINs
- `list-clients.ts` / `delete-clients.ts` - roster admin
- `mirror-day.ts` / `add-mirror-day.ts` / `backfill-week.ts` / `backfill-is-compound.ts` - program maintenance (dry-run by default, `--apply` to write)
- `dump-*.ts` - read-only diagnostics for the signals engine
- `gen-icons.mjs` - regenerate PWA icons
