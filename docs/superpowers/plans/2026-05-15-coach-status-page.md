# Coach Status Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/coach/weekly` with a `/coach/status` route tree: cards grid for all active clients with "All set" / "Issues" badges, plus two per-client drilldowns — Issues (exercise-by-exercise program review with Apply buttons) and View (full workout history with per-set logs and PR badges).

**Architecture:** Three new server-only lib modules (`status-overview`, `client-issues`, `client-history`) reuse the existing `buildSuggestionsByClient` engine and the `/api/coach/suggestions/apply` endpoint. UI is Next.js server components under `src/app/coach/status/`. Each lib module exports one pure helper (unit-tested) plus orchestrator functions that batch Supabase queries — matching the existing `lib/weekly-report.ts` pattern. No DB schema changes.

**Tech Stack:** Next.js 16 App Router (server components, force-dynamic), TypeScript, Tailwind v4, `date-fns`, Supabase (`@supabase/supabase-js`), tsx test runner.

**Spec:** `docs/superpowers/specs/2026-05-15-coach-status-page-design.md`

---

## File map

**Create:**
- `src/lib/status-overview.ts`
- `src/lib/client-issues.ts`
- `src/lib/client-history.ts`
- `src/app/coach/status/page.tsx`
- `src/app/coach/status/[clientId]/_components/client-header.tsx`
- `src/app/coach/status/[clientId]/issues/page.tsx`
- `src/app/coach/status/[clientId]/issues/suggestion-actions.tsx` (moved verbatim from `weekly/`)
- `src/app/coach/status/[clientId]/issues/apply-all-button.tsx`
- `src/app/coach/status/[clientId]/history/page.tsx`
- `src/app/coach/status/[clientId]/history/[weekStart]/page.tsx`
- `src/app/coach/status/[clientId]/history/[weekStart]/[workoutId]/page.tsx`
- `tests/status.test.ts`

**Modify:**
- `src/app/coach/page.tsx` (nav link "Weekly report" → "Status")
- `package.json` (extend `test` script to run the new test file)

**Delete:**
- `src/app/coach/weekly/page.tsx`
- `src/app/coach/weekly/suggestion-actions.tsx`
- (whole `src/app/coach/weekly/` directory)

---

## Task 1: Status overview data layer

**Files:**
- Create: `src/lib/status-overview.ts`
- Create: `tests/status.test.ts`
- Modify: `package.json:7`

- [ ] **Step 1.1: Write failing test for `classifyClientStatus`**

Create `tests/status.test.ts`:

```ts
/**
 * Pure-function tests for status-overview / client-issues / client-history
 * helpers. Same shape as tests/lib.test.ts — runs with tsx, bails on first
 * assertion failure.
 *
 *   npx tsx tests/status.test.ts
 */
import { classifyClientStatus } from '../src/lib/status-overview';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
}

function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------- classifyClientStatus ----------

eq(
  'classify: no suggestions → all set',
  classifyClientStatus([]),
  { hasActionableIssues: false, issueCount: 0 },
);

eq(
  'classify: watch + adherence only → all set (informational)',
  classifyClientStatus(['watch', 'adherence']),
  { hasActionableIssues: false, issueCount: 0 },
);

eq(
  'classify: single adjust → issues count 1',
  classifyClientStatus(['adjust']),
  { hasActionableIssues: true, issueCount: 1 },
);

eq(
  'classify: mix of watch + adjust + pain → issues count 2',
  classifyClientStatus(['watch', 'adjust', 'pain']),
  { hasActionableIssues: true, issueCount: 2 },
);

eq(
  'classify: swap_candidate + skipped_day → issues count 2',
  classifyClientStatus(['swap_candidate', 'skipped_day']),
  { hasActionableIssues: true, issueCount: 2 },
);

// ---------- summary ----------

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`OK  ${passed} passed`);
```

- [ ] **Step 1.2: Run test and confirm it fails**

```bash
npx tsx tests/status.test.ts
```

Expected: Module-not-found error or `classifyClientStatus is not a function` — file doesn't exist yet.

- [ ] **Step 1.3: Implement `lib/status-overview.ts`**

Create `src/lib/status-overview.ts`:

```ts
import 'server-only';

import { startOfWeek, formatISO } from 'date-fns';

import { db } from './supabase';
import { buildSuggestionsByClient } from './suggestions';
import type { Suggestion } from './suggestions';

export type ClientStatusRow = {
  clientId: string;
  name: string;
  weeklyDayTarget: number;
  daysDone: number;
  hasActionableIssues: boolean;
  issueCount: number;
  lastActivityAt: string | null;
};

export type StatusOverview = {
  weekStart: string;
  rows: ClientStatusRow[];
};

/**
 * "Actionable" suggestion types — the ones that imply a program change.
 * Watch and adherence are informational and do NOT trigger the Issues badge.
 */
const ACTIONABLE_TYPES: ReadonlySet<Suggestion['type']> = new Set([
  'adjust',
  'swap_candidate',
  'pain',
  'skipped_day',
]);

/**
 * Pure: given the list of suggestion types attached to a client, return
 * whether the Issues badge should fire and how many actionable items.
 * Exported for unit tests.
 */
export function classifyClientStatus(types: string[]): {
  hasActionableIssues: boolean;
  issueCount: number;
} {
  let issueCount = 0;
  for (const t of types) {
    if (ACTIONABLE_TYPES.has(t as Suggestion['type'])) issueCount++;
  }
  return { hasActionableIssues: issueCount > 0, issueCount };
}

/**
 * Builds the cards-grid overview for /coach/status. One row per active
 * client. Follows the batched-query pattern from lib/weekly-report.ts —
 * never per-client loops.
 */
export async function buildStatusOverview(at: Date = new Date()): Promise<StatusOverview> {
  const supa = db();
  const weekStart = startOfWeek(at, { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });

  const { data: clients } = await supa
    .from('clients')
    .select('id, name, weekly_day_target')
    .eq('active', true)
    .order('name');

  if (!clients || clients.length === 0) {
    return { weekStart: weekStartIso, rows: [] };
  }

  const ids = clients.map((c) => c.id);

  const [{ data: weekWorkouts }, { data: lastActivity }, suggestionsByClient] = await Promise.all([
    supa
      .from('workouts')
      .select('client_id, completed_at')
      .in('client_id', ids)
      .eq('week_start', weekStartIso)
      .not('completed_at', 'is', null),
    supa
      .from('workouts')
      .select('client_id, started_at')
      .in('client_id', ids)
      .order('started_at', { ascending: false }),
    buildSuggestionsByClient(ids, at),
  ]);

  const daysDoneByClient = new Map<string, number>();
  for (const w of weekWorkouts ?? []) {
    daysDoneByClient.set(w.client_id, (daysDoneByClient.get(w.client_id) ?? 0) + 1);
  }

  const lastActivityByClient = new Map<string, string>();
  for (const w of lastActivity ?? []) {
    if (lastActivityByClient.has(w.client_id)) continue;
    lastActivityByClient.set(w.client_id, w.started_at);
  }

  const rows: ClientStatusRow[] = clients.map((c) => {
    const suggestions = suggestionsByClient.get(c.id) ?? [];
    const { hasActionableIssues, issueCount } = classifyClientStatus(
      suggestions.map((s) => s.type),
    );
    return {
      clientId: c.id,
      name: c.name,
      weeklyDayTarget: c.weekly_day_target,
      daysDone: daysDoneByClient.get(c.id) ?? 0,
      hasActionableIssues,
      issueCount,
      lastActivityAt: lastActivityByClient.get(c.id) ?? null,
    };
  });

  return { weekStart: weekStartIso, rows };
}
```

