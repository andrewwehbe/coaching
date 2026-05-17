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
import {
  EMPTY_PROGRAM_CONTEXT,
  computeProgramContext,
} from '../src/lib/program-week';
import { swapMinProgramWeekFor } from '../src/lib/config';
import {
  countDeloadSignals,
  decideRecommendation,
  deriveForcedSwaps,
  type RecommenderInput,
} from '../src/lib/recommender';
import {
  computeClientRirDrift,
  computePerExerciseDrift,
  pickTopSetRir,
  type RirExposure,
} from '../src/lib/rir-drift';

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

// ---------- program-week.computeProgramContext ----------

const ctx = (
  input: Parameters<typeof computeProgramContext>[0],
  atIso: string,
) => computeProgramContext(input, new Date(atIso));

eq(
  'program-week: null input → empty',
  ctx(null, '2026-05-17T12:00:00Z'),
  EMPTY_PROGRAM_CONTEXT,
);

// Anchor and "now" both fall in the same ISO week → week 1.
eq(
  'program-week: anchor in current week → week 1',
  ctx(
    {
      trainingStartAt: null,
      uploadedAt: '2026-05-11T10:00:00Z', // Mon
      lastEditedAt: null,
      deloadWeekStarts: [],
    },
    '2026-05-14T08:00:00Z', // Thu of same week
  ),
  {
    weekInProgram: 1,
    weeksSinceUpload: 0,
    deloadCount: 0,
    weeksSinceLastDeload: null,
  },
);

// 4 ISO weeks after the anchor Monday → week 5.
eq(
  'program-week: 4 weeks past anchor → week 5',
  ctx(
    {
      trainingStartAt: '2026-04-13T00:00:00Z', // Mon
      uploadedAt: '2026-04-13T00:00:00Z',
      lastEditedAt: null,
      deloadWeekStarts: [],
    },
    '2026-05-11T00:00:00Z',
  ),
  {
    weekInProgram: 5,
    weeksSinceUpload: 4,
    deloadCount: 0,
    weeksSinceLastDeload: null,
  },
);

// training_start_at overrides uploaded_at for the week anchor (mid-meso
// transition). uploaded_at still drives weeksSinceUpload.
eq(
  'program-week: training_start_at anchors week counter, uploaded_at anchors edit recency',
  ctx(
    {
      trainingStartAt: '2026-03-09T00:00:00Z', // Mon — 9 weeks before "now"
      uploadedAt: '2026-05-04T00:00:00Z', // Mon — 1 week before "now"
      lastEditedAt: null,
      deloadWeekStarts: [],
    },
    '2026-05-11T00:00:00Z',
  ),
  {
    weekInProgram: 10,
    weeksSinceUpload: 1,
    deloadCount: 0,
    weeksSinceLastDeload: null,
  },
);

// Anchor in the future: clamps to week 1, weeksSinceUpload clamps to 0.
eq(
  'program-week: future anchor → clamps to 1 / 0',
  ctx(
    {
      trainingStartAt: '2026-06-01T00:00:00Z',
      uploadedAt: '2026-06-01T00:00:00Z',
      lastEditedAt: null,
      deloadWeekStarts: [],
    },
    '2026-05-11T00:00:00Z',
  ),
  {
    weekInProgram: 1,
    weeksSinceUpload: 0,
    deloadCount: 0,
    weeksSinceLastDeload: null,
  },
);

// Deload count + recency. Deload week_start values come from Postgres as
// yyyy-mm-dd strings.
eq(
  'program-week: 2 deloads since anchor, last one 1 week ago',
  ctx(
    {
      trainingStartAt: '2026-03-09T00:00:00Z',
      uploadedAt: '2026-03-09T00:00:00Z',
      lastEditedAt: null,
      deloadWeekStarts: ['2026-04-06', '2026-05-04'],
    },
    '2026-05-11T00:00:00Z',
  ),
  {
    weekInProgram: 10,
    weeksSinceUpload: 9,
    deloadCount: 2,
    weeksSinceLastDeload: 1,
  },
);

