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

// ---------- best-effort.beats ----------

import { beats } from '../src/lib/best-effort';

eq('beats: no current → always wins', beats(null, null, 80, 8), true);
eq('beats: heavier wins', beats(100, 5, 105, 3), true);
eq('beats: lighter loses', beats(100, 5, 95, 10), false);
eq('beats: tie within epsilon, more reps wins', beats(100, 5, 100, 6), true);
eq('beats: tie within epsilon, fewer reps loses', beats(100, 8, 100, 6), false);
eq('beats: tie within epsilon, same reps does NOT count as new PR', beats(100, 5, 100, 5), false);
// 100 kg = 220.46226... lb exactly. Logging 220.46226 lb should tie 100 kg
// rather than fall through to "lighter" due to float precision.
eq('beats: float-precision tie counts as tie, more reps wins', beats(100, 5, 220.46226 * 0.45359237, 6), true);
eq('beats: float-precision tie with same reps loses', beats(100, 5, 220.46226 * 0.45359237, 5), false);
eq('beats: current reps null + matching weight + new reps → wins', beats(100, null, 100, 5), true);

// ---------- best-effort.prDeltaMessage ----------

import { prDeltaMessage } from '../src/lib/best-effort';

eq(
  'prDelta: first PR (no prior best)',
  prDeltaMessage(null, { weight: 100, unit: 'kg', reps: 5 }),
  'First PR for this exercise',
);

eq(
  'prDelta: weight PR same unit',
  prDeltaMessage({ weight: 95, unit: 'kg', reps: 6 }, { weight: 100, unit: 'kg', reps: 5 }),
  'Up 5 kg from your last PR',
);

eq(
  'prDelta: weight PR with fractional delta',
  prDeltaMessage({ weight: 100, unit: 'kg', reps: 5 }, { weight: 102.5, unit: 'kg', reps: 5 }),
  'Up 2.5 kg from your last PR',
);

eq(
  'prDelta: rep PR (same weight, more reps)',
  prDeltaMessage({ weight: 100, unit: 'kg', reps: 5 }, { weight: 100, unit: 'kg', reps: 7 }),
  '+2 reps at the same weight',
);

eq(
  'prDelta: rep PR singular',
  prDeltaMessage({ weight: 100, unit: 'kg', reps: 5 }, { weight: 100, unit: 'kg', reps: 6 }),
  '+1 rep at the same weight',
);

eq(
  'prDelta: weight PR across units shows new unit',
  // 200 lb = 90.7185 kg; new is 100 kg → up 9.3 kg.
  prDeltaMessage({ weight: 200, unit: 'lb', reps: 5 }, { weight: 100, unit: 'kg', reps: 5 }),
  'Up 9.3 kg from your last PR',
);

eq(
  'prDelta: lb new unit displayed in lb',
  prDeltaMessage({ weight: 100, unit: 'kg', reps: 5 }, { weight: 230, unit: 'lb', reps: 5 }),
  // 100 kg = 220.46 lb; new is 230 lb → up 9.5 lb.
  'Up 9.5 lb from your last PR',
);

// ---------- block-best.pickBlockBests ----------

import { pickBlockBests } from '../src/lib/block-best';

eq(
  'blockBest: empty in → empty out',
  Array.from(pickBlockBests([]).entries()),
  [],
);

eq(
  'blockBest: max weight wins, ties broken by reps',
  pickBlockBests([
    { nameKey: 'a', weight: 50, unit: 'kg', reps: 10 },
    { nameKey: 'a', weight: 52, unit: 'kg', reps: 8 },
    { nameKey: 'a', weight: 52, unit: 'kg', reps: 10 },
  ]).get('a'),
  { weight: 52, unit: 'kg', reps: 10 },
);