- [ ] **Step 1.4: Update `package.json` test script to run both test files**

In `package.json:7`, change the `test` script:

```json
"test": "tsx tests/lib.test.ts && tsx tests/status.test.ts"
```

- [ ] **Step 1.5: Run tests and confirm both pass**

```bash
npm test
```

Expected: `OK  N passed` from both files. No failures.

- [ ] **Step 1.6: Commit**

```bash
git add src/lib/status-overview.ts tests/status.test.ts package.json
git commit -m "lib/status-overview: build cards-grid overview for /coach/status"
```

---

## Task 2: Status cards grid page

**Files:**
- Create: `src/app/coach/status/page.tsx`
- Modify: `src/app/coach/page.tsx:80-83` (nav link)

- [ ] **Step 2.1: Implement `src/app/coach/status/page.tsx`**

```tsx
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { buildStatusOverview } from '@/lib/status-overview';
import { PageHeader } from '../ui';

export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  await requireCoach();
  const overview = await buildStatusOverview();
  const isSunday = new Date().getDay() === 0;

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <PageHeader
        eyebrow={isSunday ? 'Sunday — program review' : 'The week so far'}
        title="Status"
        meta={<span>Week of {format(new Date(overview.weekStart), 'MMM d, yyyy')}</span>}
      />

      {overview.rows.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No active clients yet.
        </p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {overview.rows.map((r) => (
            <li
              key={r.clientId}
              className="rounded-2xl border border-border bg-surface/60 px-4 py-4 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-text truncate">{r.name}</p>
                  <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                    {r.daysDone}/{r.weeklyDayTarget} days
                    {r.lastActivityAt && (
                      <span className="ml-2 text-faint/80">
                        · last{' '}
                        {formatDistanceToNow(new Date(r.lastActivityAt), { addSuffix: true })}
                      </span>
                    )}
                  </p>
                </div>
                <StatusBadge
                  hasIssues={r.hasActionableIssues}
                  count={r.issueCount}
                  emphasized={isSunday}
                />
              </div>

              <div className="flex items-center gap-2">
                <Link
                  href={`/coach/status/${r.clientId}/history`}
                  prefetch={false}
                  className="flex-1 rounded-lg border border-border bg-surface/40 text-text text-xs font-medium text-center py-2 hover:bg-surface hover:border-border-strong transition-colors"
                >
                  View
                </Link>
                <Link
                  href={`/coach/status/${r.clientId}/issues`}
                  prefetch={false}
                  className={`flex-1 rounded-lg text-xs font-semibold text-center py-2 transition-colors ${
                    r.hasActionableIssues
                      ? 'bg-primary hover:bg-primary-hi text-bg'
                      : 'border border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong'
                  }`}
                >
                  {r.hasActionableIssues ? 'Open' : 'Review'}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function StatusBadge({
  hasIssues,
  count,
  emphasized,
}: {
  hasIssues: boolean;
  count: number;
  emphasized: boolean;
}) {
  if (hasIssues) {
    return (
      <span
        className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-1 rounded-sm border ${
          emphasized
            ? 'border-danger/60 bg-danger/15 text-danger animate-pulse'
            : 'border-danger/30 bg-danger/8 text-danger'
        }`}
      >
        Issues ({count})
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-1 rounded-sm border ${
        emphasized
          ? 'border-primary/50 bg-primary/15 text-primary-hi'
          : 'border-border bg-surface-2 text-muted'
      }`}
    >
      All set
    </span>
  );
}
```

- [ ] **Step 2.2: Update the nav link in `src/app/coach/page.tsx`**

Find `src/app/coach/page.tsx:76-83` (the `<Link href="/coach/weekly">` block) and change:

```tsx
            <Link
              href="/coach/weekly"
              prefetch={false}
              className="group relative pb-0.5 text-muted hover:text-text transition-colors"
            >
              Weekly report
              <span aria-hidden className="absolute left-0 right-0 -bottom-px h-px bg-text/0 group-hover:bg-text/40 transition-colors" />
            </Link>
```

to:

```tsx
            <Link
              href="/coach/status"
              prefetch={false}
              className="group relative pb-0.5 text-muted hover:text-text transition-colors"
            >
              Status
              <span aria-hidden className="absolute left-0 right-0 -bottom-px h-px bg-text/0 group-hover:bg-text/40 transition-colors" />
            </Link>
```

- [ ] **Step 2.3: Verify build + browse**

```bash
npm run build
```

Expected: build succeeds, no type errors.

Run dev server and visit `http://localhost:3000/coach/status`. Expected: cards grid renders with one card per active client. On Sunday (or after temporarily forcing `isSunday=true` for testing), the Issues badge pulses.

- [ ] **Step 2.4: Commit**

```bash
git add src/app/coach/status/page.tsx src/app/coach/page.tsx
git commit -m "coach/status: cards grid replacing weekly-report flat list"
```

---

## Task 3: Shared client header for drilldowns

**Files:**
- Create: `src/app/coach/status/[clientId]/_components/client-header.tsx`

- [ ] **Step 3.1: Implement `client-header.tsx`**

```tsx
import Link from 'next/link';

export function ClientHeader({
  clientId,
  name,
  weeklyDayTarget,
  daysDone,
  hasIssues,
  issueCount,
  subnav,
}: {
  clientId: string;
  name: string;
  weeklyDayTarget: number;
  daysDone: number;
  hasIssues: boolean;
  issueCount: number;
  subnav: 'issues' | 'history';
}) {
  const isSunday = new Date().getDay() === 0;
  return (
    <header className="mb-6 sm:mb-8">
      <Link
        href="/coach/status"
        prefetch={false}
        className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
      >
        ← All clients
      </Link>
      <div className="mt-4 flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl sm:text-5xl leading-[0.9] tracking-tight">
            {name}
          </h1>
          <p className="mt-2 text-xs text-faint tabular-nums">
            {daysDone}/{weeklyDayTarget} days this week
          </p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2.5 py-1 rounded-sm border ${
            hasIssues
              ? isSunday
                ? 'border-danger/60 bg-danger/15 text-danger animate-pulse'
                : 'border-danger/30 bg-danger/8 text-danger'
              : isSunday
                ? 'border-primary/50 bg-primary/15 text-primary-hi'
                : 'border-border bg-surface-2 text-muted'
          }`}
        >
          {hasIssues ? `Issues (${issueCount})` : 'All set'}
        </span>
      </div>
      <nav className="mt-5 flex gap-2 text-[10px] uppercase tracking-[0.18em]">
        <Link
          href={`/coach/status/${clientId}/issues`}
          prefetch={false}
          className={`px-3 py-1.5 rounded-sm border font-medium transition-colors ${
            subnav === 'issues'
              ? 'border-primary/60 bg-primary/10 text-primary-hi'
              : 'border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong'
          }`}
        >
          Issues
        </Link>
        <Link
          href={`/coach/status/${clientId}/history`}
          prefetch={false}
          className={`px-3 py-1.5 rounded-sm border font-medium transition-colors ${
            subnav === 'history'
              ? 'border-primary/60 bg-primary/10 text-primary-hi'
              : 'border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong'
          }`}
        >
          History
        </Link>
      </nav>
    </header>
  );
}
```

- [ ] **Step 3.2: Commit**

```bash
git add src/app/coach/status/[clientId]/_components/client-header.tsx
git commit -m "coach/status: shared ClientHeader component for drilldowns"
```

---

## Task 4: Client issues data layer

**Files:**
- Create: `src/lib/client-issues.ts`
- Modify: `tests/status.test.ts`

- [ ] **Step 4.1: Write failing tests for `attachStatusToProgram`**

Append to `tests/status.test.ts` (after the `classifyClientStatus` tests, before the summary):

```ts
// ---------- attachStatusToProgram ----------