// Deload from a *previous* program (before the anchor) must NOT count.
eq(
  'program-week: deload before anchor week is excluded',
  ctx(
    {
      trainingStartAt: '2026-04-13T00:00:00Z',
      uploadedAt: '2026-04-13T00:00:00Z',
      lastEditedAt: null,
      deloadWeekStarts: ['2026-03-09', '2026-05-04'],
    },
    '2026-05-11T00:00:00Z',
  ),
  {
    weekInProgram: 5,
    weeksSinceUpload: 4,
    deloadCount: 1,
    weeksSinceLastDeload: 1,
  },
);

// lastEditedAt overrides uploaded_at for "weeksSinceUpload" — represents a
// coach edit AFTER the original sheet upload.
eq(
  'program-week: lastEditedAt preferred over uploaded_at',
  ctx(
    {
      trainingStartAt: '2026-03-09T00:00:00Z',
      uploadedAt: '2026-03-09T00:00:00Z',
      lastEditedAt: '2026-05-04T00:00:00Z', // edited 1 week before "now"
      deloadWeekStarts: [],
    },
    '2026-05-11T00:00:00Z',
  ),
  {
    weekInProgram: 10,
    weeksSinceUpload: 1,
    deloadCount: 0,
    weeksSinceLastDeload: null,
  },
);

// Current week is itself a deload → weeksSinceLastDeload === 0.
eq(
  'program-week: current week is a deload',
  ctx(
    {
      trainingStartAt: '2026-04-13T00:00:00Z',
      uploadedAt: '2026-04-13T00:00:00Z',
      lastEditedAt: null,
      deloadWeekStarts: ['2026-05-11'],
    },
    '2026-05-13T12:00:00Z',
  ),
  {
    weekInProgram: 5,
    weeksSinceUpload: 4,
    deloadCount: 1,
    weeksSinceLastDeload: 0,
  },
);

// ---------- suggestions.swapMinProgramWeekFor ----------

eq('swap-gate: null training_age → intermediate default (6)', swapMinProgramWeekFor(null), 6);
eq('swap-gate: undefined training_age → intermediate default (6)', swapMinProgramWeekFor(undefined), 6);
eq('swap-gate: novice → never (Infinity)', swapMinProgramWeekFor('novice'), Number.POSITIVE_INFINITY);
eq('swap-gate: intermediate → 6', swapMinProgramWeekFor('intermediate'), 6);
eq('swap-gate: advanced → 4', swapMinProgramWeekFor('advanced'), 4);

// ---------- recommender.deriveForcedSwaps ----------

eq(
  'forced-swaps: 1 incident → none (threshold is 2)',
  deriveForcedSwaps([
    { exerciseId: 'a', exerciseName: 'A', incidentCountInWindow: 1, worstPainType: 'joint' },
  ]),
  [],
);
eq(
  'forced-swaps: 2 joint incidents → joint swap',
  deriveForcedSwaps([
    { exerciseId: 'a', exerciseName: 'A', incidentCountInWindow: 2, worstPainType: 'joint' },
  ]),
  [{ exerciseId: 'a', exerciseName: 'A', reason: 'joint_pain' }],
);
eq(
  'forced-swaps: 2 tendon incidents → tendon swap',
  deriveForcedSwaps([
    { exerciseId: 'a', exerciseName: 'A', incidentCountInWindow: 2, worstPainType: 'tendon' },
  ]),
  [{ exerciseId: 'a', exerciseName: 'A', reason: 'tendon_pain' }],
);
eq(
  'forced-swaps: muscle pain never auto-swaps (DOMS)',
  deriveForcedSwaps([
    { exerciseId: 'a', exerciseName: 'A', incidentCountInWindow: 5, worstPainType: 'muscle' },
  ]),
  [],
);
eq(
  'forced-swaps: untyped pain → conservative swap (legacy reports)',
  deriveForcedSwaps([
    { exerciseId: 'a', exerciseName: 'A', incidentCountInWindow: 2, worstPainType: null },
  ]),
  [{ exerciseId: 'a', exerciseName: 'A', reason: 'recurring_pain_untyped' }],
);
eq(
  'forced-swaps: mixed batch routed correctly',
  deriveForcedSwaps([
    { exerciseId: 'a', exerciseName: 'A', incidentCountInWindow: 2, worstPainType: 'joint' },
    { exerciseId: 'b', exerciseName: 'B', incidentCountInWindow: 2, worstPainType: 'muscle' },
    { exerciseId: 'c', exerciseName: 'C', incidentCountInWindow: 3, worstPainType: 'tendon' },
  ]),
  [
    { exerciseId: 'a', exerciseName: 'A', reason: 'joint_pain' },
    { exerciseId: 'c', exerciseName: 'C', reason: 'tendon_pain' },
  ],
);

