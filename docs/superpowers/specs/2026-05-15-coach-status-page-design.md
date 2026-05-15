# Coach Status Page — Design

**Status:** Approved (pending user sign-off)
**Date:** 2026-05-15
**Replaces:** `/coach/weekly`

## Goal

A coach-side Status page that aggregates every active client into a card grid. Each card surfaces whether the client's program needs changes ("Issues") or is fine as-is ("All set") — emphasized on Sundays, the coach's weekly program-review day. Each card has two drilldowns:

1. **Issues** — every active exercise in the client's program, tagged with its status (good / watch / adjust / swap / pain / skipped), with Apply buttons for actionable suggestions.
2. **View** — the full workout history: every calendar week since the program started → workouts in that week → per-set log with weights, reps, RPE, video, PR badges, and prescribed-vs-actual comparison.

Most of the engine (`lib/suggestions.ts`, `/api/coach/suggestions/apply`) already exists. This spec is mostly UI restructuring plus three new server-side data modules.

## Routes & file layout

```
src/app/coach/
  status/
    page.tsx                                          # cards grid (replaces /coach/weekly)
    [clientId]/
      _components/
        client-header.tsx                             # shared name + badge + back link
      issues/
        page.tsx                                      # exercise-by-exercise list
        suggestion-actions.tsx                        # moved from /coach/weekly
        apply-all-button.tsx                          # client component, batch apply confirm sheet
      history/
        page.tsx                                      # weeks list
        [weekStart]/
          page.tsx                                    # workouts in that week
          [workoutId]/
            page.tsx                                  # full set log
```

**Removals:**
- `src/app/coach/weekly/` — entire directory deleted.
- Nav link in `src/app/coach/page.tsx` ("Weekly report") → "Status" pointing at `/coach/status`.

**URL conventions:**
- `weekStart` = `YYYY-MM-DD` of the ISO Monday (matches the existing `week_start` column).
- `workoutId` = the workout UUID.

## Data layer

Three new server-only modules in `src/lib/`. All three follow the existing batched-query pattern from `lib/weekly-report.ts` — no per-client or per-workout loops.

### `lib/status-overview.ts`

Powers the cards grid.

```ts
export type ClientStatusRow = {
  clientId: string;
  name: string;
  daysDone: number;
  daysTarget: number;
  hasActionableIssues: boolean;   // adjust/swap_candidate/pain/skipped_day exists
  issueCount: number;             // count of the above
  lastActivityAt: string | null;
};

export async function buildStatusOverview(at?: Date): Promise<{ rows: ClientStatusRow[] }>;
```

Implementation: one batched query for active clients + `weekly_day_target` + this-week completed workouts, then delegates to `buildSuggestionsByClient` (`lib/suggestions.ts:70`) for the issue count.

### `lib/client-issues.ts`

Powers the Issues drilldown.

```ts
export type ExerciseStatus = 'good' | 'watch' | 'adjust' | 'swap_candidate' | 'pain';

export type ExerciseWithStatus = {
  id: string;
  name: string;
  prescribedSets: number | null;
  prescriptionRaw: string | null;
  isCardio: boolean;
  status: ExerciseStatus;
  suggestion: Suggestion | null;  // from lib/suggestions.ts
};

export type DayWithExercises = {
  id: string;
  dayIndex: number;
  label: string;
  skippedSuggestion: Suggestion | null;   // skipped_day attaches at day level
  exercises: ExerciseWithStatus[];
};

export type ClientIssues = {
  client: { id: string; name: string; weeklyDayTarget: number };
  days: DayWithExercises[];
  applyAllCount: number;          // count of suggestions auto-applyable without user choice (excludes swap_exercise)
};

export async function buildClientIssues(clientId: string, at?: Date): Promise<ClientIssues | null>;
```

Implementation: pulls the active program with all days/exercises (same query shape as the suggestions builder uses internally). Calls `buildSuggestionsByClient([clientId])` and indexes the results by `apply.exerciseIds`. Exercises with no matching suggestion → `status: 'good'`. Day-level `skipped_day` suggestions attach to the day, not an exercise.

### `lib/client-history.ts`

Powers the history tree.