import { attachStatusToProgram } from '../src/lib/client-issues';
import type { Suggestion } from '../src/lib/suggestions';

type Prog = Parameters<typeof attachStatusToProgram>[0];

const baseProgram: Prog = {
  id: 'p1',
  days: [
    {
      id: 'd1',
      day_index: 1,
      label: 'Push',
      exercises: [
        { id: 'e1', name: 'Bench Press', name_key: 'bench_press', prescribed_sets: 3, prescription_raw: '3x8-10', is_cardio: false, archived_at: null, position: 1 },
        { id: 'e2', name: 'DB Row', name_key: 'db_row', prescribed_sets: 3, prescription_raw: '3x10', is_cardio: false, archived_at: null, position: 2 },
        { id: 'e3', name: 'Archived', name_key: 'archived', prescribed_sets: 3, prescription_raw: '3x10', is_cardio: false, archived_at: '2026-01-01', position: 3 },
      ],
    },
  ],
};

const adjustSug: Suggestion = {
  id: 'adjust:c:bench_press',
  type: 'adjust',
  title: 'Bench Press — adjust',
  body: 'stalled',
  apply: { kind: 'add_set', exerciseIds: ['e1'], targetName: 'Bench Press' },
};

const skippedSug: Suggestion = {
  id: 'skipped:c:d1',
  type: 'skipped_day',
  title: 'Push — skipped',
  body: 'no logs',
  apply: { kind: 'archive_day', dayId: 'd1', dayLabel: 'Push' },
};

const result1 = attachStatusToProgram(baseProgram, [adjustSug]);

eq(
  'issues: archived exercises excluded',
  result1[0].exercises.map((e) => e.id).sort(),
  ['e1', 'e2'],
);

eq(
  'issues: exercise with matching suggestion → status adjust',
  result1[0].exercises.find((e) => e.id === 'e1')!.status,
  'adjust',
);

eq(
  'issues: exercise with no suggestion → status good',
  result1[0].exercises.find((e) => e.id === 'e2')!.status,
  'good',
);

const result2 = attachStatusToProgram(baseProgram, [skippedSug]);

eq(
  'issues: skipped_day attaches at day level, exercises stay good',
  {
    daySkipped: result2[0].skippedSuggestion?.type,
    e1Status: result2[0].exercises.find((e) => e.id === 'e1')!.status,
  },
  { daySkipped: 'skipped_day', e1Status: 'good' },
);
```

- [ ] **Step 4.2: Run test, confirm failure**

```bash
npx tsx tests/status.test.ts
```

Expected: module-not-found for `client-issues`.

- [ ] **Step 4.3: Implement `src/lib/client-issues.ts`**

```ts
import 'server-only';

import { db } from './supabase';
import { buildSuggestionsByClient, type Suggestion } from './suggestions';

export type ExerciseStatus =
  | 'good'
  | 'watch'
  | 'adjust'
  | 'swap_candidate'
  | 'pain';

export type ExerciseWithStatus = {
  id: string;
  name: string;
  prescribedSets: number | null;
  prescriptionRaw: string | null;
  isCardio: boolean;
  status: ExerciseStatus;
  suggestion: Suggestion | null;
};

export type DayWithExercises = {
  id: string;
  dayIndex: number;
  label: string;
  skippedSuggestion: Suggestion | null;
  exercises: ExerciseWithStatus[];
};

export type ClientIssues = {
  client: { id: string; name: string; weeklyDayTarget: number };
  daysDoneThisWeek: number;
  days: DayWithExercises[];
  allSuggestions: Suggestion[];
  hasActionableIssues: boolean;
  issueCount: number;
  applyAllCount: number;
};

type ProgramInput = {
  id: string;
  days: Array<{
    id: string;
    day_index: number;
    label: string;
    exercises: Array<{
      id: string;
      name: string;
      name_key: string;
      prescribed_sets: number | null;
      prescription_raw: string | null;
      is_cardio: boolean;
      archived_at: string | null;
      position: number;
    }>;
  }>;
};

const TYPE_TO_STATUS: Record<Suggestion['type'], ExerciseStatus | null> = {
  watch: 'watch',
  adjust: 'adjust',
  swap_candidate: 'swap_candidate',
  pain: 'pain',
  adherence: null,
  skipped_day: null,
};

/**
 * Pure: map every active exercise in a program to its current status + the
 * suggestion (if any) that drives it. skipped_day suggestions attach at
 * day level, not to any exercise. Exported for unit tests.
 */
export function attachStatusToProgram(
  program: ProgramInput,
  suggestions: Suggestion[],
): DayWithExercises[] {
  // Index suggestions by exerciseId (from apply.exerciseIds) and by dayId
  // (for skipped_day).
  const suggestionByExerciseId = new Map<string, Suggestion>();
  const skippedByDayId = new Map<string, Suggestion>();
  for (const s of suggestions) {
    if (s.type === 'skipped_day' && s.apply?.kind === 'archive_day') {
      skippedByDayId.set(s.apply.dayId, s);
      continue;
    }
    if (s.apply && (s.apply.kind === 'add_set' || s.apply.kind === 'swap_exercise')) {
      for (const eid of s.apply.exerciseIds) {
        suggestionByExerciseId.set(eid, s);
      }
    } else if (s.type === 'watch') {
      // Watch suggestions have no apply, but their id encodes the name_key —
      // we infer the exerciseIds via the program below in a second pass.
      // Skipped here; handled in the day loop using name match.
    }
  }

  return program.days
    .slice()
    .sort((a, b) => a.day_index - b.day_index)
    .map((d) => {
      const activeExercises = d.exercises
        .filter((e) => e.archived_at == null)
        .sort((a, b) => a.position - b.position)
        .map((e): ExerciseWithStatus => {
          const sug = suggestionByExerciseId.get(e.id) ?? findWatchByName(suggestions, e.name);
          const status = sug ? TYPE_TO_STATUS[sug.type] ?? 'good' : 'good';
          return {
            id: e.id,
            name: e.name,
            prescribedSets: e.prescribed_sets,
            prescriptionRaw: e.prescription_raw,
            isCardio: e.is_cardio,
            status,
            suggestion: sug ?? null,
          };
        });

      return {
        id: d.id,
        dayIndex: d.day_index,
        label: d.label,
        skippedSuggestion: skippedByDayId.get(d.id) ?? null,
        exercises: activeExercises,
      };
    });
}

function findWatchByName(suggestions: Suggestion[], name: string): Suggestion | null {
  const target = name.trim().toLowerCase();
  for (const s of suggestions) {
    if (s.type !== 'watch') continue;
    // watch id format: `watch:${cid}:${nameKey}` where nameKey is the
    // lowercased display name (see lib/suggestions.ts).
    const parts = s.id.split(':');
    const nameKey = parts.slice(2).join(':');
    if (nameKey === target) return s;
  }
  return null;
}