// ---------- recommender.countDeloadSignals ----------

check(
  'deload-signals: nothing → 0',
  countDeloadSignals({
    weeksSinceLastDeload: 2,
    fractionPrimaryLiftsStalled: 0,
    rirDriftAcrossBlock: null,
    newPainExerciseCount: 0,
    trainingAge: 'intermediate',
  }) === 0,
);
check(
  'deload-signals: long block + half stalled → 2',
  countDeloadSignals({
    weeksSinceLastDeload: 6,
    fractionPrimaryLiftsStalled: 0.5,
    rirDriftAcrossBlock: null,
    newPainExerciseCount: 0,
    trainingAge: 'intermediate',
  }) === 2,
);
check(
  'deload-signals: all four → 4',
  countDeloadSignals({
    weeksSinceLastDeload: 8,
    fractionPrimaryLiftsStalled: 0.75,
    rirDriftAcrossBlock: 2,
    newPainExerciseCount: 3,
    trainingAge: 'advanced',
  }) === 4,
);
check(
  'deload-signals: advanced block-len shorter (4) → trips weeks_since_deload sooner',
  countDeloadSignals({
    weeksSinceLastDeload: 4,
    fractionPrimaryLiftsStalled: 0,
    rirDriftAcrossBlock: null,
    newPainExerciseCount: 0,
    trainingAge: 'advanced',
  }) === 1,
);

// ---------- recommender.decideRecommendation ----------

const baseInput = (overrides: Partial<RecommenderInput> = {}): RecommenderInput => ({
  trainingAge: 'intermediate',
  primaryGoal: 'hypertrophy',
  sessionsCompleted: 12,
  sessionsPlanned: 12, // 100% adherence by default
  weekInProgram: 8,
  weeksSinceLastDeload: 3,
  painEvents: [],
  bodyWeightSlopePctPerWeek: null,
  strengthTrend: 'up',
  stallSignals: [],
  fractionPrimaryLiftsStalled: 0,
  rirDriftAcrossBlock: null,
  newPainExerciseCount: 0,
  weeksOnCurrentSplit: 8,
  ...overrides,
});

check(
  'rec: clean state → HOLD',
  decideRecommendation(baseInput()).type === 'hold',
);

// Gate 0: adherence
const lowAdherence = decideRecommendation(
  baseInput({ sessionsCompleted: 4, sessionsPlanned: 12 }), // 33%
);
check('rec: <50% adherence → REFER_ADHERENCE', lowAdherence.type === 'refer_adherence');
check(
  'rec: <50% adherence pre-empts stalls',
  decideRecommendation(
    baseInput({
      sessionsCompleted: 4,
      sessionsPlanned: 12,
      stallSignals: [
        {
          exerciseId: 'e1',
          exerciseName: 'Bench',
          dayId: 'd1',
          dayLabel: 'Upper',
          programWeek: 8,
          othersOnDayProgressing: true,
          muscleGroup: null,
        },
      ],
    }),
  ).type === 'refer_adherence',
);
const midAdherence = decideRecommendation(
  baseInput({
    sessionsCompleted: 8,
    sessionsPlanned: 12, // 67%
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Bench',
        dayId: 'd1',
        dayLabel: 'Upper',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
    ],
  }),
);
check('rec: 50-80% adherence → plateau gates suppressed (HOLD)', midAdherence.type === 'hold');