// A 40kg set must beat a 51lb (~23kg) set — comparison is kg-normalised, so
// this is exactly the fly-machine case where a stray kg entry outranks the
// real lb sets. (Data is corrected upstream; the picker still ranks by kg.)
eq(
  'blockBest: kg-normalised — 40kg beats 51lb',
  pickBlockBests([
    { nameKey: 'fly', weight: 51, unit: 'lb', reps: 8 },
    { nameKey: 'fly', weight: 40, unit: 'kg', reps: 10 },
  ]).get('fly'),
  { weight: 40, unit: 'kg', reps: 10 },
);

eq(
  'blockBest: 51lb beats 50lb',
  pickBlockBests([
    { nameKey: 'fly', weight: 50, unit: 'lb', reps: 10 },
    { nameKey: 'fly', weight: 51, unit: 'lb', reps: 8 },
  ]).get('fly'),
  { weight: 51, unit: 'lb', reps: 8 },
);

eq(
  'blockBest: null weight / null reps skipped',
  pickBlockBests([
    { nameKey: 'x', weight: null, unit: 'kg', reps: 5 },
    { nameKey: 'x', weight: 30, unit: 'kg', reps: null },
    { nameKey: 'x', weight: 20, unit: 'kg', reps: 6 },
  ]).get('x'),
  { weight: 20, unit: 'kg', reps: 6 },
);

eq(
  'blockBest: separate name_keys tracked independently',
  Array.from(
    pickBlockBests([
      { nameKey: 'a', weight: 10, unit: 'kg', reps: 8 },
      { nameKey: 'b', weight: 20, unit: 'kg', reps: 8 },
    ]).entries(),
  ),
  [
    ['a', { weight: 10, unit: 'kg', reps: 8 }],
    ['b', { weight: 20, unit: 'kg', reps: 8 }],
  ],
);

// ---------- session-summary helpers ----------

import { topSetOf, exerciseDelta } from '../src/lib/session-summary';

eq(
  'topSetOf: empty → null',
  topSetOf([]),
  null,
);

eq(
  'topSetOf: picks heaviest',
  topSetOf([
    { weight: 80, unit: 'kg', reps: 8 },
    { weight: 100, unit: 'kg', reps: 3 },
    { weight: 90, unit: 'kg', reps: 6 },
  ]),
  { weight: 100, unit: 'kg', reps: 3 },
);

eq(
  'topSetOf: ties on weight → most reps wins',
  topSetOf([
    { weight: 100, unit: 'kg', reps: 3 },
    { weight: 100, unit: 'kg', reps: 5 },
    { weight: 100, unit: 'kg', reps: 4 },
  ]),
  { weight: 100, unit: 'kg', reps: 5 },
);

eq(
  'topSetOf: ignores null weight/reps',
  topSetOf([
    { weight: null, unit: null, reps: null },
    { weight: 80, unit: 'kg', reps: 8 },
  ]),
  { weight: 80, unit: 'kg', reps: 8 },
);

eq(
  'exerciseDelta: no prior session',
  exerciseDelta({ weight: 100, unit: 'kg', reps: 5 }, null),
  { kind: 'first' },
);

eq(
  'exerciseDelta: heavier this time',
  exerciseDelta(
    { weight: 105, unit: 'kg', reps: 5 },
    { weight: 100, unit: 'kg', reps: 5 },
  ),
  { kind: 'better', text: '+5 kg vs last' },
);

eq(
  'exerciseDelta: same weight more reps',
  exerciseDelta(
    { weight: 100, unit: 'kg', reps: 7 },
    { weight: 100, unit: 'kg', reps: 5 },
  ),
  { kind: 'better', text: '+2 reps vs last' },
);

eq(
  'exerciseDelta: matched last session',
  exerciseDelta(
    { weight: 100, unit: 'kg', reps: 5 },
    { weight: 100, unit: 'kg', reps: 5 },
  ),
  { kind: 'tied', text: 'Matched last session' },
);

eq(
  'exerciseDelta: lighter this time',
  exerciseDelta(
    { weight: 95, unit: 'kg', reps: 5 },
    { weight: 100, unit: 'kg', reps: 5 },
  ),
  { kind: 'worse', text: '-5 kg vs last' },
);

// ---------- summary ----------

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`OK  ${passed} passed`);