/**
 * Orchestrator: pulls the client + active program + suggestions and returns
 * the full Issues view. Returns null when the client doesn't exist.
 */
export async function buildClientIssues(
  clientId: string,
  at: Date = new Date(),
): Promise<ClientIssues | null> {
  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, name, weekly_day_target')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return null;

  const [
    { data: programs },
    { data: weekWorkouts },
    suggestionsByClient,
  ] = await Promise.all([
    supa
      .from('programs')
      .select(
        'id, days(id, day_index, label, exercises(id, name, name_key, prescribed_sets, prescription_raw, is_cardio, archived_at, position))',
      )
      .eq('client_id', clientId)
      .eq('active', true)
      .maybeSingle(),
    supa
      .from('workouts')
      .select('id')
      .eq('client_id', clientId)
      .eq('week_start', isoMonday(at))
      .not('completed_at', 'is', null),
    buildSuggestionsByClient([clientId], at),
  ]);

  const suggestions = suggestionsByClient.get(clientId) ?? [];
  const days = programs
    ? attachStatusToProgram(programs as unknown as ProgramInput, suggestions)
    : [];

  const issueCount = suggestions.filter(
    (s) =>
      s.type === 'adjust' ||
      s.type === 'swap_candidate' ||
      s.type === 'pain' ||
      s.type === 'skipped_day',
  ).length;

  const applyAllCount = suggestions.filter(
    (s) => s.apply?.kind === 'add_set' || s.apply?.kind === 'archive_day',
  ).length;

  return {
    client: {
      id: client.id,
      name: client.name,
      weeklyDayTarget: client.weekly_day_target,
    },
    daysDoneThisWeek: weekWorkouts?.length ?? 0,
    days,
    allSuggestions: suggestions,
    hasActionableIssues: issueCount > 0,
    issueCount,
    applyAllCount,
  };
}