// Gate 1: forced swap co-emits with any decision
const cleanWithPain = decideRecommendation(
  baseInput({
    painEvents: [
      {
        exerciseId: 'e1',
        exerciseName: 'OHP',
        incidentCountInWindow: 2,
        worstPainType: 'joint',
      },
    ],
  }),
);
check(
  'rec: forced swap co-emits on a HOLD',
  cleanWithPain.type === 'hold' && cleanWithPain.forcedSwaps.length === 1,
);

// Gate 2: deload pre-empts plateau
const deload = decideRecommendation(
  baseInput({
    weeksSinceLastDeload: 6, // ≥ block_len (5 for intermediate)
    fractionPrimaryLiftsStalled: 0.6, // ≥ 0.5
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Bench',
        dayId: 'd1',
        dayLabel: 'Upper',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
    ],
  }),
);
check('rec: 2+ deload signals → TRIGGER_DELOAD', deload.type === 'trigger_deload');

// Gate 3: BW × strength
const deficitHold = decideRecommendation(
  baseInput({
    bodyWeightSlopePctPerWeek: -0.6,
    strengthTrend: 'flat',
    primaryGoal: 'fat_loss',
  }),
);
check('rec: fat-loss deficit + flat strength → HOLD', deficitHold.type === 'hold');
const deficitReferRecovery = decideRecommendation(
  baseInput({
    bodyWeightSlopePctPerWeek: -1.2, // aggressive
    strengthTrend: 'flat',
    primaryGoal: 'fat_loss',
  }),
);
check(
  'rec: aggressive BW loss + flat strength → REFER_RECOVERY',
  deficitReferRecovery.type === 'refer_recovery',
);
const surplusReferRecovery = decideRecommendation(
  baseInput({
    bodyWeightSlopePctPerWeek: 0.3,
    strengthTrend: 'down',
  }),
);
check(
  'rec: strength down + BW up → REFER_RECOVERY',
  surplusReferRecovery.type === 'refer_recovery',
);

// Gate 4: phase transition (block elapsed, signals below deload threshold)
const phase = decideRecommendation(
  baseInput({
    weeksSinceLastDeload: 6, // ≥ block_len 5 — 1 signal
    fractionPrimaryLiftsStalled: 0, // no second signal
  }),
);
check('rec: end of block w/o deload signals → PHASE_TRANSITION', phase.type === 'phase_transition');

// Gate 5a: day-level stall (≥2 on same day)
const dayStall = decideRecommendation(
  baseInput({
    weekInProgram: 8,
    weeksSinceLastDeload: 2, // short of block_len
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Bench',
        dayId: 'd1',
        dayLabel: 'Upper',
        programWeek: 8,
        othersOnDayProgressing: false,
        muscleGroup: null,
      },
      {
        exerciseId: 'e2',
        exerciseName: 'OHP',
        dayId: 'd1',
        dayLabel: 'Upper',
        programWeek: 8,
        othersOnDayProgressing: false,
        muscleGroup: null,
      },
    ],
  }),
);
check('rec: 2 stalls same day → EXERCISE_REORDER', dayStall.type === 'exercise_reorder');

// Gate 5b: systemic stall (≥3 distinct days)
const systemic = decideRecommendation(
  baseInput({
    weeksSinceLastDeload: 2,
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Bench',
        dayId: 'd1',
        dayLabel: 'Upper',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
      {
        exerciseId: 'e2',
        exerciseName: 'Squat',
        dayId: 'd2',
        dayLabel: 'Lower',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
      {
        exerciseId: 'e3',
        exerciseName: 'Row',
        dayId: 'd3',
        dayLabel: 'Pull',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
    ],
  }),
);
check('rec: stalls across 3 days → VOLUME_ADJUST', systemic.type === 'volume_adjust');

// Gate 5c: isolated swap (intermediate, post wk 6)
const isolatedSwap = decideRecommendation(
  baseInput({
    weekInProgram: 8,
    weeksSinceLastDeload: 2,
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Cable fly',
        dayId: 'd1',
        dayLabel: 'Push',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
    ],
  }),
);
check('rec: isolated stall wk 8 intermediate → SINGLE_EXERCISE_SWAP', isolatedSwap.type === 'single_exercise_swap');

