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

// ---------- summary ----------

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`OK  ${passed} passed`);