```ts
export type WeekRow = {
  weekStart: string;              // YYYY-MM-DD
  daysDone: number;
  daysTarget: number;
  totalSets: number;
  prCount: number;
  painCount: number;
  hasWorkouts: boolean;
};

export type WorkoutRow = {
  id: string;
  dayLabel: string;
  startedAt: string;
  completedAt: string | null;
  isMissed: boolean;
  setCount: number;
  prCount: number;
  painCount: number;
};

export type SetDetail = {
  setIndex: number;
  weight: number | null;
  reps: number | null;
  rpe: number | null;
  videoUrl: string | null;
  isPR: boolean;
};

export type ExerciseLogDetail = {
  exerciseId: string;
  name: string;
  prescribedSets: number | null;
  prescriptionRaw: string | null;
  painReason: string | null;
  clientNote: string | null;
  sets: SetDetail[];
};

export type WorkoutDetail = {
  workout: { id: string; clientId: string; dayLabel: string; startedAt: string; completedAt: string | null; weekStart: string };
  exercises: ExerciseLogDetail[];
};

export async function listClientWeeks(clientId: string): Promise<WeekRow[] | null>;
export async function getWeekWorkouts(clientId: string, weekStart: string): Promise<WorkoutRow[] | null>;
export async function getWorkoutDetail(workoutId: string): Promise<WorkoutDetail | null>;
```

Implementation notes:
- `listClientWeeks`: range = from `programs.training_start_at ?? programs.uploaded_at` (ISO Monday) through current ISO Monday, inclusive. Empty weeks included with `daysDone=0, hasWorkouts=false`. PR/pain/set counts come from one batched query joined back to the week buckets.
- `getWorkoutDetail`: PR badge comes from joining `best_efforts.source_set_id` against each set's id (existing column, see `lib/weekly-report.ts:88`).
- Each function returns `null` if the client/week/workout doesn't exist (caller renders `notFound()`).

## UI

### `/coach/status` (cards grid)

Replaces the existing `/coach/weekly` flat list. Layout: page header ("Status — Week of MMM d"), then a responsive grid of cards (1 col mobile, 2 on tablet, 3 on desktop).

Each card:

```
ClientG                                    [Issues (3)]   ←  Sunday: pulse + danger emphasis
3/4 days · last 2h ago                  [All set]      ←  if no actionable issues
                                                        [View]   [Apply / Open]
```

Inactive clients are excluded (matches `weekly-report.ts:48-53`).

**Badge logic** (computed server-side):
- `hasActionableIssues = issueCount > 0` where `issueCount` counts suggestions with `type ∈ {adjust, swap_candidate, pain, skipped_day}`.
- Watch + adherence are informational and don't trigger Issues.
- Sunday detection: `new Date().getDay() === 0` on the server. On Sunday, the Issues badge gets a `bg-danger/10 animate-pulse` treatment; All set badge gets `bg-primary/15`. Other days both badges render muted.

### `/coach/status/[clientId]/issues`

Layout: `<ClientHeader>` (name + week target + days done + status badge + back to `/coach/status`) → `[Apply all (N)]` button → days as section headers → exercise rows.

```
Day 1 — Push
─────────────────────────────────────────────────────────
Bench Press           3 sets        [Good]
DB Row                3 sets        [Watch — 2 stalled]
Squat                 4 sets        [Adjust — +1 set]    [Apply]
Hip Thrust            3 sets        [Swap candidate]     [Pick swap ▾]
Lunges                2 sets        [Pain]               [Pick swap ▾]
```

Each row:
- Name + prescribed sets.
- A status chip (color-coded by status, matching the existing `TYPE_CHIPS` palette from the weekly report).
- For actionable statuses: an inline Apply button (reusing the moved `SuggestionRow` component logic — pressing Apply hits `/api/coach/suggestions/apply` exactly as it does today).
- For Watch / Good: no action button.

**Skipped day banner**: if a day has a `skipped_day` suggestion attached, render a banner above the day's exercises with its Apply button (`archive_day`).