const tooEarly = decideRecommendation(
  baseInput({
    weekInProgram: 3,
    weeksSinceLastDeload: 2,
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Cable fly',
        dayId: 'd1',
        dayLabel: 'Push',
        programWeek: 3,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
    ],
  }),
);
check('rec: isolated stall wk 3 intermediate → HOLD (too early)', tooEarly.type === 'hold');

const noviceStall = decideRecommendation(
  baseInput({
    trainingAge: 'novice',
    weeksSinceLastDeload: 2,
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Bench',
        dayId: 'd1',
        dayLabel: 'Upper',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: null,
      },
    ],
  }),
);
check(
  'rec: novice stall → REFER_TECHNIQUE_OR_LOADING (never swap)',
  noviceStall.type === 'refer_technique_or_loading',
);

// Gate 6: split rotation cadence
const splitRot = decideRecommendation(
  baseInput({ weeksOnCurrentSplit: 16, weeksSinceLastDeload: 2 }),
);
check('rec: ≥14 wks on split → SPLIT_ROTATION', splitRot.type === 'split_rotation');

// Gate 5b muscle targeting
const targetedVolume = decideRecommendation(
  baseInput({
    weeksSinceLastDeload: 2,
    stallSignals: [
      {
        exerciseId: 'e1',
        exerciseName: 'Squat',
        dayId: 'd1',
        dayLabel: 'Lower A',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: 'quads',
      },
      {
        exerciseId: 'e2',
        exerciseName: 'Leg press',
        dayId: 'd2',
        dayLabel: 'Lower B',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: 'quads',
      },
      {
        exerciseId: 'e3',
        exerciseName: 'Cable fly',
        dayId: 'd3',
        dayLabel: 'Push',
        programWeek: 8,
        othersOnDayProgressing: true,
        muscleGroup: 'chest',
      },
    ],
  }),
);
check(
  'rec: 3-day systemic w/ muscle tags → VOLUME_ADJUST targeting quads',
  targetedVolume.type === 'volume_adjust' &&
    targetedVolume.title.toLowerCase().includes('quads'),
);

// dataGaps surfacing
const gappy = decideRecommendation(
  baseInput({
    trainingAge: null,
    primaryGoal: null,
  }),
);
check(
  'rec: missing trainingAge surfaces dataGap',
  gappy.dataGaps.some((g) => g.includes('training_age')),
);

// ---------- rir-drift.pickTopSetRir ----------

eq(
  'pick-top: empty → null',
  pickTopSetRir([]),
  null,
);
eq(
  'pick-top: ignores sets missing weight/reps',
  pickTopSetRir([
    { weight: null, reps: 10, rir: 2 },
    { weight: 100, reps: null, rir: 2 },
    { weight: 95, reps: 8, rir: 3 },
  ]),
  { topWeight: 95, topRir: 3 },
);
eq(
  'pick-top: heaviest wins, tie broken by reps',
  pickTopSetRir([
    { weight: 100, reps: 8, rir: 1 },
    { weight: 100, reps: 10, rir: 0 },
    { weight: 95, reps: 12, rir: 4 },
  ]),
  { topWeight: 100, topRir: 0 },
);
eq(
  'pick-top: rir may be null on top set',
  pickTopSetRir([{ weight: 100, reps: 8, rir: null }]),
  { topWeight: 100, topRir: null },
);

// ---------- rir-drift.computePerExerciseDrift ----------

const expo = (date: string, w: number, rir: number | null): RirExposure => ({
  workoutStartedAt: date,
  topWeight: w,
  topRir: rir,
});