function isoMonday(at: Date): string {
  const d = new Date(at);
  const day = d.getDay();
  const diff = (day + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4.4: Run tests, confirm pass**

```bash
npm test
```

Expected: all previously-passing tests + 4 new ones pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/lib/client-issues.ts tests/status.test.ts
git commit -m "lib/client-issues: per-exercise status + suggestion attach"
```

---

## Task 5: Issues page

**Files:**
- Create: `src/app/coach/status/[clientId]/issues/suggestion-actions.tsx`
- Create: `src/app/coach/status/[clientId]/issues/apply-all-button.tsx`
- Create: `src/app/coach/status/[clientId]/issues/page.tsx`

- [ ] **Step 5.1: Copy `suggestion-actions.tsx` from `weekly/`**

Copy `src/app/coach/weekly/suggestion-actions.tsx` to `src/app/coach/status/[clientId]/issues/suggestion-actions.tsx` verbatim. (We'll delete the original in Task 9 after the cutover.)

```bash
cp src/app/coach/weekly/suggestion-actions.tsx src/app/coach/status/[clientId]/issues/suggestion-actions.tsx
```

(Windows PowerShell: `Copy-Item src/app/coach/weekly/suggestion-actions.tsx src/app/coach/status/[clientId]/issues/suggestion-actions.tsx`.)

- [ ] **Step 5.2: Implement `apply-all-button.tsx`**

Create `src/app/coach/status/[clientId]/issues/apply-all-button.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { Suggestion } from '@/lib/suggestions';

type AutoApplyable = Suggestion & {
  apply: NonNullable<Extract<Suggestion['apply'], { kind: 'add_set' | 'archive_day' }>>;
};

export function ApplyAllButton({
  clientId,
  suggestions,
  swapsNeedingChoice,
}: {
  clientId: string;
  suggestions: Suggestion[];
  swapsNeedingChoice: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const auto = suggestions.filter(
    (s): s is AutoApplyable =>
      s.apply?.kind === 'add_set' || s.apply?.kind === 'archive_day',
  );

  if (auto.length === 0 && swapsNeedingChoice === 0) return null;

  async function applyAll() {
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: auto.length });
    for (let i = 0; i < auto.length; i++) {
      const s = auto[i];
      let payload: Record<string, unknown>;
      if (s.apply.kind === 'add_set') {
        payload = { kind: 'add_set', clientId, exerciseIds: s.apply.exerciseIds };
      } else {
        payload = { kind: 'archive_day', clientId, dayId: s.apply.dayId };
      }
      const res = await fetch('/api/coach/suggestions/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(`Stopped after ${i} of ${auto.length}: ${e.error ?? 'failed'}`);
        setBusy(false);
        return;
      }
      setProgress({ done: i + 1, total: auto.length });
    }
    setBusy(false);
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={auto.length === 0}
        className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-40 transition-colors"
      >
        Apply all ({auto.length})
      </button>
      {swapsNeedingChoice > 0 && (
        <p className="mt-2 text-[11px] text-faint">
          {swapsNeedingChoice} swap{swapsNeedingChoice === 1 ? '' : 's'} need manual choice — apply below.
        </p>
      )}
      {open && auto.length > 0 && (
        <div className="mt-3 rounded-2xl border border-border bg-surface/60 p-4 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint">
            Confirm — will apply each in order
          </p>
          <ul className="space-y-1 text-xs text-text">
            {auto.map((s) => (
              <li key={s.id}>
                ·{' '}
                {s.apply.kind === 'add_set'
                  ? `+1 set to ${s.apply.targetName}`
                  : `Archive ${s.apply.dayLabel}`}
              </li>
            ))}
          </ul>
          {progress && (
            <p className="text-[11px] text-muted tabular-nums">
              {progress.done} / {progress.total} applied
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={applyAll}
              disabled={busy || pending}
              className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hi text-bg text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              {busy ? 'Applying…' : 'Apply all'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 rounded-lg border border-border bg-surface/40 text-text hover:bg-surface hover:border-border-strong text-xs font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5.3: Implement `src/app/coach/status/[clientId]/issues/page.tsx`**

```tsx
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { buildClientIssues, type ExerciseStatus } from '@/lib/client-issues';
import { ClientHeader } from '../_components/client-header';
import { SuggestionRow } from './suggestion-actions';
import { ApplyAllButton } from './apply-all-button';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string }>;

export default async function IssuesPage(props: { params: Params }) {
  await requireCoach();
  const { clientId } = await props.params;
  const data = await buildClientIssues(clientId);
  if (!data) notFound();

  const swapsNeedingChoice = data.allSuggestions.filter(
    (s) => s.apply?.kind === 'swap_exercise',
  ).length;

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <ClientHeader
        clientId={data.client.id}
        name={data.client.name}
        weeklyDayTarget={data.client.weeklyDayTarget}
        daysDone={data.daysDoneThisWeek}
        hasIssues={data.hasActionableIssues}
        issueCount={data.issueCount}
        subnav="issues"
      />

      {data.days.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No active program yet — upload one first.
        </p>
      ) : (
        <>
          <ApplyAllButton
            clientId={data.client.id}
            suggestions={data.allSuggestions}
            swapsNeedingChoice={swapsNeedingChoice}
          />

          <div className="space-y-6">
            {data.days.map((d) => (
              <section key={d.id}>
                <h2 className="text-[10px] uppercase tracking-[0.24em] text-faint mb-2">
                  Day {d.dayIndex} — {d.label}
                </h2>
                {d.skippedSuggestion && (
                  <div className="mb-3">
                    <SuggestionRow
                      clientId={data.client.id}
                      suggestion={d.skippedSuggestion}
                    />
                  </div>
                )}
                <ul className="rounded-2xl border border-border bg-surface/40 divide-y divide-border">
                  {d.exercises.map((e) => (
                    <li key={e.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-text truncate">{e.name}</p>
                          <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                            {e.prescribedSets ?? '—'} set
                            {e.prescribedSets === 1 ? '' : 's'}
                            {e.prescriptionRaw && (
                              <span className="text-faint/80"> · {e.prescriptionRaw}</span>
                            )}
                          </p>
                        </div>
                        <StatusChip status={e.status} />
                      </div>
                      {e.suggestion && e.suggestion.apply && (
                        <div className="mt-3">
                          <SuggestionRow
                            clientId={data.client.id}
                            suggestion={e.suggestion}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function StatusChip({ status }: { status: ExerciseStatus }) {
  const map: Record<ExerciseStatus, { label: string; className: string }> = {
    good: {
      label: 'Good',
      className: 'border-border bg-surface-2 text-muted',
    },
    watch: {
      label: 'Watch',
      className: 'border-warn/35 bg-warn/10 text-warn',
    },
    adjust: {
      label: 'Adjust',
      className: 'border-warn/40 bg-warn/15 text-warn',
    },
    swap_candidate: {
      label: 'Swap',
      className: 'border-danger/35 bg-danger/10 text-danger',
    },
    pain: {
      label: 'Pain',
      className: 'border-danger/40 bg-danger/15 text-danger',
    },
  };
  const cfg = map[status];
  return (
    <span
      className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-0.5 rounded-sm border ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}
```

- [ ] **Step 5.4: Verify build + browse**

```bash
npm run build
```

Then run dev and visit `/coach/status/<clientId>/issues` for a client with known suggestions. Expected: client header renders, each day section lists every active exercise with a status chip, suggestions render Apply buttons. The "Apply all" button counts only `add_set`/`archive_day` items.

- [ ] **Step 5.5: Commit**

```bash
git add src/app/coach/status/[clientId]/issues
git commit -m "coach/status: issues page with per-exercise status + Apply all"
```

---

## Task 6: Client history data layer — weeks list

**Files:**
- Create: `src/lib/client-history.ts`
- Modify: `tests/status.test.ts`

- [ ] **Step 6.1: Write failing tests for `enumerateMondaysBetween`**

Append to `tests/status.test.ts` (before the summary block):

```ts
// ---------- enumerateMondaysBetween ----------

import { enumerateMondaysBetween } from '../src/lib/client-history';

eq(
  'history: single week range yields one Monday',
  enumerateMondaysBetween('2026-05-04', '2026-05-04'),
  ['2026-05-04'],
);

eq(
  'history: 3 consecutive Mondays',
  enumerateMondaysBetween('2026-04-20', '2026-05-04'),
  ['2026-04-20', '2026-04-27', '2026-05-04'],
);

eq(
  'history: start after end → empty',
  enumerateMondaysBetween('2026-05-04', '2026-04-20'),
  [],
);

eq(
  'history: non-Monday start gets snapped to ISO Monday of that week',
  // Wed 2026-04-22 → Monday 2026-04-20
  enumerateMondaysBetween('2026-04-22', '2026-04-27'),
  ['2026-04-20', '2026-04-27'],
);
```

- [ ] **Step 6.2: Run, confirm fail**

```bash
npx tsx tests/status.test.ts
```

Expected: module-not-found for `client-history`.

- [ ] **Step 6.3: Implement `src/lib/client-history.ts` (weeks portion)**

```ts
import 'server-only';

import { startOfWeek, formatISO, addWeeks, isBefore, isEqual } from 'date-fns';

import { db } from './supabase';

export type WeekRow = {
  weekStart: string;
  daysDone: number;
  daysTarget: number;
  totalSets: number;
  prCount: number;
  painCount: number;
  hasWorkouts: boolean;
};

/**
 * Pure: enumerate every ISO Monday (yyyy-mm-dd) from `startIso` through
 * `endIso` inclusive. Inputs are snapped to the Monday of their week
 * (weekStartsOn: 1). Returns [] when start > end. Exported for tests.
 */
export function enumerateMondaysBetween(startIso: string, endIso: string): string[] {
  const start = startOfWeek(new Date(`${startIso}T00:00:00Z`), { weekStartsOn: 1 });
  const end = startOfWeek(new Date(`${endIso}T00:00:00Z`), { weekStartsOn: 1 });
  if (isBefore(end, start)) return [];
  const out: string[] = [];
  let cur = start;
  while (isBefore(cur, end) || isEqual(cur, end)) {
    out.push(formatISO(cur, { representation: 'date' }));
    cur = addWeeks(cur, 1);
  }
  return out;
}

/**
 * Returns one row per ISO week from the client's program training_start_at
 * (or uploaded_at fallback) through the current ISO Monday. Empty weeks
 * appear with hasWorkouts=false. Returns null when the client doesn't exist.
 */
export async function listClientWeeks(
  clientId: string,
  at: Date = new Date(),
): Promise<WeekRow[] | null> {
  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, weekly_day_target')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return null;

  const { data: program } = await supa
    .from('programs')
    .select('uploaded_at, training_start_at')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!program) return [];

  const anchorIso = (program.training_start_at ?? program.uploaded_at).slice(0, 10);
  const todayIso = formatISO(at, { representation: 'date' });
  const weeks = enumerateMondaysBetween(anchorIso, todayIso);
  if (weeks.length === 0) return [];

  // Pull every completed workout in range (cap at first week start).
  const rangeStart = weeks[0];
  const [{ data: workouts }, { data: prs }] = await Promise.all([
    supa
      .from('workouts')
      .select('id, week_start, completed_at')
      .eq('client_id', clientId)
      .gte('week_start', rangeStart)
      .not('completed_at', 'is', null),
    supa
      .from('best_efforts')
      .select('updated_at')
      .eq('client_id', clientId)
      .gte('updated_at', `${rangeStart}T00:00:00Z`)
      .not('source_set_id', 'is', null),
  ]);

  const workoutIds = (workouts ?? []).map((w) => w.id);
  const { data: logs } = workoutIds.length
    ? await supa
        .from('exercise_logs')
        .select('id, workout_id, pain_reason')
        .in('workout_id', workoutIds)
    : { data: [] as Array<{ id: string; workout_id: string; pain_reason: string | null }> };

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa.from('sets').select('exercise_log_id').in('exercise_log_id', logIds)
    : { data: [] as Array<{ exercise_log_id: string }> };

  // Aggregate by week_start.
  type Bucket = { daysDone: number; totalSets: number; prCount: number; painCount: number };
  const byWeek = new Map<string, Bucket>();
  for (const wk of weeks) {
    byWeek.set(wk, { daysDone: 0, totalSets: 0, prCount: 0, painCount: 0 });
  }
  const workoutToWeek = new Map<string, string>();
  for (const w of workouts ?? []) {
    workoutToWeek.set(w.id, w.week_start);
    const b = byWeek.get(w.week_start);
    if (b) b.daysDone++;
  }
  const logToWorkout = new Map<string, string>();
  for (const l of logs ?? []) {
    logToWorkout.set(l.id, l.workout_id);
    if (l.pain_reason) {
      const wk = workoutToWeek.get(l.workout_id);
      const b = wk ? byWeek.get(wk) : null;
      if (b) b.painCount++;
    }
  }
  for (const s of sets ?? []) {
    const wkid = logToWorkout.get(s.exercise_log_id);
    const wk = wkid ? workoutToWeek.get(wkid) : null;
    const b = wk ? byWeek.get(wk) : null;
    if (b) b.totalSets++;
  }
  for (const pr of prs ?? []) {
    // Bucket the PR into the week containing pr.updated_at (Monday-of-week).
    const wk = formatISO(startOfWeek(new Date(pr.updated_at), { weekStartsOn: 1 }), {
      representation: 'date',
    });
    const b = byWeek.get(wk);
    if (b) b.prCount++;
  }

  const result: WeekRow[] = [];
  // Newest first.
  for (let i = weeks.length - 1; i >= 0; i--) {
    const wk = weeks[i];
    const b = byWeek.get(wk)!;
    result.push({
      weekStart: wk,
      daysDone: b.daysDone,
      daysTarget: client.weekly_day_target,
      totalSets: b.totalSets,
      prCount: b.prCount,
      painCount: b.painCount,
      hasWorkouts: b.daysDone > 0,
    });
  }
  return result;
}
```

- [ ] **Step 6.4: Run, confirm pass**

```bash
npm test
```

Expected: 4 new tests pass on top of the rest.

- [ ] **Step 6.5: Commit**

```bash
git add src/lib/client-history.ts tests/status.test.ts
git commit -m "lib/client-history: weeks list with PR/pain/set aggregates"
```

---

## Task 7: Weeks list page

**Files:**
- Create: `src/app/coach/status/[clientId]/history/page.tsx`

- [ ] **Step 7.1: Implement the page**

```tsx
import Link from 'next/link';
import { format } from 'date-fns';
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { listClientWeeks } from '@/lib/client-history';
import { buildClientIssues } from '@/lib/client-issues';
import { ClientHeader } from '../_components/client-header';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string }>;

export default async function ClientHistoryPage(props: { params: Params }) {
  await requireCoach();
  const { clientId } = await props.params;

  // Re-fetch lightweight client info (parallel with weeks list) for the header.
  const supa = db();
  const [issues, weeks, { data: client }] = await Promise.all([
    buildClientIssues(clientId),
    listClientWeeks(clientId),
    supa
      .from('clients')
      .select('id, name, weekly_day_target')
      .eq('id', clientId)
      .maybeSingle(),
  ]);

  if (!client || !issues || weeks == null) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <ClientHeader
        clientId={client.id}
        name={client.name}
        weeklyDayTarget={client.weekly_day_target}
        daysDone={issues.daysDoneThisWeek}
        hasIssues={issues.hasActionableIssues}
        issueCount={issues.issueCount}
        subnav="history"
      />

      {weeks.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No program uploaded yet.
        </p>
      ) : (
        <ul className="border-t border-border">
          {weeks.map((w) => (
            <li key={w.weekStart} className="border-b border-border">
              {w.hasWorkouts ? (
                <Link
                  href={`/coach/status/${clientId}/history/${w.weekStart}`}
                  prefetch={false}
                  className="group flex items-center justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
                >
                  <WeekRow w={w} muted={false} />
                </Link>
              ) : (
                <div className="flex items-center justify-between gap-4 px-2 py-4 opacity-60">
                  <WeekRow w={w} muted />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function WeekRow({
  w,
  muted,
}: {
  w: {
    weekStart: string;
    daysDone: number;
    daysTarget: number;
    totalSets: number;
    prCount: number;
    painCount: number;
    hasWorkouts: boolean;
  };
  muted: boolean;
}) {
  return (
    <>
      <p className={`font-display text-xl tracking-tight ${muted ? 'text-muted' : 'text-text'}`}>
        Week of {format(new Date(w.weekStart), 'MMM d')}
      </p>
      <p className="text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
        {muted ? (
          <span>no logs</span>
        ) : (
          <>
            <span className="text-muted">
              {w.daysDone}/{w.daysTarget}
            </span>{' '}
            days <span className="mx-1 text-border-strong">·</span>{' '}
            <span className="text-muted">{w.totalSets}</span> sets
            {w.prCount > 0 && (
              <>
                {' '}
                <span className="mx-1 text-border-strong">·</span>{' '}
                <span className="text-primary-hi">
                  {w.prCount} PR{w.prCount === 1 ? '' : 's'}
                </span>
              </>
            )}
            {w.painCount > 0 && (
              <>
                {' '}
                <span className="mx-1 text-border-strong">·</span>{' '}
                <span className="text-danger">{w.painCount} pain</span>
              </>
            )}
          </>
        )}
      </p>
    </>
  );
}
```

- [ ] **Step 7.2: Verify build + browse**

```bash
npm run build
```

Visit `/coach/status/<clientId>/history`. Expected: every ISO week since the program started, newest first, empty weeks muted.

- [ ] **Step 7.3: Commit**

```bash
git add src/app/coach/status/[clientId]/history/page.tsx
git commit -m "coach/status: weeks list with empty-week placeholders"
```

---

## Task 8: Week detail page + `getWeekWorkouts`

**Files:**
- Modify: `src/lib/client-history.ts` (append `getWeekWorkouts`)
- Create: `src/app/coach/status/[clientId]/history/[weekStart]/page.tsx`

- [ ] **Step 8.1: Append `getWeekWorkouts` to `src/lib/client-history.ts`**

After `listClientWeeks`, append:

```ts
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

/**
 * Returns workouts in a given ISO week for a client, sorted by started_at
 * ascending. Returns null when:
 *   - The client doesn't exist.
 *   - `weekStart` is not a valid YYYY-MM-DD Monday.
 *   - `weekStart` falls outside the program's range.
 */
export async function getWeekWorkouts(
  clientId: string,
  weekStart: string,
  at: Date = new Date(),
): Promise<WorkoutRow[] | null> {
  // Validate format + ISO-Monday + within program range.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  const wkDate = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(wkDate.getTime())) return null;
  // ISO Monday: getUTCDay() === 1.
  if (wkDate.getUTCDay() !== 1) return null;

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return null;

  const { data: program } = await supa
    .from('programs')
    .select('uploaded_at, training_start_at')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!program) return null;

  const anchorIso = (program.training_start_at ?? program.uploaded_at).slice(0, 10);
  const todayIso = formatISO(at, { representation: 'date' });
  const allowed = enumerateMondaysBetween(anchorIso, todayIso);
  if (!allowed.includes(weekStart)) return null;

  const { data: workouts } = await supa
    .from('workouts')
    .select('id, day_id, started_at, completed_at, is_missed, days(label)')
    .eq('client_id', clientId)
    .eq('week_start', weekStart)
    .order('started_at', { ascending: true });

  if (!workouts || workouts.length === 0) return [];

  const ids = workouts.map((w) => w.id);
  const { data: logs } = await supa
    .from('exercise_logs')
    .select('id, workout_id, pain_reason')
    .in('workout_id', ids);

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('id, exercise_log_id')
        .in('exercise_log_id', logIds)
    : { data: [] as Array<{ id: string; exercise_log_id: string }> };

  // PRs for this week (best_efforts updated within the week).
  const nextMonday = formatISO(addWeeks(new Date(`${weekStart}T00:00:00Z`), 1), {
    representation: 'date',
  });
  const { data: prs } = await supa
    .from('best_efforts')
    .select('source_set_id, updated_at')
    .eq('client_id', clientId)
    .gte('updated_at', `${weekStart}T00:00:00Z`)
    .lt('updated_at', `${nextMonday}T00:00:00Z`)
    .not('source_set_id', 'is', null);

  const setIdToWorkout = new Map<string, string>();
  const logToWorkout = new Map<string, string>();
  for (const l of logs ?? []) logToWorkout.set(l.id, l.workout_id);
  for (const s of sets ?? []) {
    const wid = logToWorkout.get(s.exercise_log_id);
    if (wid) setIdToWorkout.set(s.id, wid);
  }

  const setCount = new Map<string, number>();
  for (const s of sets ?? []) {
    const wid = logToWorkout.get(s.exercise_log_id);
    if (!wid) continue;
    setCount.set(wid, (setCount.get(wid) ?? 0) + 1);
  }

  const painCount = new Map<string, number>();
  for (const l of logs ?? []) {
    if (l.pain_reason) painCount.set(l.workout_id, (painCount.get(l.workout_id) ?? 0) + 1);
  }

  const prCount = new Map<string, number>();
  for (const pr of prs ?? []) {
    if (!pr.source_set_id) continue;
    const wid = setIdToWorkout.get(pr.source_set_id);
    if (!wid) continue;
    prCount.set(wid, (prCount.get(wid) ?? 0) + 1);
  }

  return workouts.map((w) => {
    const daysRaw = w.days as unknown;
    const day = (Array.isArray(daysRaw) ? daysRaw[0] : daysRaw) as { label?: string } | null;
    return {
      id: w.id,
      dayLabel: day?.label ?? '—',
      startedAt: w.started_at,
      completedAt: w.completed_at,
      isMissed: !!w.is_missed,
      setCount: setCount.get(w.id) ?? 0,
      prCount: prCount.get(w.id) ?? 0,
      painCount: painCount.get(w.id) ?? 0,
    };
  });
}
```

- [ ] **Step 8.2: Implement `src/app/coach/status/[clientId]/history/[weekStart]/page.tsx`**

```tsx
import Link from 'next/link';
import { format } from 'date-fns';
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { getWeekWorkouts } from '@/lib/client-history';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string; weekStart: string }>;

export default async function WeekDetailPage(props: { params: Params }) {
  await requireCoach();
  const { clientId, weekStart } = await props.params;

  const supa = db();
  const [workouts, { data: client }] = await Promise.all([
    getWeekWorkouts(clientId, weekStart),
    supa.from('clients').select('id, name').eq('id', clientId).maybeSingle(),
  ]);
  if (workouts == null || !client) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <Link
        href={`/coach/status/${clientId}/history`}
        prefetch={false}
        className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
      >
        ← {client.name} · history
      </Link>
      <h1 className="mt-4 font-display text-3xl sm:text-4xl tracking-tight">
        Week of {format(new Date(weekStart), 'MMM d, yyyy')}
      </h1>

      {workouts.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No workouts in this week.
        </p>
      ) : (
        <ul className="mt-6 border-t border-border">
          {workouts.map((w) => (
            <li key={w.id} className="border-b border-border">
              {w.isMissed ? (
                <div className="flex items-center justify-between gap-4 px-2 py-4 opacity-60">
                  <div>
                    <p className="font-display text-xl tracking-tight text-muted">
                      {w.dayLabel}
                    </p>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-faint">
                      Missed
                    </p>
                  </div>
                </div>
              ) : (
                <Link
                  href={`/coach/status/${clientId}/history/${weekStart}/${w.id}`}
                  prefetch={false}
                  className="flex items-center justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
                >
                  <div>
                    <p className="font-display text-xl tracking-tight">{w.dayLabel}</p>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
                      {format(new Date(w.startedAt), 'EEE h:mma').toLowerCase()}{' '}
                      <span className="mx-1 text-border-strong">·</span>{' '}
                      <span className="text-muted">{w.setCount}</span> sets
                      {w.prCount > 0 && (
                        <>
                          {' '}
                          <span className="mx-1 text-border-strong">·</span>{' '}
                          <span className="text-primary-hi">
                            {w.prCount} PR{w.prCount === 1 ? '' : 's'}
                          </span>
                        </>
                      )}
                      {w.painCount > 0 && (
                        <>
                          {' '}
                          <span className="mx-1 text-border-strong">·</span>{' '}
                          <span className="text-danger">pain</span>
                        </>
                      )}
                    </p>
                  </div>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 8.3: Build + verify**

```bash
npm run build
```

Visit `/coach/status/<clientId>/history/<a-known-monday>`. Expected: list of workouts in that week. Test 404 by passing a non-Monday date.

- [ ] **Step 8.4: Commit**

```bash
git add src/lib/client-history.ts src/app/coach/status/[clientId]/history/[weekStart]
git commit -m "coach/status: week detail page with per-workout PR/pain counts"
```

---

## Task 9: Workout detail page + `getWorkoutDetail`

**Files:**
- Modify: `src/lib/client-history.ts` (append `getWorkoutDetail`)
- Create: `src/app/coach/status/[clientId]/history/[weekStart]/[workoutId]/page.tsx`

- [ ] **Step 9.1: Append `getWorkoutDetail` to `src/lib/client-history.ts`**

```ts
export type SetDetail = {
  setNumber: number;
  weight: number | null;
  unit: 'kg' | 'lb' | null;
  reps: number | null;
  rir: number | null;
  videoUrl: string | null;
  notes: string | null;
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
  workout: {
    id: string;
    clientId: string;
    dayLabel: string;
    startedAt: string;
    completedAt: string | null;
    weekStart: string;
  };
  exercises: ExerciseLogDetail[];
};

/**
 * Full per-set workout log. Returns null when the workout doesn't exist or
 * doesn't belong to the given client/week.
 */
export async function getWorkoutDetail(
  clientId: string,
  weekStart: string,
  workoutId: string,
): Promise<WorkoutDetail | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  const supa = db();

  const { data: workout } = await supa
    .from('workouts')
    .select(
      'id, client_id, day_id, started_at, completed_at, week_start, days(label)',
    )
    .eq('id', workoutId)
    .maybeSingle();
  if (!workout) return null;
  if (workout.client_id !== clientId) return null;
  if (workout.week_start !== weekStart) return null;

  const { data: logs } = await supa
    .from('exercise_logs')
    .select(
      'id, exercise_id, pain_reason, client_note, exercises(name, prescribed_sets, prescription_raw, position)',
    )
    .eq('workout_id', workoutId);

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('id, exercise_log_id, set_number, weight, unit, reps, rir, video_url, notes')
        .in('exercise_log_id', logIds)
        .order('set_number', { ascending: true })
    : { data: [] as Array<{
        id: string;
        exercise_log_id: string;
        set_number: number;
        weight: number | string | null;
        unit: string | null;
        reps: number | null;
        rir: number | null;
        video_url: string | null;
        notes: string | null;
      }> };

  // PR set ids for this client.
  const { data: prs } = await supa
    .from('best_efforts')
    .select('source_set_id')
    .eq('client_id', clientId)
    .not('source_set_id', 'is', null);

  const prSetIds = new Set<string>();
  for (const p of prs ?? []) if (p.source_set_id) prSetIds.add(p.source_set_id);

  const setsByLog = new Map<string, SetDetail[]>();
  for (const s of sets ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      setNumber: s.set_number,
      weight: s.weight === null ? null : Number(s.weight),
      unit: s.unit === 'kg' || s.unit === 'lb' ? s.unit : null,
      reps: s.reps,
      rir: s.rir,
      videoUrl: s.video_url,
      notes: s.notes,
      isPR: prSetIds.has(s.id),
    });
    setsByLog.set(s.exercise_log_id, arr);
  }

  const exercises: ExerciseLogDetail[] = (logs ?? [])
    .map((l) => {
      const exRaw = l.exercises as unknown;
      const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as
        | { name?: string; prescribed_sets?: number | null; prescription_raw?: string | null; position?: number }
        | null;
      return {
        exerciseId: l.exercise_id,
        name: ex?.name ?? '—',
        prescribedSets: ex?.prescribed_sets ?? null,
        prescriptionRaw: ex?.prescription_raw ?? null,
        painReason: l.pain_reason,
        clientNote: l.client_note,
        sets: setsByLog.get(l.id) ?? [],
        _position: ex?.position ?? 0,
      };
    })
    .sort((a, b) => a._position - b._position)
    .map(({ _position, ...rest }) => rest);

  const daysRaw = workout.days as unknown;
  const day = (Array.isArray(daysRaw) ? daysRaw[0] : daysRaw) as { label?: string } | null;

  return {
    workout: {
      id: workout.id,
      clientId: workout.client_id,
      dayLabel: day?.label ?? '—',
      startedAt: workout.started_at,
      completedAt: workout.completed_at,
      weekStart: workout.week_start,
    },
    exercises,
  };
}
```

- [ ] **Step 9.2: Implement `src/app/coach/status/[clientId]/history/[weekStart]/[workoutId]/page.tsx`**

```tsx
import Link from 'next/link';
import { format } from 'date-fns';
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { getWorkoutDetail, type SetDetail } from '@/lib/client-history';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string; weekStart: string; workoutId: string }>;

export default async function WorkoutDetailPage(props: { params: Params }) {
  await requireCoach();
  const { clientId, weekStart, workoutId } = await props.params;

  const supa = db();
  const [detail, { data: client }] = await Promise.all([
    getWorkoutDetail(clientId, weekStart, workoutId),
    supa.from('clients').select('id, name').eq('id', clientId).maybeSingle(),
  ]);
  if (!detail || !client) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <Link
        href={`/coach/status/${clientId}/history/${weekStart}`}
        prefetch={false}
        className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
      >
        ← {client.name} · week of {format(new Date(weekStart), 'MMM d')}
      </Link>
      <h1 className="mt-4 font-display text-3xl sm:text-4xl tracking-tight">
        {detail.workout.dayLabel}
      </h1>
      <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
        {format(new Date(detail.workout.startedAt), 'EEE h:mma').toLowerCase()}
        {detail.workout.completedAt && (
          <>
            {' '}
            <span className="mx-1 text-border-strong">·</span> done{' '}
            {format(new Date(detail.workout.completedAt), 'h:mma').toLowerCase()}
          </>
        )}
      </p>

      {detail.exercises.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No exercises logged.
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          {detail.exercises.map((e) => (
            <section key={e.exerciseId}>
              <h2 className="font-medium text-text">{e.name}</h2>
              <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                {e.prescribedSets ?? '—'} set{e.prescribedSets === 1 ? '' : 's'}
                {e.prescriptionRaw && (
                  <span className="text-faint/80"> · {e.prescriptionRaw}</span>
                )}
              </p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-faint">
                    <th className="py-1 pr-3 font-normal">Set</th>
                    <th className="py-1 pr-3 font-normal">Weight</th>
                    <th className="py-1 pr-3 font-normal">Reps</th>
                    <th className="py-1 pr-3 font-normal">RIR</th>
                    <th className="py-1 pr-3 font-normal">Video</th>
                    <th className="py-1 pr-3 font-normal">PR</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {e.sets.map((s) => (
                    <SetRow key={s.setNumber} s={s} />
                  ))}
                </tbody>
              </table>
              {e.painReason && (
                <p className="mt-2 text-xs text-danger">Pain: {e.painReason}</p>
              )}
              {e.clientNote && (
                <p className="mt-1 text-xs text-muted">Note: {e.clientNote}</p>
              )}
              {e.sets.some((s) => s.notes) && (
                <ul className="mt-1 text-xs text-muted space-y-0.5">
                  {e.sets
                    .filter((s) => s.notes)
                    .map((s) => (
                      <li key={`note-${s.setNumber}`}>
                        Set {s.setNumber}: {s.notes}
                      </li>
                    ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function SetRow({ s }: { s: SetDetail }) {
  return (
    <tr className="border-t border-border">
      <td className="py-1.5 pr-3 text-muted">{s.setNumber}</td>
      <td className="py-1.5 pr-3">
        {s.weight == null ? '—' : `${s.weight} ${(s.unit ?? 'kg').toUpperCase()}`}
      </td>
      <td className="py-1.5 pr-3">{s.reps ?? '—'}</td>
      <td className="py-1.5 pr-3 text-muted">{s.rir ?? '—'}</td>
      <td className="py-1.5 pr-3">
        {s.videoUrl ? (
          <a
            href={s.videoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary-hi hover:underline"
          >
            ▶
          </a>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="py-1.5 pr-3">
        {s.isPR ? <span className="text-primary-hi">✓</span> : <span className="text-faint">—</span>}
      </td>
    </tr>
  );
}
```

- [ ] **Step 9.3: Build + verify**

```bash
npm run build
```

Visit `/coach/status/<clientId>/history/<weekStart>/<workoutId>`. Expected: full per-set table, PR ticks for any set that's the current PR holder. Confirm 404 with: a workoutId from a different client; a workoutId whose `week_start` doesn't match the URL.

- [ ] **Step 9.4: Commit**

```bash
git add src/lib/client-history.ts src/app/coach/status/[clientId]/history/[weekStart]/[workoutId]
git commit -m "coach/status: workout detail with per-set log + PR badges"
```

---

## Task 10: Cutover — delete old `/coach/weekly`

**Files:**
- Delete: `src/app/coach/weekly/` (whole directory)

- [ ] **Step 10.1: Verify nothing else links to `/coach/weekly`**

Grep the codebase (excluding the old directory itself):

```bash
grep -rn "coach/weekly" src --exclude-dir=node_modules
```

Expected hits: only files inside `src/app/coach/weekly/` (which we're about to delete). If there are stray links elsewhere — for example a leftover nav reference — update them to `/coach/status` first.

- [ ] **Step 10.2: Delete the directory**

```bash
rm -rf src/app/coach/weekly
```

(PowerShell: `Remove-Item -Recurse -Force src/app/coach/weekly`.)

- [ ] **Step 10.3: Build + test**

```bash
npm run build && npm test
```

Expected: build succeeds, all tests pass.

- [ ] **Step 10.4: Commit**

```bash
git add -A
git commit -m "coach: remove /coach/weekly, fully replaced by /coach/status"
```

---

## Done

Final manual smoke test:
1. `/coach/status` — cards render, badges render, View + Open/Review links go to correct sub-routes
2. `/coach/status/[id]/issues` — exercises grouped by day, status chips correct, Apply works, Apply all confirm sheet works
3. `/coach/status/[id]/history` — every week listed including empty, click into a week with workouts
4. `/coach/status/[id]/history/[week]` — workouts in week, missed workouts shown muted, click in
5. `/coach/status/[id]/history/[week]/[workout]` — full set log, PR ticks present, video links work
6. Old `/coach/weekly` URL → 404
7. Coach home nav shows "Status" linking correctly