**"Apply all" batch button**:
- Counts only suggestions whose `apply.kind ∈ {'add_set', 'archive_day'}` (swap suggestions need a user choice — they're surfaced as "N swaps need manual choice" beneath the button if any exist).
- Clicking opens a confirm sheet listing every change ("+1 set to Squat, Archive Day 4, ...") with [Cancel] / [Apply all].
- Confirm → POSTs each suggestion sequentially through `/api/coach/suggestions/apply`. Aborts on first error and shows which succeeded / which failed.
- Lives in `apply-all-button.tsx` (client component).

### `/coach/status/[clientId]/history` (weeks list)

Vertical list, newest first. Each row:

```
Week of Apr 28           3/4 days · 24 sets · 1 PR
Week of Apr 21           4/4 days · 31 sets · 2 PRs
Week of Apr 14           0/4 days · no logs                 ←  empty week, muted
```

Empty weeks render with muted styling and "no logs" copy. Clicking any row → `/history/[weekStart]`.

### `/coach/status/[clientId]/history/[weekStart]` (week detail)

Workouts list for that week, sorted by `started_at`. Each row:

```
Push (Day 1)             Mon 10:14am · 8 sets · 1 PR
Pull (Day 2)             Wed 11:02am · 7 sets
Legs (Day 3)             ─                              ←  is_missed=true, muted "Missed"
```

Clicking a non-missed row → `/history/[weekStart]/[workoutId]`. Missed rows are non-interactive.

### `/coach/status/[clientId]/history/[weekStart]/[workoutId]` (workout detail)

Full per-set log. For each exercise in the workout:

```
Bench Press
3 sets · 8-10 RIR 2                                           ←  prescription_raw

  Set  Weight   Reps   RPE   Video    PR
  1    100 kg    8      8    —        —
  2    105 kg    8      9    [▶]      ✓
  3    105 kg    7     10    —        —

Pain note: "Right shoulder twinge on set 3"                   ←  if pain_reason
Note: "felt strong"                                           ←  if client_note
```

- `prescribedSets` and `prescriptionRaw` shown as subtitle.
- PR column: ✓ when `best_efforts.source_set_id === set.id`.
- Video column: small play-icon link if `video_url` present; em-dash otherwise.

## Error handling

- `requireCoach()` on every page (existing pattern).
- `force-dynamic` on every page (existing pattern).
- `notFound()` for:
  - Unknown `clientId`.
  - `weekStart` not in `YYYY-MM-DD` format or not a Monday or not in `[programTrainingStart, currentMonday]` range.
  - `workoutId` not belonging to that `clientId` or not falling in that `weekStart`.
- Issues page when the client has no active program: render a friendly empty state ("No active program yet — upload one first") rather than `notFound()`. Matches the pattern in `src/app/coach/clients/[id]/log/page.tsx`.
- History page when the client has no program: empty weeks list with "No program uploaded yet."
- Batch Apply failures: stop on first error, surface which succeeded.

## Testing

Match the existing test pattern: bare `tsx` files in `tests/` using a `check()` helper (see `tests/lib.test.ts`). No framework. New test file: `tests/status.test.ts`.

Coverage:

**`buildStatusOverview`:**
- Client with 0 suggestions → `hasActionableIssues=false, issueCount=0`.
- Client with `watch + adjust + pain` suggestions → `hasActionableIssues=true, issueCount=2` (watch excluded).
- Inactive client → not in the result rows.

**`buildClientIssues`:**
- Every active exercise on the program appears exactly once.
- Exercise with an `adjust` suggestion → `status='adjust'`, `suggestion` populated.
- Exercise with no suggestion → `status='good'`, `suggestion=null`.
- `skipped_day` suggestion attaches to the day, not any exercise.

**`listClientWeeks`:**
- Range starts at program `training_start_at` Monday and ends at current Monday.
- A calendar week with no workouts appears with `hasWorkouts=false, daysDone=0`.

**`getWorkoutDetail`:**
- Set with a matching `best_efforts.source_set_id` → `isPR=true`.
- Missing workout → `null`.

Existing `/api/coach/suggestions/apply` is unchanged, so its test coverage carries.

## Out of scope

- Email / push of the status page.
- Comparison views (week-vs-week, client-vs-client).
- Editing workouts from the history detail (read-only).
- New apply kinds (swap-exercise still requires manual replacement choice — same as today).