eq(
  'drift: <3 exposures → null',
  computePerExerciseDrift([expo('2026-01-01', 100, 2), expo('2026-01-08', 100, 1)]),
  null,
);
eq(
  'drift: any RIR-missing exposure skipped',
  computePerExerciseDrift([
    expo('2026-01-01', 100, 3),
    expo('2026-01-08', 100, null),
    expo('2026-01-15', 100, 1),
  ]),
  null, // only 2 RIR-logged → below threshold
);
check(
  'drift: flat RIR → 0',
  computePerExerciseDrift([
    expo('2026-01-01', 100, 2),
    expo('2026-01-08', 100, 2),
    expo('2026-01-15', 100, 2),
    expo('2026-01-22', 100, 2),
  ]) === 0,
);
check(
  'drift: RIR fell from 3 to 1 → drift > 0 (fatigue)',
  (computePerExerciseDrift([
    expo('2026-01-01', 100, 3),
    expo('2026-01-08', 100, 3),
    expo('2026-01-15', 100, 1),
    expo('2026-01-22', 100, 1),
  ]) ?? 0) === 2,
);
check(
  'drift: RIR rose → drift < 0 (easier over time)',
  (computePerExerciseDrift([
    expo('2026-01-01', 100, 1),
    expo('2026-01-08', 100, 1),
    expo('2026-01-15', 100, 3),
    expo('2026-01-22', 100, 3),
  ]) ?? 0) === -2,
);
eq(
  'drift: load decreased → null (uninterpretable)',
  computePerExerciseDrift([
    expo('2026-01-01', 100, 1),
    expo('2026-01-08', 100, 1),
    expo('2026-01-15', 95, 3),
    expo('2026-01-22', 95, 3),
  ]),
  null,
);
check(
  'drift: load increased → still computes (overload is OK)',
  (computePerExerciseDrift([
    expo('2026-01-01', 100, 3),
    expo('2026-01-08', 100, 3),
    expo('2026-01-15', 105, 1),
    expo('2026-01-22', 105, 1),
  ]) ?? 0) === 2,
);
check(
  'drift: out-of-order input is sorted by date',
  (computePerExerciseDrift([
    expo('2026-01-22', 100, 1),
    expo('2026-01-01', 100, 3),
    expo('2026-01-15', 100, 1),
    expo('2026-01-08', 100, 3),
  ]) ?? 0) === 2,
);

// ---------- rir-drift.computeClientRirDrift ----------

const noDriftEx = [expo('2026-01-01', 100, 2), expo('2026-01-08', 100, 2), expo('2026-01-15', 100, 2)];
const fatigueEx = [expo('2026-01-01', 100, 3), expo('2026-01-08', 100, 3), expo('2026-01-15', 100, 1), expo('2026-01-22', 100, 1)];

eq(
  'client-drift: 0 exercises with signal → null',
  computeClientRirDrift([{ exerciseId: 'a', exposures: [] }]),
  { drift: null, exerciseCount: 0 },
);
eq(
  'client-drift: 1 exercise with signal → null (need ≥2)',
  computeClientRirDrift([{ exerciseId: 'a', exposures: noDriftEx }]),
  { drift: null, exerciseCount: 1 },
);
check(
  'client-drift: 2 exercises both fatigue → mean drift',
  (() => {
    const result = computeClientRirDrift([
      { exerciseId: 'a', exposures: fatigueEx },
      { exerciseId: 'b', exposures: fatigueEx },
    ]);
    return result.exerciseCount === 2 && result.drift === 2;
  })(),
);
check(
  'client-drift: mixed signals average',
  (() => {
    const result = computeClientRirDrift([
      { exerciseId: 'a', exposures: fatigueEx }, // +2
      { exerciseId: 'b', exposures: noDriftEx }, // 0
    ]);
    return result.exerciseCount === 2 && result.drift === 1;
  })(),
);

// ---------- summary ----------

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`OK  ${passed} passed`);
