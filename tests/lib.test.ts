/**
 * Pure-function tests for plateau + cue. No framework — runs with tsx and
 * exits non-zero on the first assertion failure:
 *
 *   npx tsx tests/lib.test.ts
 *
 * Add new cases as bare `check()` calls so the file stays grep-friendly.
 */
import {
  buildExposureHistory,
  countConsecutiveStalled,
  isEscalation,
  stageFor,
  type ExerciseLogRow,
  type Stage,
} from '../src/lib/plateau';
import { buildCue, type Best, type Prescription } from '../src/lib/cue';

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

// ---------- plateau.buildExposureHistory ----------

const log = (id: string, ts: string, sets: { weight: number | null; reps: number | null }[]): ExerciseLogRow => ({
  workoutId: id,
  workoutStartedAt: ts,
  sets,
});

eq(
  'exposure: skips logs with no valid sets',
  buildExposureHistory([
    log('w1', '2026-01-01', [{ weight: null, reps: null }]),
    log('w2', '2026-01-08', [{ weight: 100, reps: 8 }]),
  ]).map((e) => [e.weight, e.reps]),
  [[100, 8]],
);

eq(
  'exposure: picks max weight, tiebreak max reps',
  buildExposureHistory([
    log('w1', '2026-01-01', [
      { weight: 100, reps: 8 },
      { weight: 100, reps: 10 },
      { weight: 95, reps: 12 },
    ]),
  ]).map((e) => [e.weight, e.reps]),
  [[100, 10]],
);

eq(
  'exposure: sorted ascending by started_at',
  buildExposureHistory([
    log('w2', '2026-02-01', [{ weight: 110, reps: 8 }]),
    log('w1', '2026-01-01', [{ weight: 100, reps: 8 }]),
  ]).map((e) => e.workoutId),
  ['w1', 'w2'],
);

// ---------- plateau.countConsecutiveStalled ----------

eq(
  'stalled: zero history → 0',
  countConsecutiveStalled([]),
  0,
);

eq(
  'stalled: single exposure → 1 (no prior best)',
  countConsecutiveStalled([
    { weight: 100, reps: 8, workoutId: 'w', workoutStartedAt: '2026-01-01' },
  ]),
  1,
);

eq(
  'stalled: improvement breaks the streak',
  countConsecutiveStalled([
    { weight: 100, reps: 8, workoutId: 'w1', workoutStartedAt: '2026-01-01' },
    { weight: 105, reps: 8, workoutId: 'w2', workoutStartedAt: '2026-01-08' },
    { weight: 105, reps: 8, workoutId: 'w3', workoutStartedAt: '2026-01-15' },
  ]),
  1, // only w3 is stalled (no improvement over w2's prior best)
);

eq(
  'stalled: tiebreak on reps counts as improvement',
  countConsecutiveStalled([
    { weight: 100, reps: 8, workoutId: 'w1', workoutStartedAt: '2026-01-01' },
    { weight: 100, reps: 9, workoutId: 'w2', workoutStartedAt: '2026-01-08' },
  ]),
  0,
);

eq(
  'stalled: 4 non-improving in a row counts the first exposure too',
  countConsecutiveStalled([
    { weight: 100, reps: 8, workoutId: 'w1', workoutStartedAt: '2026-01-01' },
    { weight: 100, reps: 8, workoutId: 'w2', workoutStartedAt: '2026-01-08' },
    { weight: 95, reps: 8, workoutId: 'w3', workoutStartedAt: '2026-01-15' },
    { weight: 100, reps: 7, workoutId: 'w4', workoutStartedAt: '2026-01-22' },
  ]),
  4, // w1 has no prior best (treated as stalled), w2..w4 fail to improve
);

eq(
  'stalled: improvement at the END resets the streak',
  countConsecutiveStalled([
    { weight: 100, reps: 8, workoutId: 'w1', workoutStartedAt: '2026-01-01' },
    { weight: 100, reps: 8, workoutId: 'w2', workoutStartedAt: '2026-01-08' },
    { weight: 100, reps: 8, workoutId: 'w3', workoutStartedAt: '2026-01-15' },
    { weight: 105, reps: 8, workoutId: 'w4', workoutStartedAt: '2026-01-22' },
  ]),
  0,
);

// ---------- plateau.stageFor ----------

eq('stage: 3 → none', stageFor(3), 'none' as Stage);
eq('stage: 4 → watch', stageFor(4), 'watch' as Stage);
eq('stage: 6 → adjust', stageFor(6), 'adjust' as Stage);
eq('stage: 8 → swap_candidate', stageFor(8), 'swap_candidate' as Stage);
eq('stage: 100 → swap_candidate', stageFor(100), 'swap_candidate' as Stage);

// ---------- plateau.isEscalation ----------

check('escalation: none → watch is escalation', isEscalation('none', 'watch'));
check('escalation: watch → swap_candidate is escalation', isEscalation('watch', 'swap_candidate'));
check('escalation: adjust → watch is NOT escalation', !isEscalation('adjust', 'watch'));
check('escalation: same stage is NOT escalation', !isEscalation('watch', 'watch'));

// ---------- cue.buildCue ----------

const rx = (sets: number | null, lo: number | null, hi: number | null): Prescription => ({
  setsPrescribed: sets,
  repMin: lo,
  repMax: hi,
});

const best = (w: number | null, u: string | null, r: number | null): Best => ({
  weight: w,
  unit: u,
  reps: r,
});

eq(
  'cue: no prior best → first',
  buildCue(null, rx(3, 8, 12)),
  { kind: 'first' },
);

eq(
  'cue: best with no reps → log_reps',
  buildCue(best(100, 'kg', null), rx(3, 8, 12)),
  { kind: 'log_reps', weight: 100, unit: 'kg' },
);

eq(
  'cue: last reps below top → keep weight, beat reps',
  buildCue(best(100, 'kg', 10), rx(3, 8, 12)),
  { kind: 'keep', weight: 100, unit: 'kg', repsToBeat: 10 },
);

eq(
  'cue: last reps at top → beat weight, hit floor',
  buildCue(best(100, 'kg', 12), rx(3, 8, 12)),
  { kind: 'beat', weight: 100, unit: 'kg', repFloor: 8 },
);

eq(
  'cue: last reps above top → beat weight',
  buildCue(best(100, 'kg', 14), rx(3, 8, 12)),
  { kind: 'beat', weight: 100, unit: 'kg', repFloor: 8 },
);

// ---------- summary ----------

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`OK  ${passed} passed`);
