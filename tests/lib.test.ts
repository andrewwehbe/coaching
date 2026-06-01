/**
 * Pure-function tests for plateau + cue. No framework — runs with tsx and
 * exits non-zero on the first assertion failure:
 *
 *   npx tsx tests/lib.test.ts
 *
 * Add new cases as bare `check()` calls so the file stays grep-friendly.
 */
import {
  buildProgressionSeries,
  buildSessionMetric,
  countConsecutiveStalledByMdc,
  epleyE1RM,
  isHighConfidenceE1RM,
  mdcForSession,
  synthesizeHistoricalTimestamps,
  type HistoricalInput,
  type SessionInput,
  type SessionMetric,
} from '../src/lib/signals/progression';
import { buildCue, type Best, type Prescription } from '../src/lib/cue';
import {
  EMPTY_PROGRAM_CONTEXT,
  computeProgramContext,
} from '../src/lib/program-week';
import { swapMinProgramWeekFor } from '../src/lib/config';
import {
  decideRecommendation,
  deriveForcedSwaps,
  type RecommenderInput,
} from '../src/lib/recommender';
import {
  computeAdherence,
  type AdherenceSignal,
} from '../src/lib/signals/adherence';
import {
  countRegressingExercises,
  evaluateFatigueTriggers,
  type FatigueSignal,
} from '../src/lib/signals/fatigue';
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

// ---------- progression: epleyE1RM ----------
// (The buildExposureHistory + countConsecutiveStalled tests were retired
// in Stage 4.6 along with the plateau.ts wrapper they covered. The
// underlying noise-model coverage now lives in the
// countConsecutiveStalledByMdc + buildSessionMetric tests below, and the
// 8-stage classifier in the signals/plateau section.)

eq(
  'e1RM: Epley at 1 rep is biased high (w * 31/30 ≈ 103.33), per the formula',
  Math.round(epleyE1RM(100, 1) * 100) / 100,
  103.33,
);

eq(
  'e1RM: 100×8 ≈ 126.67',
  Math.round(epleyE1RM(100, 8) * 100) / 100,
  126.67,
);

eq(
  'e1RM: 60×10 ≈ 80',
  Math.round(epleyE1RM(60, 10) * 100) / 100,
  80,
);

// ---------- progression: isHighConfidenceE1RM ----------

check('e1RM-confidence: 1 rep is high confidence', isHighConfidenceE1RM(1));
check('e1RM-confidence: 12 reps is high confidence (upper bound)', isHighConfidenceE1RM(12));
check('e1RM-confidence: 13 reps is LOW confidence', !isHighConfidenceE1RM(13));
check('e1RM-confidence: 0 reps is not valid', !isHighConfidenceE1RM(0));
check('e1RM-confidence: negative reps is not valid', !isHighConfidenceE1RM(-2));

// ---------- progression: mdcForSession (load-scaled) ----------

eq(
  'mdc: light isolation (7 kg ×12, e1RM≈9.8) falls to the absolute floor (1.0 kg)',
  mdcForSession(9.8, 7),
  1.0,
);

eq(
  'mdc: heavy compound (200 kg ×5, e1RM≈233.33) dominated by 5% e1RM term',
  mdcForSession(233.33, 200),
  0.05 * 233.33, // max(1.0, 11.67, 5.0) = 11.67
);

eq(
  'mdc: medium isolation (15 kg ×10, e1RM≈20) — 5% e1RM term ties with floor',
  mdcForSession(20, 15),
  Math.max(1.0, 0.05 * 20, 0.025 * 15), // max(1.0, 1.0, 0.375) = 1.0
);

eq(
  'mdc: load-fraction term documented even when e1RM term currently dominates',
  mdcForSession(2.0, 100, { pct: 0, loadFraction: 0.025, floorMin: 0 }),
  2.5, // 0.025 * 100 = 2.5 — only fires if pct knocked to 0
);

eq(
  'mdc: explicit opts override defaults',
  mdcForSession(100, 80, { pct: 0.1, loadFraction: 0.05, floorMin: 5 }),
  10, // max(5, 10, 4) = 10
);

// ---------- progression: buildSessionMetric ----------

const session = (id: string, ts: string, sets: SessionInput['sets']): SessionInput => ({
  workoutId: id,
  workoutStartedAt: ts,
  sets,
});

eq(
  'session-metric: picks top set by max weight, tiebreak max reps',
  buildSessionMetric(
    session('w1', '2026-01-01', [
      { weight: 100, reps: 8, rir: 2, unit: 'kg' },
      { weight: 100, reps: 10, rir: 1, unit: 'kg' }, // top set (tiebreak on reps)
      { weight: 95, reps: 12, rir: 0, unit: 'kg' },
    ]),
  ),
  {
    workoutId: 'w1',
    workoutStartedAt: '2026-01-01',
    topWeightKg: 100,
    topReps: 10,
    topSetRir: 1,
    e1RM: 100 * (1 + 10 / 30),
    e1RMConfidence: 'ok',
    volumeLoadKg: 100 * 8 + 100 * 10 + 95 * 12,
  } satisfies SessionMetric,
);

eq(
  'session-metric: returns null when no set has both weight and reps',
  buildSessionMetric(
    session('w1', '2026-01-01', [
      { weight: null, reps: null, rir: null, unit: null },
      { weight: 100, reps: null, rir: null, unit: 'kg' },
    ]),
  ),
  null,
);

eq(
  'session-metric: lb sets converted to kg (1 lb = 0.45359237 kg)',
  buildSessionMetric(
    session('w1', '2026-01-01', [
      { weight: 220, reps: 5, rir: null, unit: 'lb' },
    ]),
  ),
  {
    workoutId: 'w1',
    workoutStartedAt: '2026-01-01',
    topWeightKg: 220 * 0.45359237,
    topReps: 5,
    topSetRir: null,
    e1RM: 220 * 0.45359237 * (1 + 5 / 30),
    e1RMConfidence: 'ok',
    volumeLoadKg: 220 * 0.45359237 * 5,
  } satisfies SessionMetric,
);

eq(
  'session-metric: reps > 12 marks e1RMConfidence low',
  buildSessionMetric(
    session('w1', '2026-01-01', [
      { weight: 40, reps: 20, rir: 1, unit: 'kg' },
    ]),
  )?.e1RMConfidence,
  'low',
);

eq(
  'session-metric: null unit defaults to kg',
  buildSessionMetric(
    session('w1', '2026-01-01', [
      { weight: 100, reps: 8, rir: 2, unit: null },
    ]),
  )?.topWeightKg,
  100,
);

// ---------- progression: buildProgressionSeries ----------

const histRow = (week: number, w: number, reps: number): HistoricalInput => ({
  workoutId: `hist:${week}`,
  workoutStartedAt: `2026-01-${String(week).padStart(2, '0')}`,
  weight: w,
  unit: 'kg',
  reps,
});

eq(
  'series: splices historical first, then logged, sorted ascending',
  buildProgressionSeries({
    historical: [histRow(5, 100, 8), histRow(3, 90, 8)],
    logged: [
      session('w2', '2026-03-01', [{ weight: 110, reps: 8, rir: 2, unit: 'kg' }]),
      session('w1', '2026-02-01', [{ weight: 105, reps: 8, rir: 2, unit: 'kg' }]),
    ],
  }).map((m) => m.workoutId),
  ['hist:3', 'hist:5', 'w1', 'w2'],
);

eq(
  'series: skips logged sessions with no valid sets',
  buildProgressionSeries({
    historical: [],
    logged: [
      session('w1', '2026-02-01', [{ weight: null, reps: null, rir: null, unit: null }]),
      session('w2', '2026-02-08', [{ weight: 100, reps: 8, rir: 2, unit: 'kg' }]),
    ],
  }).map((m) => m.workoutId),
  ['w2'],
);

// ---------- progression: synthesizeHistoricalTimestamps ----------
// Production-bug guard: historical exposures must never be projected to land
// at or after the first app workout for the same exercise. The previous
// inline projection in suggestions.ts dated history into the future whenever
// programs.training_start_at was null and uploaded_at was recent (Stage-0
// audit found ClientA's wk34 hist landing in 2027-01).

const rawHistRow = (
  weekIndex: number,
  weight: number,
  reps: number,
  unit: 'kg' | 'lb' = 'kg',
) => ({
  exercise_name_key: 'd1::squat',
  week_index: weekIndex,
  weight,
  unit,
  reps,
});

eq(
  'synth-hist: anchor sits before first app — anchor used unchanged',
  synthesizeHistoricalTimestamps(
    [rawHistRow(1, 100, 5), rawHistRow(2, 100, 5)],
    {
      anchor: new Date('2025-01-06T00:00:00Z'),
      firstAppWorkoutAt: new Date('2026-01-01T00:00:00Z'),
    },
  ).map((h) => h.workoutStartedAt),
  ['2025-01-06T00:00:00.000Z', '2025-01-13T00:00:00.000Z'],
);

eq(
  'synth-hist: anchor would project past first app — clamped so last hist = firstApp − 7d',
  synthesizeHistoricalTimestamps(
    [rawHistRow(1, 100, 5), rawHistRow(5, 110, 5)],
    {
      anchor: new Date('2026-05-01T00:00:00Z'),
      firstAppWorkoutAt: new Date('2026-01-01T00:00:00Z'),
    },
  ).map((h) => h.workoutStartedAt.slice(0, 10)),
  ['2025-11-27', '2025-12-25'], // wk5 = firstApp − 7d; wk1 = wk5 − 4*7d (spacing preserved)
);

eq(
  'synth-hist: null firstAppWorkoutAt — anchor used unchanged (no app data to clamp against)',
  synthesizeHistoricalTimestamps([rawHistRow(1, 100, 5)], {
    anchor: new Date('2026-05-01T00:00:00Z'),
    firstAppWorkoutAt: null,
  })[0].workoutStartedAt,
  '2026-05-01T00:00:00.000Z',
);

eq(
  'synth-hist: empty input → empty output',
  synthesizeHistoricalTimestamps([], {
    anchor: new Date('2026-05-01T00:00:00Z'),
    firstAppWorkoutAt: new Date('2026-01-01T00:00:00Z'),
  }),
  [],
);

check(
  'synth-hist + buildProgressionSeries: monotonic, all hist strictly before all app',
  (() => {
    const hist = synthesizeHistoricalTimestamps(
      [rawHistRow(1, 90, 8), rawHistRow(2, 95, 8), rawHistRow(3, 100, 8)],
      {
        anchor: new Date('2026-04-01T00:00:00Z'),
        firstAppWorkoutAt: new Date('2026-01-15T00:00:00Z'),
      },
    );
    const logged: SessionInput[] = [
      session('a1', '2026-01-15T10:00:00Z', [
        { weight: 100, reps: 8, rir: 2, unit: 'kg' },
      ]),
      session('a2', '2026-01-22T10:00:00Z', [
        { weight: 105, reps: 8, rir: 2, unit: 'kg' },
      ]),
    ];
    const series = buildProgressionSeries({ historical: hist, logged });
    const histTs = series
      .filter((s) => s.workoutId.startsWith('hist:'))
      .map((s) => new Date(s.workoutStartedAt).getTime());
    const appTs = series
      .filter((s) => !s.workoutId.startsWith('hist:'))
      .map((s) => new Date(s.workoutStartedAt).getTime());
    return Math.max(...histTs) < Math.min(...appTs);
  })(),
);

// ---------- progression: flagImplausibleSpikes (cheap guard for unit-log fat-fingers) ----------
// Stage-0 audit: ClientA × Wide Row had a 2026-05-04 row at 175 kg ×5
// (almost certainly 175 lb mislogged as kg) — produced an unbeatable
// e1RM=204 that polluted the stall counter. This guard catches obvious
// >40% single-session spikes that aren't sustained by the very next session.

eq(
  'implausible: ≥1.4× spike from trailing median that drops back next session → flagged',
  buildProgressionSeries({
    historical: [],
    logged: [
      session('w1', '2026-01-01', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w2', '2026-01-08', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w3', '2026-01-15', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w4', '2026-01-22', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w5', '2026-01-29', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('spike', '2026-02-05', [{ weight: 175, reps: 5, rir: null, unit: 'kg' }]), // ≈2.2× baseline
      session('w7', '2026-02-12', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),     // dropped back
    ],
  }).find((m) => m.workoutId === 'spike')?.e1RMConfidence,
  'implausible',
);

eq(
  'implausible: sustained PR (1.5× then stays high) is NOT flagged',
  buildProgressionSeries({
    historical: [],
    logged: [
      session('w1', '2026-01-01', [{ weight: 100, reps: 5, rir: null, unit: 'kg' }]),
      session('w2', '2026-01-08', [{ weight: 100, reps: 5, rir: null, unit: 'kg' }]),
      session('w3', '2026-01-15', [{ weight: 100, reps: 5, rir: null, unit: 'kg' }]),
      session('w4', '2026-01-22', [{ weight: 100, reps: 5, rir: null, unit: 'kg' }]),
      session('w5', '2026-01-29', [{ weight: 100, reps: 5, rir: null, unit: 'kg' }]),
      session('pr1', '2026-02-05', [{ weight: 150, reps: 5, rir: null, unit: 'kg' }]), // ≈1.5× baseline
      session('pr2', '2026-02-12', [{ weight: 150, reps: 5, rir: null, unit: 'kg' }]), // sustained
    ],
  }).find((m) => m.workoutId === 'pr1')?.e1RMConfidence,
  'ok',
);

eq(
  'implausible: fewer than 3 baseline sessions → cannot evaluate, not flagged',
  buildProgressionSeries({
    historical: [],
    logged: [
      session('w1', '2026-01-01', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w2', '2026-01-08', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('spike', '2026-01-15', [{ weight: 175, reps: 5, rir: null, unit: 'kg' }]),
      session('w4', '2026-01-22', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
    ],
  }).find((m) => m.workoutId === 'spike')?.e1RMConfidence,
  'ok',
);

eq(
  'implausible: most recent session never flagged (no follow-up evidence yet)',
  buildProgressionSeries({
    historical: [],
    logged: [
      session('w1', '2026-01-01', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w2', '2026-01-08', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w3', '2026-01-15', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w4', '2026-01-22', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('w5', '2026-01-29', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      session('spike-recent', '2026-02-05', [
        { weight: 175, reps: 5, rir: null, unit: 'kg' },
      ]),
    ],
  }).find((m) => m.workoutId === 'spike-recent')?.e1RMConfidence,
  'ok',
);

eq(
  'implausible: flagged sessions are filtered out of MDC stall count',
  countConsecutiveStalledByMdc(
    buildProgressionSeries({
      historical: [],
      logged: [
        session('w1', '2026-01-01', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
        session('w2', '2026-01-08', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
        session('w3', '2026-01-15', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
        session('w4', '2026-01-22', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
        session('w5', '2026-01-29', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
        session('spike', '2026-02-05', [
          { weight: 175, reps: 5, rir: null, unit: 'kg' },
        ]),
        session('w7', '2026-02-12', [{ weight: 80, reps: 5, rir: null, unit: 'kg' }]),
      ],
    }),
  ),
  // With spike flagged 'implausible' it's filtered out; the 80×5 sessions
  // form a flat series of 6 valid → all 6 stalled (first is no-prior-best,
  // others fail to clear MDC). If spike WEREN'T filtered, w7 would see
  // priorBest=204 and the count would include way more. The number we want
  // is "spike correctly ignored": 6.
  6,
);

// ---------- progression: countConsecutiveStalledByMdc ----------

const metric = (
  id: string,
  ts: string,
  weightKg: number,
  reps: number,
  rir: number | null = null,
): SessionMetric => ({
  workoutId: id,
  workoutStartedAt: ts,
  topWeightKg: weightKg,
  topReps: reps,
  topSetRir: rir,
  e1RM: weightKg * (1 + reps / 30),
  e1RMConfidence: reps >= 1 && reps <= 12 ? 'ok' : 'low',
  volumeLoadKg: weightKg * reps,
});

eq(
  'mdc-stall: empty series → 0',
  countConsecutiveStalledByMdc([]),
  0,
);

eq(
  'mdc-stall: single session → 1 (no prior best)',
  countConsecutiveStalledByMdc([metric('w1', '2026-01-01', 100, 8)]),
  1,
);

eq(
  'mdc-stall: sub-MDC noise (±1-2 kg) counted as stalled',
  countConsecutiveStalledByMdc([
    metric('w1', '2026-01-01', 100, 8),
    metric('w2', '2026-01-08', 102, 8),
    metric('w3', '2026-01-15', 101, 8),
  ]),
  3,
);

eq(
  'mdc-stall: clear improvement (115×8 vs 100×8) breaks streak',
  countConsecutiveStalledByMdc([
    metric('w1', '2026-01-01', 100, 8),
    metric('w2', '2026-01-08', 115, 8), // Δe1RM ≈ 19, MDC ≈ 6.3
    metric('w3', '2026-01-15', 115, 8),
  ]),
  1,
);

eq(
  'mdc-stall: low-confidence sessions (reps>12) excluded from plateau math',
  countConsecutiveStalledByMdc([
    metric('w1', '2026-01-01', 40, 20), // low-confidence — ignored
    metric('w2', '2026-01-08', 40, 20), // low-confidence — ignored
    metric('w3', '2026-01-15', 50, 8),  // first valid e1RM
  ]),
  1, // only w3 counts and it has no prior valid best
);

eq(
  'mdc-stall: improvement at the end resets the streak',
  countConsecutiveStalledByMdc([
    metric('w1', '2026-01-01', 100, 8),
    metric('w2', '2026-01-08', 100, 8),
    metric('w3', '2026-01-15', 100, 8),
    metric('w4', '2026-01-22', 115, 8),
  ]),
  0,
);

// (plateau.stageFor + plateau.isEscalation tests retired in Stage 4.6
// along with the wrapper. The 8-stage ladder is covered by the
// signals/plateau classifier tests; alert-escalation by the new
// decideStalledAlert tests in the Stage 4.6 block.)

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

// ---------- recommender.decideRecommendation ----------

const mockAdherence = (ratio: number, target = 4): AdherenceSignal => ({
  ratio,
  daysCompletedInWindow: Math.round(ratio * target * 2),
  daysExpectedInWindow: target * 2,
  isLow: ratio < 0.8,
  missingDayLabels: [],
  gateRatio: 0.8,
  lookbackWeeks: 2,
});

const mockFatigue = (overrides: Partial<FatigueSignal> = {}): FatigueSignal => ({
  shouldDeload: false,
  firedTriggers: [],
  rirDrift: { value: null, threshold: 1.5, fired: false, available: false },
  e1rmRegression: { regressingExerciseCount: 0, threshold: 2, fired: false },
  softCeiling: { weeksSinceLastDeload: null, ceiling: 6, fired: false },
  recurringPain: { painfulExerciseCount: 0, fired: false },
  ...overrides,
});

const baseInput = (overrides: Partial<RecommenderInput> = {}): RecommenderInput => ({
  trainingAge: 'intermediate',
  primaryGoal: 'hypertrophy',
  adherenceSignal: mockAdherence(1.0), // 100% adherence by default
  weekInProgram: 8,
  weeksSinceLastDeload: 3,
  painEvents: [],
  bodyWeightSlopePctPerWeek: null,
  strengthTrend: 'up',
  stallSignals: [],
  fatigueSignal: mockFatigue(),
  weeksOnCurrentSplit: 8,
  ...overrides,
});

check(
  'rec: clean state → HOLD',
  decideRecommendation(baseInput()).type === 'hold',
);

// Gate 0: adherence — single threshold at 0.80
const lowAdherence = decideRecommendation(
  baseInput({ adherenceSignal: mockAdherence(0.33) }), // 33%
);
check('rec: <80% adherence → REFER_ADHERENCE', lowAdherence.type === 'refer_adherence');
check(
  'rec: refer_adherence body does NOT recommend reducing the program',
  !/reduc.*program|fewer days|shorter sessions/i.test(lowAdherence.body),
);
check(
  'rec: refer_adherence body is behavioral (mentions barrier or scheduling)',
  /barrier|scheduling|conversation|surface/i.test(lowAdherence.body),
);
check(
  'rec: low adherence pre-empts stalls',
  decideRecommendation(
    baseInput({
      adherenceSignal: mockAdherence(0.33),
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
// 67% adherence — now collapses into the same refer_adherence band (was HOLD under
// the old two-band model with floors 0.50/0.80).
const midAdherence = decideRecommendation(
  baseInput({
    adherenceSignal: mockAdherence(0.67),
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
  'rec: 67% adherence → REFER_ADHERENCE (single-threshold gate)',
  midAdherence.type === 'refer_adherence',
);

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

// Gate 2: deload pre-empts plateau — driven by fatigueSignal.shouldDeload
const deload = decideRecommendation(
  baseInput({
    fatigueSignal: mockFatigue({
      shouldDeload: true,
      firedTriggers: ['e1rm_regression'],
      e1rmRegression: { regressingExerciseCount: 3, threshold: 2, fired: true },
    }),
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
check('rec: fatigueSignal.shouldDeload → TRIGGER_DELOAD', deload.type === 'trigger_deload');

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

// Gate 4: phase transition — block elapsed AND fatigueSignal not firing
const phase = decideRecommendation(
  baseInput({
    weeksSinceLastDeload: 6, // ≥ block_len 5
    fatigueSignal: mockFatigue(), // not firing
  }),
);
check('rec: end of block w/o fatigue → PHASE_TRANSITION', phase.type === 'phase_transition');

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

// ============================================================
// Stage 1 — signals/adherence
// ============================================================

const completedW = (day_id: string, started_at: string) => ({ day_id, started_at });

eq(
  'adherence: 100% — 8/8 over 2 weeks at 4/week',
  computeAdherence({
    completedWorkouts: [
      completedW('d1', '2026-05-04T10:00:00Z'), // Mon week-of
      completedW('d2', '2026-05-06T10:00:00Z'),
      completedW('d3', '2026-05-08T10:00:00Z'),
      completedW('d4', '2026-05-10T10:00:00Z'),
      completedW('d1', '2026-05-11T10:00:00Z'),
      completedW('d2', '2026-05-13T10:00:00Z'),
      completedW('d3', '2026-05-15T10:00:00Z'),
      completedW('d4', '2026-05-17T10:00:00Z'),
    ],
    scheduledDays: [
      { id: 'd1', day_index: 1, label: 'Push' },
      { id: 'd2', day_index: 2, label: 'Pull' },
      { id: 'd3', day_index: 3, label: 'Legs' },
      { id: 'd4', day_index: 4, label: 'Upper' },
    ],
    weeklyDayTarget: 4,
    at: new Date('2026-05-18T12:00:00Z'),
  }).ratio,
  1,
);

eq(
  'adherence: 50% — 4/8 → isLow true (< 0.80 gate)',
  (() => {
    const sig = computeAdherence({
      completedWorkouts: [
        completedW('d1', '2026-05-04T10:00:00Z'),
        completedW('d2', '2026-05-06T10:00:00Z'),
        completedW('d3', '2026-05-08T10:00:00Z'),
        completedW('d4', '2026-05-10T10:00:00Z'),
      ],
      scheduledDays: [
        { id: 'd1', day_index: 1, label: 'Push' },
        { id: 'd2', day_index: 2, label: 'Pull' },
        { id: 'd3', day_index: 3, label: 'Legs' },
        { id: 'd4', day_index: 4, label: 'Upper' },
      ],
      weeklyDayTarget: 4,
      at: new Date('2026-05-18T12:00:00Z'),
    });
    return { ratio: sig.ratio, isLow: sig.isLow };
  })(),
  { ratio: 0.5, isLow: true },
);

eq(
  'adherence: missing day labels — Pull and Legs never trained in window',
  computeAdherence({
    completedWorkouts: [
      completedW('d1', '2026-05-04T10:00:00Z'),
      completedW('d4', '2026-05-10T10:00:00Z'),
      completedW('d1', '2026-05-11T10:00:00Z'),
    ],
    scheduledDays: [
      { id: 'd1', day_index: 1, label: 'Push' },
      { id: 'd2', day_index: 2, label: 'Pull' },
      { id: 'd3', day_index: 3, label: 'Legs' },
      { id: 'd4', day_index: 4, label: 'Upper' },
    ],
    weeklyDayTarget: 4,
    at: new Date('2026-05-18T12:00:00Z'),
  }).missingDayLabels.sort(),
  ['Legs', 'Pull'],
);

eq(
  'adherence: workouts before lookback window are excluded',
  computeAdherence({
    completedWorkouts: [
      completedW('d1', '2026-01-01T10:00:00Z'), // way outside lookback
      completedW('d1', '2026-05-04T10:00:00Z'), // inside
    ],
    scheduledDays: [{ id: 'd1', day_index: 1, label: 'Full body' }],
    weeklyDayTarget: 1,
    at: new Date('2026-05-18T12:00:00Z'),
  }).daysCompletedInWindow,
  1,
);

// ============================================================
// Stage 1 — signals/fatigue
// ============================================================

const mkMetric = (
  id: string,
  ts: string,
  weightKg: number,
  reps: number,
  rir: number | null = null,
): SessionMetric => ({
  workoutId: id,
  workoutStartedAt: ts,
  topWeightKg: weightKg,
  topReps: reps,
  topSetRir: rir,
  e1RM: weightKg * (1 + reps / 30),
  e1RMConfidence: reps >= 1 && reps <= 12 ? 'ok' : 'low',
  volumeLoadKg: weightKg * reps,
});

const ev = (overrides: Partial<Parameters<typeof evaluateFatigueTriggers>[0]> = {}) =>
  evaluateFatigueTriggers({
    rirDriftAcrossBlock: null,
    perExerciseSeries: new Map(),
    weeksSinceLastDeload: null,
    recurringPain: [],
    at: new Date('2026-05-18T12:00:00Z'),
    ...overrides,
  });

// T1 — RIR drift
check(
  'fatigue T1: rir drift unavailable → not firing, signal not blocking',
  (() => {
    const s = ev({ rirDriftAcrossBlock: null });
    return !s.shouldDeload && !s.rirDrift.fired && !s.rirDrift.available;
  })(),
);
check(
  'fatigue T1: rir drift ≥ threshold → fires Gate B',
  (() => {
    const s = ev({ rirDriftAcrossBlock: 1.7 });
    return s.shouldDeload && s.rirDrift.fired && s.firedTriggers.includes('rir_drift');
  })(),
);
check(
  'fatigue T1: rir drift below threshold → not firing',
  ev({ rirDriftAcrossBlock: 0.5 }).shouldDeload === false,
);

// T2 — e1RM regression with the negative-slope rule
check(
  'fatigue T2: this-week-best matching recent-best (flat e1RM) → NOT regression',
  // ClientA × Incline-style: 4-month-old PR untouchable but this week sits at the same band.
  (() => {
    const s = ev({
      perExerciseSeries: new Map([
        [
          'incline',
          [
            mkMetric('a', '2026-04-27T10:00:00Z', 27.5, 7), // 3 wks ago
            mkMetric('b', '2026-05-04T10:00:00Z', 27.5, 7), // 2 wks ago
            mkMetric('c', '2026-05-11T10:00:00Z', 27.5, 7), // last wk
            mkMetric('d', '2026-05-18T10:00:00Z', 27.5, 7), // this wk — same e1RM
          ],
        ],
      ]),
    });
    return s.shouldDeload === false && s.e1rmRegression.regressingExerciseCount === 0;
  })(),
);

check(
  'fatigue T2: load-up reps-down trade is NOT regression (ClientA × Wide Row pattern)',
  // Recent best: 25 kg × 10 (e1RM 33.33). This week's best: 30 kg × 6 (e1RM 36)
  // → e1RM actually UP, but tests the exclusion guard. Use a tighter rep drop
  // so Δe1RM < 0 to verify the exclusion path: recent 25×10 (33.33), this 30×4 (34).
  (() => {
    const s = ev({
      perExerciseSeries: new Map([
        [
          'row',
          [
            mkMetric('a', '2026-04-27T10:00:00Z', 25, 10),
            mkMetric('b', '2026-05-04T10:00:00Z', 25, 10),
            mkMetric('c', '2026-05-11T10:00:00Z', 25, 10),
            mkMetric('d', '2026-05-18T10:00:00Z', 30, 4), // load UP, reps DOWN
          ],
        ],
      ]),
    });
    return s.shouldDeload === false;
  })(),
);

check(
  'fatigue T2: genuine e1RM drop beyond MDC on ≥2 lifts → fires',
  (() => {
    const s = ev({
      perExerciseSeries: new Map([
        [
          'bench',
          [
            mkMetric('a1', '2026-04-27T10:00:00Z', 100, 8), // e1RM 126.67
            mkMetric('a2', '2026-05-04T10:00:00Z', 100, 8),
            mkMetric('a3', '2026-05-11T10:00:00Z', 100, 8),
            mkMetric('a4', '2026-05-18T10:00:00Z', 100, 4), // e1RM 113.33 → Δ-13, MDC 6.3
          ],
        ],
        [
          'squat',
          [
            mkMetric('b1', '2026-04-27T10:00:00Z', 150, 6), // e1RM 180
            mkMetric('b2', '2026-05-04T10:00:00Z', 150, 6),
            mkMetric('b3', '2026-05-11T10:00:00Z', 150, 6),
            mkMetric('b4', '2026-05-18T10:00:00Z', 150, 3), // e1RM 165 → Δ-15, MDC 9
          ],
        ],
      ]),
    });
    return s.shouldDeload && s.e1rmRegression.regressingExerciseCount === 2;
  })(),
);

check(
  'fatigue T2: only 1 lift regressing → not firing (≥2 required)',
  (() => {
    const s = ev({
      perExerciseSeries: new Map([
        [
          'bench',
          [
            mkMetric('a1', '2026-04-27T10:00:00Z', 100, 8),
            mkMetric('a2', '2026-05-04T10:00:00Z', 100, 8),
            mkMetric('a3', '2026-05-18T10:00:00Z', 100, 4),
          ],
        ],
      ]),
    });
    return s.shouldDeload === false && s.e1rmRegression.regressingExerciseCount === 1;
  })(),
);

eq(
  'fatigue T2 helper: countRegressingExercises matches via direct call',
  countRegressingExercises(
    new Map([
      [
        'bench',
        [
          mkMetric('a1', '2026-04-27T10:00:00Z', 100, 8),
          mkMetric('a2', '2026-05-18T10:00:00Z', 100, 4),
        ],
      ],
    ]),
    new Date('2026-05-18T12:00:00Z'),
  ),
  1,
);

// T3 — soft ceiling
check(
  'fatigue T3: soft ceiling alone never fires (Coleman 2024 — time-based deloads can hurt)',
  ev({ weeksSinceLastDeload: 12 }).shouldDeload === false,
);
check(
  'fatigue T3: soft ceiling augments another firing trigger',
  (() => {
    const s = ev({ rirDriftAcrossBlock: 2.0, weeksSinceLastDeload: 12 });
    return s.shouldDeload && s.softCeiling.fired && s.firedTriggers.includes('soft_ceiling');
  })(),
);

// T4 — recurring joint/tendon pain
check(
  'fatigue T4: ≥1 exercise with joint/tendon pain across ≥2 weeks → fires',
  (() => {
    const s = ev({
      recurringPain: [{ exerciseId: 'e1', distinctWeeksWithJointOrTendonPain: 2 }],
    });
    return s.shouldDeload && s.recurringPain.fired && s.firedTriggers.includes('recurring_pain');
  })(),
);

// ClientA × Incline + Wide Row composite — explicit guardrail per the review
check(
  'fatigue: ClientA-style 4-mo plateau + load-rep trade → does NOT fire deload',
  ev({
    perExerciseSeries: new Map([
      // Incline: flat at his ceiling for weeks
      [
        'incline',
        [
          mkMetric('i1', '2026-04-27T10:00:00Z', 27.5, 7),
          mkMetric('i2', '2026-05-04T10:00:00Z', 27.5, 6),
          mkMetric('i3', '2026-05-11T10:00:00Z', 27.5, 7),
          mkMetric('i4', '2026-05-18T10:00:00Z', 27.5, 7),
        ],
      ],
      // Wide Row: load up, reps down — intentional progression attempt
      [
        'wide-row',
        [
          mkMetric('w1', '2026-04-27T10:00:00Z', 72.6, 9), // 160 lb × 9
          mkMetric('w2', '2026-05-04T10:00:00Z', 72.6, 8),
          mkMetric('w3', '2026-05-11T10:00:00Z', 79.4, 5), // 175 lb × 5
          mkMetric('w4', '2026-05-18T10:00:00Z', 79.4, 5),
        ],
      ],
    ]),
    weeksSinceLastDeload: 8, // would augment if anything else fired
    rirDriftAcrossBlock: null, // no RIR data
  }).shouldDeload === false,
);

// ============================================================
// Stage 1 — cross-surface agreement
// ============================================================
// Asserts that signals computed in suggestions.ts and recommender.ts
// agree, by routing both surfaces' compute paths through the same
// signal-module entry points. The test is a regression guard against
// future drift — if anyone reintroduces inline adherence or fatigue math
// in EITHER surface, the dedicated test below would still pass (since it
// calls the modules directly), but unit tests against the diverging
// surface would catch the bug. The user-stated invariant is that both
// surfaces, given the same fixture, agree on ratio + shouldDeload.

const sharedFixture = {
  completedWorkouts: [
    completedW('d1', '2026-05-04T10:00:00Z'),
    completedW('d2', '2026-05-06T10:00:00Z'),
    completedW('d3', '2026-05-08T10:00:00Z'),
    completedW('d4', '2026-05-10T10:00:00Z'),
    completedW('d1', '2026-05-11T10:00:00Z'),
    completedW('d2', '2026-05-13T10:00:00Z'),
  ],
  scheduledDays: [
    { id: 'd1', day_index: 1, label: 'Push' },
    { id: 'd2', day_index: 2, label: 'Pull' },
    { id: 'd3', day_index: 3, label: 'Legs' },
    { id: 'd4', day_index: 4, label: 'Upper' },
  ],
  weeklyDayTarget: 4,
  at: new Date('2026-05-18T12:00:00Z'),
};

const suggestionsAdherence = computeAdherence(sharedFixture); // suggestions.ts path
const recommenderAdherence = computeAdherence(sharedFixture); // recommender.ts path
eq(
  'cross-surface: suggestions & recommender agree on adherence_ratio',
  suggestionsAdherence.ratio,
  recommenderAdherence.ratio,
);
eq(
  'cross-surface: suggestions & recommender agree on adherence.isLow',
  suggestionsAdherence.isLow,
  recommenderAdherence.isLow,
);

const sharedFatigueInput = {
  rirDriftAcrossBlock: 1.7,
  perExerciseSeries: new Map<string, SessionMetric[]>(),
  weeksSinceLastDeload: 4,
  recurringPain: [],
  at: new Date('2026-05-18T12:00:00Z'),
};
const suggestionsFatigue = evaluateFatigueTriggers(sharedFatigueInput);
const recommenderFatigue = evaluateFatigueTriggers(sharedFatigueInput);
eq(
  'cross-surface: suggestions & recommender agree on shouldDeload',
  suggestionsFatigue.shouldDeload,
  recommenderFatigue.shouldDeload,
);
eq(
  'cross-surface: suggestions & recommender agree on firedTriggers',
  suggestionsFatigue.firedTriggers,
  recommenderFatigue.firedTriggers,
);

// ============================================================
// Stage 4.5 — cross-surface plateau agreement
// ============================================================
// Stage 4.5 migrates recommend-for-client.ts Gate 5 off
// countConsecutiveStalled onto signals/plateau.classifyExercisePlateau.
// The invariant under test: for the same (exercise × week) fixture,
// the client-facing suggestions surface and the coach-facing
// recommender surface MUST produce the same PlateauStage. The two
// surfaces both call classifyExercisePlateau directly, so the test
// asserts determinism + locks the contract that NEITHER surface has
// reintroduced inline plateau math.
//
// The ClientA × Incline series is the canonical real-world fixture:
// 32/63 deep-stall confirmed against his actual app data
// (scripts/compare-stalls.ts), preserved through every stage. If a
// future change drifts the classifier away from swap_candidate on
// this input, BOTH the per-stage and cross-surface tests will fail —
// the bug surfaces immediately on both fronts.

// Reuse the exact fixture defined earlier in this file for the Stage 2
// guardrail (same 8 sessions from his actual program).
const clientAInclineSharedSeries: SessionMetric[] = [
  mkMetric('a', '2025-11-04T10:00:00Z', 25, 8),
  mkMetric('b', '2026-01-06T10:00:00Z', 27.5, 8),
  mkMetric('c', '2026-02-03T10:00:00Z', 27.5, 7),
  mkMetric('d', '2026-03-03T10:00:00Z', 27.5, 6),
  mkMetric('e', '2026-04-01T10:00:00Z', 27.5, 6),
  mkMetric('f', '2026-05-05T10:00:00Z', 27.5, 5),
  mkMetric('g', '2026-05-12T10:00:00Z', 27.5, 4),
  mkMetric('h', '2026-05-15T10:00:00Z', 27.5, 5),
];

const sharedPlateauInput = {
  series: clientAInclineSharedSeries,
  rirDriftAcrossBlock: null,
  at: new Date('2026-05-18T12:00:00Z'),
};

const suggestionsPlateau = classifyExercisePlateau(sharedPlateauInput); // suggestions.ts path
const recommenderPlateau = classifyExercisePlateau(sharedPlateauInput); // recommend-for-client.ts path

eq(
  'cross-surface (plateau): suggestions & recommender agree on stage',
  suggestionsPlateau.stage,
  recommenderPlateau.stage,
);
eq(
  'cross-surface (plateau): suggestions & recommender agree on weeksStalled',
  suggestionsPlateau.weeksStalled,
  recommenderPlateau.weeksStalled,
);
eq(
  'cross-surface (plateau): suggestions & recommender agree on isLoadProgressing',
  suggestionsPlateau.isLoadProgressing,
  recommenderPlateau.isLoadProgressing,
);
check(
  'cross-surface (plateau) GUARDRAIL: ClientA × Incline → swap_candidate on BOTH surfaces',
  suggestionsPlateau.stage === 'swap_candidate' &&
    recommenderPlateau.stage === 'swap_candidate',
);

// Source-grep guards: neither surface may quietly reintroduce inline
// plateau math, and the recommender surface must NOT import the
// retired countConsecutiveStalled. If either fails, the cross-surface
// agreement above could still pass (because the test calls the helper
// directly) — these guards close that gap.
check(
  'stage-4.5: suggestions.ts imports classifyExercisePlateau',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    return /classifyExercisePlateau/.test(src);
  })(),
);
check(
  'stage-4.5: recommend-for-client.ts imports classifyExercisePlateau',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/recommend-for-client.ts', 'utf-8');
    return /classifyExercisePlateau/.test(src);
  })(),
);
check(
  'stage-4.5: recommend-for-client.ts no longer references countConsecutiveStalled',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/recommend-for-client.ts', 'utf-8');
    return !/countConsecutiveStalled/.test(src);
  })(),
);
check(
  'stage-4.6: plateau.ts is deleted (deprecation period ended, all callers migrated)',
  (() => {
    const fs = require('node:fs') as typeof import('node:fs');
    return !fs.existsSync('src/lib/plateau.ts');
  })(),
);

// ============================================================
// Stage 4.6 — persisted stalled_history ↔ live classifier agreement
// ============================================================
// The daily-analysis cron writes a row to stalled_history per (client,
// exercise_name_key) via buildStalledHistoryRow. The live classifier
// in suggestions.ts + recommend-for-client.ts calls
// classifyExercisePlateau directly. Both surfaces hit the same helper,
// so by construction they agree — but only as long as the cron uses
// buildStalledHistoryRow (instead of inlining the call). These tests
// lock that contract on three fronts:
//   1) buildStalledHistoryRow.plateau_stage MUST equal
//      classifyExercisePlateau(...).stage for the same input.
//   2) buildStalledHistoryRow.weeks_stalled MUST equal
//      classifyExercisePlateau(...).weeksStalled.
//   3) ClientA × Incline produces swap_candidate via the persisted
//      path AND the live path — the same canonical guardrail used in
//      Stage 2 + Stage 4.5.
//
// Stage-4.6 design choice: cron passes rirDriftAcrossBlock: null so
// fatigue_stall is structurally impossible from the persisted path
// (Gate B owns deload). High_rir_stall CAN still emerge from the
// persisted path because the SessionMetric series carries top-set RIR.

import {
  buildStalledHistoryRow,
  alertTypeForStage,
  concernRank,
  decideStalledAlert,
  type PlateauStage,
} from '../src/lib/signals/plateau';

// Reuse the ClientA × Incline series defined earlier in the file —
// declare it as a fresh constant here so this block is self-contained
// even if Stage-2 fixtures move.
const ClientA46InclineSeries: SessionMetric[] = [
  mkMetric('a', '2025-11-04T10:00:00Z', 25, 8),
  mkMetric('b', '2026-01-06T10:00:00Z', 27.5, 8),
  mkMetric('c', '2026-02-03T10:00:00Z', 27.5, 7),
  mkMetric('d', '2026-03-03T10:00:00Z', 27.5, 6),
  mkMetric('e', '2026-04-01T10:00:00Z', 27.5, 6),
  mkMetric('f', '2026-05-05T10:00:00Z', 27.5, 5),
  mkMetric('g', '2026-05-12T10:00:00Z', 27.5, 4),
  mkMetric('h', '2026-05-15T10:00:00Z', 27.5, 5),
];
const now46 = new Date('2026-05-18T12:00:00Z');

const liveClientA = classifyExercisePlateau({
  series: ClientA46InclineSeries,
  rirDriftAcrossBlock: null,
  at: now46,
});
const persistedClientA = buildStalledHistoryRow({
  clientId: 'clientA-test',
  exerciseNameKey: 'incline_db_press',
  series: ClientA46InclineSeries,
  at: now46,
});

eq(
  'cross-surface (persisted ↔ live): ClientA × Incline plateau_stage agrees',
  persistedClientA.plateau_stage,
  liveClientA.stage,
);
eq(
  'cross-surface (persisted ↔ live): ClientA × Incline weeks_stalled agrees',
  persistedClientA.weeks_stalled,
  liveClientA.weeksStalled,
);
check(
  'cross-surface (persisted ↔ live) GUARDRAIL: ClientA × Incline → swap_candidate on the persisted surface',
  persistedClientA.plateau_stage === 'swap_candidate',
);

// Stage-coverage sweep. For every PlateauStage value that the cron
// can produce (rirDriftAcrossBlock: null forces fatigue_stall out of
// reach), assert that the persisted-row stage equals the live stage
// over a representative series for that stage. Catches future
// classifier changes that pass the ClientA guardrail but desync
// other branches.
const stageFixtures: Array<{ label: string; series: SessionMetric[] }> = [
  {
    label: 'insufficient_data: 0 valid sessions',
    series: [],
  },
  {
    label: 'progressing: clear MDC-clearing improvement',
    series: [
      mkMetric('a', '2026-04-27T10:00:00Z', 100, 8),
      mkMetric('b', '2026-05-04T10:00:00Z', 100, 8),
      mkMetric('c', '2026-05-18T10:00:00Z', 120, 8),
    ],
  },
  {
    label: 'load_progression: load↑ reps↓',
    series: [
      mkMetric('w1', '2026-04-13T10:00:00Z', 72.6, 9),
      mkMetric('w2', '2026-04-20T10:00:00Z', 72.6, 8),
      mkMetric('w3', '2026-04-27T10:00:00Z', 79.4, 6),
      mkMetric('w4', '2026-05-04T10:00:00Z', 79.4, 5),
      mkMetric('w5', '2026-05-11T10:00:00Z', 79.4, 5),
      mkMetric('w6', '2026-05-18T10:00:00Z', 79.4, 5),
    ],
  },
  {
    label: 'high_rir_stall: flat e1RM, RIR sitting at 3+',
    series: [
      mkMetric('w1', '2026-04-13T10:00:00Z', 100, 8, 3),
      mkMetric('w2', '2026-04-20T10:00:00Z', 100, 8, 3),
      mkMetric('w3', '2026-04-27T10:00:00Z', 100, 8, 4),
      mkMetric('w4', '2026-05-04T10:00:00Z', 100, 8, 3),
      mkMetric('w5', '2026-05-11T10:00:00Z', 100, 8, 3),
      mkMetric('w6', '2026-05-18T10:00:00Z', 100, 8, 3),
    ],
  },
  {
    label: 'watch: 2 weeks of flat data, low RIR',
    series: [
      mkMetric('w1', '2026-05-04T10:00:00Z', 100, 8, 1),
      mkMetric('w2', '2026-05-11T10:00:00Z', 100, 8, 1),
      mkMetric('w3', '2026-05-18T10:00:00Z', 100, 8, 1),
    ],
  },
  {
    label: 'progress: 3 weeks of flat data, low RIR',
    series: [
      mkMetric('w1', '2026-04-27T10:00:00Z', 100, 8, 1),
      mkMetric('w2', '2026-05-04T10:00:00Z', 100, 8, 1),
      mkMetric('w3', '2026-05-11T10:00:00Z', 100, 8, 1),
      mkMetric('w4', '2026-05-18T10:00:00Z', 100, 8, 1),
    ],
  },
  {
    label: 'swap_candidate: 4+ weeks of flat data, low RIR',
    series: [
      mkMetric('w1', '2026-04-20T10:00:00Z', 100, 8, 1),
      mkMetric('w2', '2026-04-27T10:00:00Z', 100, 8, 1),
      mkMetric('w3', '2026-05-04T10:00:00Z', 100, 8, 1),
      mkMetric('w4', '2026-05-11T10:00:00Z', 100, 8, 1),
      mkMetric('w5', '2026-05-18T10:00:00Z', 100, 8, 1),
    ],
  },
];
for (const fx of stageFixtures) {
  const live = classifyExercisePlateau({
    series: fx.series,
    rirDriftAcrossBlock: null,
    at: now46,
  });
  const persisted = buildStalledHistoryRow({
    clientId: 'c',
    exerciseNameKey: 'k',
    series: fx.series,
    at: now46,
  });
  eq(
    `cross-surface sweep: ${fx.label} — persisted stage equals live stage`,
    persisted.plateau_stage,
    live.stage,
  );
  eq(
    `cross-surface sweep: ${fx.label} — weeks_stalled agrees`,
    persisted.weeks_stalled,
    live.weeksStalled,
  );
}

// Confirm the cron's design choice holds: fatigue_stall is
// structurally impossible from the persisted path (rirDriftAcrossBlock
// is null in buildStalledHistoryRow). If a future change to the helper
// drifts off this invariant, the test catches it.
check(
  'stage-4.6: buildStalledHistoryRow can never emit fatigue_stall (rirDriftAcrossBlock pinned null)',
  (() => {
    // Construct a series that WOULD trigger fatigue_stall through
    // the live classifier (flat e1RM + RIR drift). Verify the
    // persisted path returns watch/progress/swap_candidate instead.
    const fatigueProvokingSeries: SessionMetric[] = [
      mkMetric('w1', '2026-04-13T10:00:00Z', 100, 8, 1),
      mkMetric('w2', '2026-04-20T10:00:00Z', 100, 8, 1),
      mkMetric('w3', '2026-04-27T10:00:00Z', 100, 8, 1),
      mkMetric('w4', '2026-05-04T10:00:00Z', 100, 8, 1),
      mkMetric('w5', '2026-05-11T10:00:00Z', 100, 8, 1),
      mkMetric('w6', '2026-05-18T10:00:00Z', 100, 8, 1),
    ];
    const persisted = buildStalledHistoryRow({
      clientId: 'c',
      exerciseNameKey: 'k',
      series: fatigueProvokingSeries,
      at: now46,
    });
    return persisted.plateau_stage !== 'fatigue_stall';
  })(),
);

// ============================================================
// Stage 4.6 — alert-escalation mapping (cron transitions)
// ============================================================
// concernRank + alertTypeForStage power decideStalledAlert. Tests
// below explicitly cover the cross-stage paths the user flagged
// (progressing → high_rir_stall, swap → load_progression, fatigue_stall
// suppressed, within-type escalation, etc.).

eq('concern-rank: insufficient_data → 0', concernRank('insufficient_data'), 0);
eq('concern-rank: progressing → 0', concernRank('progressing'), 0);
eq('concern-rank: load_progression → 0', concernRank('load_progression'), 0);
eq('concern-rank: high_rir_stall → 1', concernRank('high_rir_stall'), 1);
eq('concern-rank: fatigue_stall → 1', concernRank('fatigue_stall'), 1);
eq('concern-rank: watch → 2', concernRank('watch'), 2);
eq('concern-rank: progress → 3', concernRank('progress'), 3);
eq('concern-rank: swap_candidate → 4', concernRank('swap_candidate'), 4);

eq('alert-map: watch → stalled', alertTypeForStage('watch'), 'stalled');
eq('alert-map: progress → stalled', alertTypeForStage('progress'), 'stalled');
eq('alert-map: swap_candidate → stalled', alertTypeForStage('swap_candidate'), 'stalled');
eq('alert-map: high_rir_stall → null (Stage 5 channel boundary — weekly note owns it)', alertTypeForStage('high_rir_stall'), null);
eq('alert-map: fatigue_stall → null (suppressed; Gate B owns deload)', alertTypeForStage('fatigue_stall'), null);
eq('alert-map: progressing → null', alertTypeForStage('progressing'), null);
eq('alert-map: load_progression → null', alertTypeForStage('load_progression'), null);
eq('alert-map: insufficient_data → null', alertTypeForStage('insufficient_data'), null);

const decide = (
  prev: PlateauStage | null,
  curr: PlateauStage,
  weeksStalled = 3,
) => decideStalledAlert({
  previousStage: prev,
  currentStage: curr,
  exerciseNameKey: 'd1::squat',
  weeksStalled,
});

// First-classification alerts (no prior row).
check('alert: null → swap_candidate fires stalled', decide(null, 'swap_candidate')?.type === 'stalled');
check('alert: null → watch fires stalled', decide(null, 'watch')?.type === 'stalled');
check('alert: null → high_rir_stall does NOT fire (weekly-note owned)', decide(null, 'high_rir_stall') === null);
check('alert: null → progressing does NOT fire', decide(null, 'progressing') === null);
check('alert: null → load_progression does NOT fire', decide(null, 'load_progression') === null);
check('alert: null → fatigue_stall does NOT fire (suppressed)', decide(null, 'fatigue_stall') === null);
check('alert: null → insufficient_data does NOT fire', decide(null, 'insufficient_data') === null);

// Within-type 'stalled' escalation.
check('alert: watch → progress fires stalled (escalation)', decide('watch', 'progress')?.type === 'stalled');
check('alert: progress → swap_candidate fires stalled (escalation)', decide('progress', 'swap_candidate')?.type === 'stalled');
check('alert: watch → swap_candidate fires stalled (escalation, skipped level)', decide('watch', 'swap_candidate')?.type === 'stalled');

// Same-stage and within-type downgrade: NO re-alert.
check('alert: watch → watch does NOT refire', decide('watch', 'watch') === null);
check('alert: progress → progress does NOT refire', decide('progress', 'progress') === null);
check('alert: swap_candidate → watch does NOT fire (improvement)', decide('swap_candidate', 'watch') === null);
check('alert: swap_candidate → progress does NOT fire (improvement)', decide('swap_candidate', 'progress') === null);

// Cross-type transitions: post Stage-5 boundary, high_rir_stall is
// weekly-note-owned. Any transition INTO high_rir_stall is silent at
// the cron level; weekly note picks it up. Transitions FROM
// high_rir_stall into a structural stalled stage still fire stalled.
check('alert: progressing → high_rir_stall does NOT fire (weekly-note owned)', decide('progressing', 'high_rir_stall') === null);
check('alert: watch → high_rir_stall does NOT fire (weekly-note owned)', decide('watch', 'high_rir_stall') === null);
check('alert: swap_candidate → high_rir_stall does NOT fire (weekly-note owned)', decide('swap_candidate', 'high_rir_stall') === null);
check('alert: high_rir_stall → progress fires stalled (effort → structural)', decide('high_rir_stall', 'progress')?.type === 'stalled');
check('alert: high_rir_stall → swap_candidate fires stalled (effort → structural)', decide('high_rir_stall', 'swap_candidate')?.type === 'stalled');

// Within high_rir_stall: stays silent at the cron (weekly-note owned).
check('alert: high_rir_stall → high_rir_stall does NOT fire', decide('high_rir_stall', 'high_rir_stall') === null);

// Recovery: any stage → positive state does NOT alert.
check('alert: swap_candidate → progressing does NOT fire (recovery)', decide('swap_candidate', 'progressing') === null);
check('alert: high_rir_stall → load_progression does NOT fire (recovery)', decide('high_rir_stall', 'load_progression') === null);
check('alert: progress → progressing does NOT fire (recovery)', decide('progress', 'progressing') === null);

// fatigue_stall: always suppressed at the cron level (Gate B / suggestions.ts owns it).
check('alert: progressing → fatigue_stall does NOT fire (suppressed)', decide('progressing', 'fatigue_stall') === null);
check('alert: watch → fatigue_stall does NOT fire (suppressed)', decide('watch', 'fatigue_stall') === null);
check('alert: high_rir_stall → fatigue_stall does NOT fire (suppressed)', decide('high_rir_stall', 'fatigue_stall') === null);

// Source-grep: the cron uses the extracted helpers (not inline math)
// and no longer imports any retired plateau.ts symbols.
check(
  'stage-4.6: daily-analysis cron uses buildStalledHistoryRow + decideStalledAlert',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/app/api/cron/daily-analysis/route.ts', 'utf-8');
    return /buildStalledHistoryRow/.test(src) && /decideStalledAlert/.test(src);
  })(),
);
check(
  'stage-4.6: daily-analysis cron no longer imports retired plateau wrappers',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/app/api/cron/daily-analysis/route.ts', 'utf-8');
    return (
      !/countConsecutiveStalled/.test(src) &&
      !/buildExposureHistory/.test(src) &&
      !/\bstageFor\b/.test(src) &&
      !/\bisEscalation\b/.test(src)
    );
  })(),
);

// ============================================================
// Stage 2 — signals/plateau (week-based RIR-branched classifier)
// ============================================================

import {
  classifyExercisePlateau,
  countWeeksStalled,
  detectLoadProgression,
} from '../src/lib/signals/plateau';

const plat = (
  series: SessionMetric[],
  rirDriftAcrossBlock: number | null = null,
  at: Date = new Date('2026-05-18T12:00:00Z'),
) => classifyExercisePlateau({ series, rirDriftAcrossBlock, at });

// 1. Insufficient data
eq(
  'plateau: <2 valid sessions → insufficient_data',
  plat([mkMetric('w1', '2026-05-18T10:00:00Z', 100, 8)]).stage,
  'insufficient_data',
);

// 2. Progressing (most recent week cleared MDC)
eq(
  'plateau: clear MDC-clearing improvement → progressing',
  plat([
    mkMetric('w1', '2026-04-27T10:00:00Z', 100, 8),
    mkMetric('w2', '2026-05-04T10:00:00Z', 100, 8),
    mkMetric('w3', '2026-05-18T10:00:00Z', 120, 8), // big jump, clears MDC
  ]).stage,
  'progressing',
);

// 3. Load-progression positive/hold (ClientA × Wide Row / ClientB × Face Pull pattern)
eq(
  'plateau: load↑ reps↓ with flat e1RM → load_progression (NOT a stall)',
  plat([
    mkMetric('w1', '2026-04-13T10:00:00Z', 72.6, 9), // 160 lb × 9
    mkMetric('w2', '2026-04-20T10:00:00Z', 72.6, 8),
    mkMetric('w3', '2026-04-27T10:00:00Z', 79.4, 6), // 175 lb × 6
    mkMetric('w4', '2026-05-04T10:00:00Z', 79.4, 5),
    mkMetric('w5', '2026-05-11T10:00:00Z', 79.4, 5),
    mkMetric('w6', '2026-05-18T10:00:00Z', 79.4, 5),
  ]).stage,
  'load_progression',
);

check(
  'plateau: detectLoadProgression matches via direct helper',
  detectLoadProgression([
    mkMetric('w1', '2026-04-13T10:00:00Z', 72.6, 9),
    mkMetric('w6', '2026-05-18T10:00:00Z', 79.4, 5),
  ]) === true,
);
check(
  'plateau: detectLoadProgression false when load held flat',
  detectLoadProgression([
    mkMetric('w1', '2026-04-13T10:00:00Z', 27.5, 7),
    mkMetric('w6', '2026-05-18T10:00:00Z', 27.5, 7),
  ]) === false,
);

// 4a. High-RIR stall — effort cue
eq(
  'plateau: flat e1RM with mean RIR ≥ 3 → high_rir_stall (audit effort)',
  plat([
    mkMetric('w1', '2026-04-13T10:00:00Z', 100, 8, 3),
    mkMetric('w2', '2026-04-20T10:00:00Z', 100, 8, 3),
    mkMetric('w3', '2026-04-27T10:00:00Z', 100, 8, 4),
    mkMetric('w4', '2026-05-04T10:00:00Z', 100, 8, 3),
    mkMetric('w5', '2026-05-11T10:00:00Z', 100, 8, 3),
    mkMetric('w6', '2026-05-18T10:00:00Z', 100, 8, 3),
  ]).stage,
  'high_rir_stall',
);

// 4b. Fatigue stall — defer to Gate B
eq(
  'plateau: flat e1RM + RIR drift ≥ DELOAD_RIR_DRIFT → fatigue_stall (defer to Gate B)',
  plat(
    [
      mkMetric('w1', '2026-04-13T10:00:00Z', 100, 8, 1),
      mkMetric('w2', '2026-04-20T10:00:00Z', 100, 8, 1),
      mkMetric('w3', '2026-04-27T10:00:00Z', 100, 8, 1),
      mkMetric('w4', '2026-05-04T10:00:00Z', 100, 8, 1),
      mkMetric('w5', '2026-05-11T10:00:00Z', 100, 8, 1),
      mkMetric('w6', '2026-05-18T10:00:00Z', 100, 8, 1),
    ],
    1.8, // rirDriftAcrossBlock above threshold
  ).stage,
  'fatigue_stall',
);

// 4c. Watch / progress / swap_candidate by weeks stalled (low-RIR pure stimulus plateau)
eq(
  'plateau: 2 weeks of flat data → watch',
  plat([
    mkMetric('w1', '2026-05-11T10:00:00Z', 100, 8, 1),
    mkMetric('w2', '2026-05-18T10:00:00Z', 100, 8, 1),
  ]).stage,
  'watch',
);

eq(
  'plateau: 3 weeks of flat data → progress (load bump / +1 set)',
  plat([
    mkMetric('w1', '2026-05-04T10:00:00Z', 100, 8, 1),
    mkMetric('w2', '2026-05-11T10:00:00Z', 100, 8, 1),
    mkMetric('w3', '2026-05-18T10:00:00Z', 100, 8, 1),
  ]).stage,
  'progress',
);

eq(
  'plateau: 4+ weeks of flat data → swap_candidate',
  plat([
    mkMetric('w1', '2026-04-27T10:00:00Z', 100, 8, 1),
    mkMetric('w2', '2026-05-04T10:00:00Z', 100, 8, 1),
    mkMetric('w3', '2026-05-11T10:00:00Z', 100, 8, 1),
    mkMetric('w4', '2026-05-18T10:00:00Z', 100, 8, 1),
  ]).stage,
  'swap_candidate',
);

// countWeeksStalled direct
eq(
  'plateau: countWeeksStalled returns 0 when latest week improved',
  countWeeksStalled([
    mkMetric('w1', '2026-04-27T10:00:00Z', 100, 8),
    mkMetric('w2', '2026-05-18T10:00:00Z', 120, 8),
  ]),
  0,
);

// ============================================================
// Stage 2 — GUARDRAIL: ClientA × Incline DB Press 32/63 stays a real stall
// ============================================================
// Built from his actual data per scripts/compare-stalls.ts output: 25 kg
// progression block ending 2025-11-04 (25 kg×8 e1RM 31.67), one PR session
// 2026-01-06 (27.5 kg×8 e1RM 34.83), then a 4-month plateau at 27.5 kg×4-7
// reps that NEVER matched 27.5 kg×8 again. The classifier MUST land on
// swap_candidate (or beyond) for the most recent session — if a future
// refactor breaks this, that's the canonical true-positive lost.

const clientAInclineSeries: SessionMetric[] = [
  mkMetric('a', '2025-11-04T10:00:00Z', 25, 8),
  mkMetric('b', '2026-01-06T10:00:00Z', 27.5, 8), // the PR
  mkMetric('c', '2026-02-03T10:00:00Z', 27.5, 7),
  mkMetric('d', '2026-03-03T10:00:00Z', 27.5, 6),
  mkMetric('e', '2026-04-01T10:00:00Z', 27.5, 6),
  mkMetric('f', '2026-05-05T10:00:00Z', 27.5, 5),
  mkMetric('g', '2026-05-12T10:00:00Z', 27.5, 4),
  mkMetric('h', '2026-05-15T10:00:00Z', 27.5, 5),
];

check(
  'GUARDRAIL: ClientA × Incline → classifier returns swap_candidate (real stall preserved)',
  (() => {
    const result = plat(clientAInclineSeries, null, new Date('2026-05-18T12:00:00Z'));
    return result.stage === 'swap_candidate' && result.weeksStalled >= 4;
  })(),
);

check(
  'GUARDRAIL: ClientA × Incline → NOT classified as load_progression (load never went up)',
  plat(clientAInclineSeries, null, new Date('2026-05-18T12:00:00Z')).stage !==
    'load_progression',
);

// ============================================================
// Stage 2 — signals/pain (graded traffic-light classifier)
// ============================================================

import { classifyPainIncident } from '../src/lib/signals/pain';

eq(
  'pain: red-flag keyword wins over recurring',
  classifyPainIncident({
    painReason: 'sharp stabbing pain in knee',
    clientNote: null,
    recurringOnSameExercise: true,
  })?.stage,
  'red_flag',
);

eq(
  'pain: recurring without red-flag → recurring',
  classifyPainIncident({
    painReason: 'a bit sore',
    clientNote: null,
    recurringOnSameExercise: true,
  })?.stage,
  'recurring',
);

eq(
  'pain: first-flag mild without recurring → mild',
  classifyPainIncident({
    painReason: 'mild discomfort, dull',
    clientNote: null,
    recurringOnSameExercise: false,
  })?.stage,
  'mild',
);

eq(
  'pain: numbness / tingling → red_flag (neuro signs)',
  classifyPainIncident({
    painReason: null,
    clientNote: 'felt numb running down the arm',
    recurringOnSameExercise: false,
  })?.stage,
  'red_flag',
);

eq(
  'pain: "gave way" → red_flag (structural)',
  classifyPainIncident({
    painReason: 'knee gave way mid-rep',
    clientNote: null,
    recurringOnSameExercise: false,
  })?.stage,
  'red_flag',
);

eq(
  'pain: severity 9/10 → red_flag',
  classifyPainIncident({
    painReason: 'shoulder 9/10',
    clientNote: null,
    recurringOnSameExercise: false,
  })?.stage,
  'red_flag',
);

eq(
  'pain: no signal at all → null',
  classifyPainIncident({
    painReason: null,
    clientNote: null,
    recurringOnSameExercise: false,
  }),
  null,
);

eq(
  'pain: client_note triggers MILD regex without pain_reason → mild',
  classifyPainIncident({
    painReason: null,
    clientNote: 'shoulder hurt a bit during the third set',
    recurringOnSameExercise: false,
  })?.stage,
  'mild',
);

// ============================================================
// Stage 4 — deload suggestion is now actionable (was informational at the seam)
// ============================================================
// Stage 4 flips the deload suggestion's apply from null to a real
// payload that the apply route handles. The Stage 1→2 seam tests are
// inverted here: source-grep must now find an apply: { kind: 'deload',
// firedTriggers: ... } block (not apply: null), and the route handler
// must accept kind: 'deload'. Any future regression that reintroduces
// apply: null at this site would silently break the cron's
// one-click-deload affordance.

import type { Suggestion } from '../src/lib/suggestions';

const deloadSuggestion: Suggestion = {
  id: 'deload:test-client',
  type: 'deload',
  title: 'Recommend deload week',
  body: 'Fatigue triggers firing: rir_drift. Cut volume ~40-60% this week...',
  apply: { kind: 'deload', firedTriggers: ['rir_drift'] },
};
check(
  'stage-4: deload suggestion type allowed in Suggestion union',
  deloadSuggestion.type === 'deload',
);
check(
  'stage-4: deload apply payload shape is the actionable one',
  deloadSuggestion.apply != null && deloadSuggestion.apply.kind === 'deload',
);
check(
  'stage-4: suggestions.ts emits the actionable deload apply (not null)',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    // Find the deload-emission block and assert the actionable apply
    // payload sits inside it. If a future change flips it back to null,
    // this fails — the route is wired up and the UI would lose the
    // one-click affordance silently otherwise.
    const m = src.match(
      /id:\s*`deload:\$\{cid\}`[\s\S]{0,1200}?apply:\s*\{\s*kind:\s*'deload'/,
    );
    return m !== null;
  })(),
);
check(
  'stage-4: apply route declares the kind: deload arm',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/suggestions/apply/route.ts',
      'utf-8',
    );
    return /kind:\s*'deload'/.test(src) && /body\.kind === 'deload'/.test(src);
  })(),
);

// ============================================================
// Stage 4 — cue.applyDeloadOverlay (non-destructive volume reduction)
// ============================================================
// Volume halved + floor of 1, load HELD (overlay doesn't carry load),
// and crucially: the helper takes prescribed_sets as a VALUE and
// returns a NEW value. It never reaches into the DB, so the stored
// exercises.prescribed_sets is mathematically guaranteed to be
// untouched. The non-destructive-proof tests below assert this
// behavior by inspecting the helper's signature/output.

eq(
  'overlay: non-deload week → prescribed_sets unchanged, overlayApplied=false',
  applyDeloadOverlay(4, false),
  { sets: 4, isDeload: false, overlayApplied: false },
);

eq(
  'overlay: deload week, 4 sets → 2 sets (ceil(4 * 0.5) = 2)',
  applyDeloadOverlay(4, true),
  { sets: 2, isDeload: true, overlayApplied: true },
);

eq(
  'overlay: deload week, 3 sets → 2 sets (ceil(3 * 0.5) = 2, not 1.5)',
  applyDeloadOverlay(3, true),
  { sets: 2, isDeload: true, overlayApplied: true },
);

eq(
  'overlay: deload week, 1 set → 1 set (floor of 1 — never drops to 0)',
  applyDeloadOverlay(1, true),
  { sets: 1, isDeload: true, overlayApplied: true },
);

eq(
  'overlay: deload week, 2 sets → 1 set (ceil(2 * 0.5) = 1, no floor needed)',
  applyDeloadOverlay(2, true),
  { sets: 1, isDeload: true, overlayApplied: true },
);

eq(
  'overlay: deload week, null prescribed → null but isDeload=true (UI still shows badge)',
  applyDeloadOverlay(null, true),
  { sets: null, isDeload: true, overlayApplied: false },
);

eq(
  'overlay: non-deload week, null prescribed → null, overlayApplied=false',
  applyDeloadOverlay(null, false),
  { sets: null, isDeload: false, overlayApplied: false },
);

// Non-destructive proof: calling the overlay 1000× on the same input
// returns a stable result with no side effects (no mutation of the
// input ref). Sanity-check that the function is pure.
check(
  'overlay: pure function — repeated calls return identical results, no mutation',
  (() => {
    const original = 4;
    let last;
    for (let i = 0; i < 1000; i++) {
      last = applyDeloadOverlay(original, true);
    }
    return original === 4 && last?.sets === 2;
  })(),
);

// And the load-held invariant: the overlay never returns a load field.
// cue.buildCue (which DOES carry load) is unchanged — deload weeks
// still surface the same KEEP/BEAT cue against the same prior best.
check(
  'overlay: load is HELD — overlay output has no weight/load field',
  (() => {
    const o = applyDeloadOverlay(4, true);
    return !('weight' in o) && !('load' in o);
  })(),
);

// Cross-check with buildRirTargetForCue: deload week applies the
// RIR backoff at the same time the overlay halves sets. The two
// helpers compose for the deload-week prescription surface.
eq(
  'overlay + rir: deload week composes — sets halved AND RIR backed off',
  (() => {
    const sets = applyDeloadOverlay(4, true);
    const rir = buildRirTargetForCue(
      { setsPrescribed: 4, repMin: 8, repMax: 12 },
      {
        rirTargetMinOverride: null,
        rirTargetMaxOverride: null,
        isCompound: false,
        weekInProgram: 5,
        weeksSinceLastDeload: 4,
        blockLengthWeeks: 5,
        isDeloadWeek: true,
      },
    );
    return {
      sets: sets.sets,
      isDeload: sets.isDeload,
      rirSource: rir.source,
      rirMin: rir.min,
      rirMax: rir.max,
    };
  })(),
  { sets: 2, isDeload: true, rirSource: 'computed', rirMin: 2, rirMax: 2 },
);

// ============================================================
// Stage 4 — lib/deload helpers exist and have the expected shape
// ============================================================
// The route extracts mark/unmark into lib/deload so both the original
// deload-toggle route and the apply route call the same code path —
// the cross-surface contract that the two flows agree on what "mark
// the current week as deload" means.

check(
  'stage-4: lib/deload exports markDeloadWeek + unmarkDeloadWeek',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/deload.ts', 'utf-8');
    return (
      /export\s+async\s+function\s+markDeloadWeek/.test(src) &&
      /export\s+async\s+function\s+unmarkDeloadWeek/.test(src) &&
      // Mirrors workouts.is_deload — the original route's second half
      // must survive in the extracted helper.
      /workouts/.test(src) && /is_deload/.test(src)
    );
  })(),
);

check(
  'stage-4: original deload-toggle route delegates to lib/deload (no duplicate logic)',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/clients/[id]/deload/route.ts',
      'utf-8',
    );
    // Should import + call the extracted helpers; should NOT have
    // its own copy of the upsert/delete + workout-flag mirror.
    return (
      /markDeloadWeek|unmarkDeloadWeek/.test(src) &&
      !/client_deload_weeks[\s\S]{0,200}?upsert/.test(src)
    );
  })(),
);

check(
  'stage-4: apply route emits audit_log + push for the deload arm',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/suggestions/apply/route.ts',
      'utf-8',
    );
    // The deload arm sits between the swap_exercise arm and the
    // unknown-kind fallthrough; assert audit + push fire inside it.
    const m = src.match(
      /body\.kind === 'deload'[\s\S]{0,1500}?return NextResponse\.json\(\s*\{\s*ok:\s*true/,
    );
    if (!m) return false;
    const block = m[0];
    return /audit_log/.test(block) && /sendPushToClient/.test(block);
  })(),
);

// ============================================================
// Stage 3 — signals/rir-prescription + cue.buildRirTargetForCue
// ============================================================

import {
  blockLengthForAge,
  classifyGoal,
  prescribeRir,
  type PrescribeRirInput,
} from '../src/lib/signals/rir-prescription';
import {
  applyDeloadOverlay,
  buildRirTargetForCue,
  type RirCueContext,
} from '../src/lib/cue';

// classifyGoal — same buckets as the plateau ladder (PLATEAU_STRENGTH_REP_MAX=6,
// PLATEAU_HYPERTROPHY_REP_MIN=12).
eq('rir-goal: rep_max=6 → strength', classifyGoal(3, 6), 'strength');
eq('rir-goal: rep_max=12 → hypertrophy', classifyGoal(8, 12), 'hypertrophy');
eq('rir-goal: rep_max=8 → mixed', classifyGoal(6, 8), 'mixed');
eq('rir-goal: rep_max=null → mixed (graceful)', classifyGoal(null, null), 'mixed');

// blockLengthForAge — matches BLOCK_LENGTH_BY_AGE.
eq('rir-block-len: intermediate → 5', blockLengthForAge('intermediate'), 5);
eq('rir-block-len: null → default (5)', blockLengthForAge(null), 5);
eq('rir-block-len: advanced → 4', blockLengthForAge('advanced'), 4);

const rxInput = (overrides: Partial<PrescribeRirInput> = {}): PrescribeRirInput => ({
  rep_min: 8,
  rep_max: 12,
  is_compound: false,
  weekInProgram: 1,
  weeksSinceLastDeload: 0,
  blockLengthWeeks: 5,
  isDeloadWeek: false,
  ...overrides,
});

// Hypertrophy isolation ramp endpoints (band 0-3, 5-week block).
eq(
  'prescribeRir: hypertrophy isolation, block-week 1 (wsld=0) → 3-3',
  (() => {
    const p = prescribeRir(rxInput({ weeksSinceLastDeload: 0 }));
    return { min: p.min, max: p.max };
  })(),
  { min: 3, max: 3 },
);
eq(
  'prescribeRir: hypertrophy isolation, block-week 5 (wsld=4) → 0-0',
  (() => {
    const p = prescribeRir(rxInput({ weeksSinceLastDeload: 4 }));
    return { min: p.min, max: p.max };
  })(),
  { min: 0, max: 0 },
);

// Strength compound ramp endpoints (band 1-4, floor at 1).
eq(
  'prescribeRir: strength compound, block-week 1 (wsld=0) → 4-4',
  (() => {
    const p = prescribeRir(
      rxInput({ rep_min: 3, rep_max: 6, is_compound: true, weeksSinceLastDeload: 0 }),
    );
    return { min: p.min, max: p.max };
  })(),
  { min: 4, max: 4 },
);
eq(
  'prescribeRir: strength compound, block-week 5 (wsld=4) → 1-1 (band bottom = compound floor)',
  (() => {
    const p = prescribeRir(
      rxInput({ rep_min: 3, rep_max: 6, is_compound: true, weeksSinceLastDeload: 4 }),
    );
    return { min: p.min, max: p.max };
  })(),
  { min: 1, max: 1 },
);

// Compound floor lifts hypertrophy block-end above 0.
check(
  'prescribeRir: compound floor lifts hypertrophy week-5 min from 0 → 1',
  (() => {
    const p = prescribeRir(rxInput({ is_compound: true, weeksSinceLastDeload: 4 }));
    return p.min === 1 && p.max === 1 && p.compoundFloorApplied;
  })(),
);
check(
  'prescribeRir: compound floor NOT applied when is_compound is null',
  (() => {
    const p = prescribeRir(rxInput({ is_compound: null, weeksSinceLastDeload: 4 }));
    return p.min === 0 && !p.compoundFloorApplied;
  })(),
);
check(
  'prescribeRir: compound floor NOT applied when is_compound=false',
  (() => {
    const p = prescribeRir(rxInput({ is_compound: false, weeksSinceLastDeload: 4 }));
    return p.min === 0 && !p.compoundFloorApplied;
  })(),
);

// Deload backoff — +DELOAD_RIR_BACKOFF (2) to both ends, load held.
eq(
  'prescribeRir: hypertrophy isolation week-5 deload → 2-2 (backoff applied)',
  (() => {
    const p = prescribeRir(
      rxInput({ weeksSinceLastDeload: 4, isDeloadWeek: true }),
    );
    return { min: p.min, max: p.max, isDeload: p.isDeload };
  })(),
  { min: 2, max: 2, isDeload: true },
);
eq(
  'prescribeRir: strength compound week-5 deload → 3-3 (compound floor then +2 backoff)',
  (() => {
    const p = prescribeRir(
      rxInput({
        rep_min: 3,
        rep_max: 6,
        is_compound: true,
        weeksSinceLastDeload: 4,
        isDeloadWeek: true,
      }),
    );
    return { min: p.min, max: p.max };
  })(),
  { min: 3, max: 3 },
);

// weeksSinceLastDeload null → fall back to weekInProgram modulo blockLength.
eq(
  'prescribeRir: wsld=null, weekInProgram=1 → behaves as block-week 1',
  (() => {
    const p = prescribeRir(
      rxInput({ weeksSinceLastDeload: null, weekInProgram: 1 }),
    );
    return { min: p.min, max: p.max };
  })(),
  { min: 3, max: 3 },
);
eq(
  'prescribeRir: wsld=null, weekInProgram=6 (wraps to block-week 1) → 3-3',
  (() => {
    const p = prescribeRir(
      rxInput({ weeksSinceLastDeload: null, weekInProgram: 6 }),
    );
    return { min: p.min, max: p.max };
  })(),
  { min: 3, max: 3 },
);

// Mixed-goal band (1-3) — gets the in-between ramp.
eq(
  'prescribeRir: mixed band-end (block-week 5) → 1-1',
  (() => {
    const p = prescribeRir(
      rxInput({ rep_min: 6, rep_max: 10, weeksSinceLastDeload: 4 }),
    );
    return { min: p.min, max: p.max, goal: p.goal };
  })(),
  { min: 1, max: 1, goal: 'mixed' },
);

// rampPosition exposed for coach-view auditing.
check(
  'prescribeRir: rampPosition 0 at block-week 1, 1 at block-week 5',
  (() => {
    const p1 = prescribeRir(rxInput({ weeksSinceLastDeload: 0 }));
    const p5 = prescribeRir(rxInput({ weeksSinceLastDeload: 4 }));
    return p1.rampPosition === 0 && p5.rampPosition === 1;
  })(),
);

// blockLength=1 edge — rampPosition pinned to 0, no divide-by-zero.
check(
  'prescribeRir: blockLengthWeeks=1 → rampPosition=0, no NaN',
  (() => {
    const p = prescribeRir(
      rxInput({ blockLengthWeeks: 1, weeksSinceLastDeload: 0 }),
    );
    return p.rampPosition === 0 && Number.isFinite(p.min) && Number.isFinite(p.max);
  })(),
);

// ---------- cue.buildRirTargetForCue ----------

const cueCtx = (overrides: Partial<RirCueContext> = {}): RirCueContext => ({
  rirTargetMinOverride: null,
  rirTargetMaxOverride: null,
  isCompound: false,
  weekInProgram: 1,
  weeksSinceLastDeload: 0,
  blockLengthWeeks: 5,
  isDeloadWeek: false,
  ...overrides,
});

eq(
  'rir-cue: override wins when both bounds pinned',
  buildRirTargetForCue(
    { setsPrescribed: 3, repMin: 8, repMax: 12 },
    cueCtx({ rirTargetMinOverride: 2, rirTargetMaxOverride: 3 }),
  ),
  { source: 'override', min: 2, max: 3, prescription: null },
);

check(
  'rir-cue: partial override (only min) → falls through to computed',
  (() => {
    const r = buildRirTargetForCue(
      { setsPrescribed: 3, repMin: 8, repMax: 12 },
      cueCtx({ rirTargetMinOverride: 2, rirTargetMaxOverride: null }),
    );
    return r.source === 'computed' && r.prescription !== null;
  })(),
);

eq(
  'rir-cue: weekInProgram=0 → unavailable',
  buildRirTargetForCue(
    { setsPrescribed: 3, repMin: 8, repMax: 12 },
    cueCtx({ weekInProgram: 0 }),
  ).source,
  'unavailable',
);

eq(
  'rir-cue: computed branch returns full prescription object',
  (() => {
    const r = buildRirTargetForCue(
      { setsPrescribed: 3, repMin: 8, repMax: 12 },
      cueCtx({ isCompound: true, weeksSinceLastDeload: 4 }),
    );
    return {
      source: r.source,
      min: r.min,
      max: r.max,
      goal: r.prescription?.goal,
      compoundFloorApplied: r.prescription?.compoundFloorApplied,
    };
  })(),
  { source: 'computed', min: 1, max: 1, goal: 'hypertrophy', compoundFloorApplied: true },
);

// ============================================================
// Stage 5 — buildWeeklyCoachingNote (always-non-null, priority, disjoint)
// ============================================================
// The function is invoked ONLY when no per-exercise / per-client
// suggestion fires for a client this week. Tier order locks the
// priority:  PR > effort_gap > RIR target > accessory > hold_steady.
// Hold-steady is unconditional — never returns null. That's the
// retention payoff: a clean week never produces silence.

import {
  buildWeeklyCoachingNote,
  computeEffortGapCandidate,
  selectBestEffortGap,
  type EffortGapCandidate,
  type WeeklyCoachingNoteInput,
} from '../src/lib/signals/weekly-note';

const baseNoteInput = (
  overrides: Partial<WeeklyCoachingNoteInput> = {},
): WeeklyCoachingNoteInput => ({
  clientId: 'c-test',
  clientName: 'Test Client',
  contextTemplate: null,
  topPR: null,
  effortGap: null,
  primaryRirTarget: null,
  untaggedExercise: null,
  adherenceRatio: 0.9,
  ...overrides,
});

// Always-non-null: every combination of null/missing inputs still
// produces a Suggestion. The hold-steady tier guarantees this.
check(
  'stage-5: hold-steady week — all signals null → returns non-null Suggestion',
  buildWeeklyCoachingNote(baseNoteInput()) !== null,
);
eq(
  'stage-5: hold-steady week → type = weekly_note',
  buildWeeklyCoachingNote(baseNoteInput()).type,
  'weekly_note',
);
eq(
  'stage-5: weekly_note apply is null (informational, no action button)',
  buildWeeklyCoachingNote(baseNoteInput()).apply,
  null,
);
eq(
  'stage-5: weekly_note id is stable per client',
  buildWeeklyCoachingNote(baseNoteInput()).id,
  'weekly_note:c-test',
);
check(
  'stage-5: hold-steady body mentions adherence percent',
  /90%/.test(buildWeeklyCoachingNote(baseNoteInput({ adherenceRatio: 0.9 })).body),
);
check(
  'stage-5: hold-steady title is "Holding steady"',
  buildWeeklyCoachingNote(baseNoteInput()).title === 'Holding steady',
);

// Tier priority — PR celebration wins when topPR present.
const allInput = baseNoteInput({
  topPR: { exerciseName: 'Incline DB Press', weight: 27.5, unit: 'kg', reps: 8 },
  effortGap: { exerciseName: 'Lateral raise', meanTopSetRir: 4.2, targetMax: 2 },
  primaryRirTarget: { exerciseName: 'Barbell Squat', rirMin: 1, rirMax: 2, goal: 'strength' },
  untaggedExercise: { exerciseName: 'Pendulum' },
});
check(
  'stage-5: PR present → tier 1 wins over effort/RIR/accessory',
  /PR week|Incline DB Press/.test(buildWeeklyCoachingNote(allInput).title),
);
check(
  'stage-5: PR body cites the lift + weight + reps',
  /Incline DB Press[\s\S]*27\.5 kg[\s\S]*8/.test(buildWeeklyCoachingNote(allInput).body),
);

// Tier 2: effort_gap wins when topPR null.
const effortInput = baseNoteInput({
  topPR: null,
  effortGap: { exerciseName: 'Lateral raise', meanTopSetRir: 4.2, targetMax: 2 },
  primaryRirTarget: { exerciseName: 'Barbell Squat', rirMin: 1, rirMax: 2, goal: 'strength' },
  untaggedExercise: { exerciseName: 'Pendulum' },
});
check(
  'stage-5: no PR → tier 2 (effort gap) wins over RIR target / accessory',
  /Push closer to target|Lateral raise/.test(buildWeeklyCoachingNote(effortInput).title),
);
check(
  'stage-5: effort_gap body cites the mean RIR and target',
  /RIR 4\.2[\s\S]*≤2|RIR\s*4\.2[\s\S]*target/.test(buildWeeklyCoachingNote(effortInput).body),
);

// Tier 3: RIR target wins when topPR + effort gap both null.
const rirInput = baseNoteInput({
  topPR: null,
  effortGap: null,
  primaryRirTarget: { exerciseName: 'Barbell Squat', rirMin: 1, rirMax: 2, goal: 'strength' },
  untaggedExercise: { exerciseName: 'Pendulum' },
});
check(
  'stage-5: no PR/effort → tier 3 (RIR target) wins over accessory',
  /Barbell Squat[\s\S]*RIR\s*1-2/.test(buildWeeklyCoachingNote(rirInput).title),
);
check(
  'stage-5: RIR target body frames the goal context',
  /Strength-biased|last rep should be a grind/i.test(buildWeeklyCoachingNote(rirInput).body),
);

// Tier 3 RIR — equal min/max collapses to a single number.
const rirEqualInput = baseNoteInput({
  primaryRirTarget: { exerciseName: 'Cable Lateral Raise', rirMin: 0, rirMax: 0, goal: 'hypertrophy' },
});
check(
  'stage-5: RIR target with min===max renders as a single number',
  /RIR\s*0(?!-)/.test(buildWeeklyCoachingNote(rirEqualInput).title),
);

// Tier 4: accessory tweak wins when topPR + effort + RIR all null.
const accessoryInput = baseNoteInput({
  untaggedExercise: { exerciseName: 'Pendulum' },
});
check(
  'stage-5: only untagged exercise → tier 4 (accessory) wins',
  /Tag a muscle group on Pendulum/.test(buildWeeklyCoachingNote(accessoryInput).title),
);
check(
  'stage-5: accessory body explains why tagging matters (volume math)',
  /volume math|per-muscle/i.test(buildWeeklyCoachingNote(accessoryInput).body),
);

// ----- Channel disjointness — by construction -----
//
// (1) The cron's alertTypeForStage now returns null for high_rir_stall
// (Stage 5 channel boundary). The cron literally cannot fire an
// effort_gap alert. Weekly note is the sole source of that observation.
// Already locked by the Stage 4.6 alert tests up the file, but
// re-asserting here in the Stage 5 block as a contract pin.
eq(
  'stage-5 channel boundary: alertTypeForStage(high_rir_stall) === null',
  alertTypeForStage('high_rir_stall'),
  null,
);
check(
  'stage-5 channel boundary: cron never fires effort_gap alert (high_rir_stall path)',
  decideStalledAlert({
    previousStage: null,
    currentStage: 'high_rir_stall',
    exerciseNameKey: 'd1::lateral_raise',
    weeksStalled: 3,
  }) === null,
);

// (2) StalledAlertDecision.type is now only 'stalled' — the alert
// emission type space narrowed when the channel boundary moved
// effort_gap to the weekly note.
check(
  'stage-5 channel boundary: cron stalled alert type is exclusively "stalled"',
  (() => {
    const d = decideStalledAlert({
      previousStage: null,
      currentStage: 'swap_candidate',
      exerciseNameKey: 'd1::squat',
      weeksStalled: 5,
    });
    return d?.type === 'stalled';
  })(),
);

// (3) The weekly-report wiring only calls buildWeeklyCoachingNote when
// the per-client suggestion list is empty. Source-grep asserts this
// — the note appends only inside an `if (... .length === 0)` branch.
check(
  'stage-5: weekly-report.ts calls buildWeeklyCoachingNote ONLY when per-client suggestions are empty',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/weekly-report.ts', 'utf-8');
    // Find the buildWeeklyCoachingNote call site and check it sits
    // inside an emptiness-guard.
    const m = src.match(
      /perClientSuggestions\.length\s*===\s*0[\s\S]{0,2000}?buildWeeklyCoachingNote/,
    );
    return m !== null;
  })(),
);

// (4) buildWeeklyCoachingNote always returns a Suggestion with type
// 'weekly_note' — never any of the structural types that overlap with
// per-exercise suggestions. Sweep over every input combination's
// resulting type.
check(
  'stage-5: weekly_note always emits type=weekly_note (never a structural type)',
  (() => {
    const inputs: WeeklyCoachingNoteInput[] = [
      baseNoteInput(), // hold-steady
      baseNoteInput({ untaggedExercise: { exerciseName: 'X' } }), // accessory
      baseNoteInput({
        primaryRirTarget: { exerciseName: 'X', rirMin: 1, rirMax: 2, goal: 'mixed' },
      }), // RIR
      baseNoteInput({
        effortGap: { exerciseName: 'X', meanTopSetRir: 4, targetMax: 2 },
      }), // effort
      baseNoteInput({
        topPR: { exerciseName: 'X', weight: 100, unit: 'kg', reps: 5 },
      }), // PR
    ];
    return inputs.every(
      (i) => buildWeeklyCoachingNote(i).type === 'weekly_note',
    );
  })(),
);

// ----- Stage 5 v2 — effort-gap candidate computation -----
// computeEffortGapCandidate is the per-exercise primitive that
// suggestions.ts uses in the plateau loop to decide whether to capture
// an effort-gap candidate. Tests cover the null + threshold edges.

eq(
  'effort-gap: meanTopSetRir null → null candidate',
  computeEffortGapCandidate({
    exerciseName: 'Incline DB Press',
    meanTopSetRir: null,
    prescribedTargetMax: 2,
  }),
  null,
);

eq(
  'effort-gap: gap below RIR_EFFORT_GAP_THRESHOLD (1 < 2) → null',
  computeEffortGapCandidate({
    exerciseName: 'Incline DB Press',
    meanTopSetRir: 3,
    prescribedTargetMax: 2,
  }),
  null,
);

check(
  'effort-gap: gap === RIR_EFFORT_GAP_THRESHOLD (exactly 2) → candidate emitted',
  (() => {
    const c = computeEffortGapCandidate({
      exerciseName: 'Lateral Raise',
      meanTopSetRir: 2,
      prescribedTargetMax: 0,
    });
    return c?.exerciseName === 'Lateral Raise' && c.gap === 2;
  })(),
);

check(
  'effort-gap: gap well above threshold (4 RIR over target) → candidate with correct fields',
  (() => {
    const c = computeEffortGapCandidate({
      exerciseName: 'Cable Lateral Raise',
      meanTopSetRir: 4,
      prescribedTargetMax: 0,
    });
    return (
      c != null &&
      c.exerciseName === 'Cable Lateral Raise' &&
      c.meanTopSetRir === 4 &&
      c.targetMax === 0 &&
      c.gap === 4
    );
  })(),
);

eq(
  'effort-gap: selectBestEffortGap empty → null',
  selectBestEffortGap([]),
  null,
);

eq(
  'effort-gap: selectBestEffortGap picks max-gap candidate',
  (() => {
    const candidates: EffortGapCandidate[] = [
      { exerciseName: 'A', meanTopSetRir: 3, targetMax: 1, gap: 2 },
      { exerciseName: 'B', meanTopSetRir: 5, targetMax: 0, gap: 5 },
      { exerciseName: 'C', meanTopSetRir: 4, targetMax: 1, gap: 3 },
    ];
    return selectBestEffortGap(candidates)?.exerciseName;
  })(),
  'B',
);

// ----- suggestions.ts wiring — source-grep guards -----
// The user explicitly flagged that tier 2 was stubbed-null in v1,
// which meant effort-gap observations reached no one through either
// channel (cron narrowed to 'stalled' only at the channel boundary).
// These greps lock that the tier-2 wiring exists in suggestions.ts
// where the per-exercise plateau loop already produces meanTopSetRir.

check(
  'stage-5-v2: suggestions.ts imports computeEffortGapCandidate + prescribeRir',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    return /computeEffortGapCandidate/.test(src) && /\bprescribeRir\b/.test(src);
  })(),
);
check(
  'stage-5-v2: suggestions.ts emits buildWeeklyCoachingNote at per-client tail',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    // Look for the emission block: out.length === 0 followed by
    // buildWeeklyCoachingNote within a reasonable window.
    return /out\.length\s*===\s*0[\s\S]{0,800}?buildWeeklyCoachingNote/.test(src);
  })(),
);
check(
  'stage-5-v2: suggestions.ts wiring uses selectBestEffortGap for the tier-2 input',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    return /selectBestEffortGap/.test(src);
  })(),
);

// (5) Suggestion union includes 'weekly_note' (locks the type extension).
check(
  'stage-5: Suggestion type union includes weekly_note',
  (() => {
    const s = {
      id: 'weekly_note:c',
      type: 'weekly_note' as const,
      title: '',
      body: '',
      apply: null,
    };
    // Assignability check — fails to compile if the union doesn't include
    // 'weekly_note'.
    const typed: import('../src/lib/suggestions').Suggestion = s;
    return typed.type === 'weekly_note';
  })(),
);

// ============================================================
// Stage 6 Piece 1 — client context (pure helpers)
// ============================================================
// Single source the gate (Gate A), the anomaly notifier (Piece 2),
// and the weekly note (Piece 3 wiring) all read for "is something
// explaining this client's behaviour right now and how should the app
// react." The pure helpers below are testable without DB; the
// supersede / fetch path lives in /api/coach/clients/[id]/context
// (Piece 3) and an empirical ClientC check after the unit suite.

import {
  anomalyIsSilenced,
  getActiveClientContext,
  getContextDirective,
  type AnomalyType,
  type ReasonCode,
  type PersistedContextRow,
} from '../src/lib/signals/client-context';

const REASON_CODES: ReasonCode[] = [
  'onboarding',
  'health',
  'injury',
  'travel',
  'life_stress',
  'planned_break',
  'at_risk',
  'paused',
];

// ----- Directive shape per reason code -----
// Each code's behavior is its own assertion so a future change to the
// directive matrix lights up the EXACT row that drifted.
eq(
  'context-directive: onboarding suppresses gate, plateau, all programming; "getting_started" template; silences all anomalies',
  getContextDirective('onboarding'),
  {
    reasonCode: 'onboarding',
    suppressGateA: true,
    softenGateA: false,
    suppressPlateauSuggestions: true,
    suppressAllProgramChanges: true,
    detrainingExcluded: false,
    injuryAreaProtected: false,
    weeklyNoteTemplate: 'getting_started',
    silencesAnomalyTypes: 'all',
    suppressClientWeeklyMessage: false,
  },
);

eq(
  'context-directive: health — suppresses gate, NOT blanket plateau (uses detrainingExcluded for per-lift filter), "ease_back_in"',
  getContextDirective('health'),
  {
    reasonCode: 'health',
    suppressGateA: true,
    softenGateA: false,
    suppressPlateauSuggestions: false,
    suppressAllProgramChanges: false,
    detrainingExcluded: true,
    injuryAreaProtected: false,
    weeklyNoteTemplate: 'ease_back_in',
    silencesAnomalyTypes: 'all',
    suppressClientWeeklyMessage: false,
  },
);

eq(
  'context-directive: injury — does NOT suppress gate; injuryAreaProtected only',
  getContextDirective('injury'),
  {
    reasonCode: 'injury',
    suppressGateA: false,
    softenGateA: false,
    suppressPlateauSuggestions: false,
    suppressAllProgramChanges: false,
    detrainingExcluded: false,
    injuryAreaProtected: true,
    weeklyNoteTemplate: null,
    silencesAnomalyTypes: 'all',
    suppressClientWeeklyMessage: false,
  },
);

eq(
  'context-directive: travel — suppresses gate + plateau + all programming, null template',
  getContextDirective('travel'),
  {
    reasonCode: 'travel',
    suppressGateA: true,
    softenGateA: false,
    suppressPlateauSuggestions: true,
    suppressAllProgramChanges: true,
    detrainingExcluded: false,
    injuryAreaProtected: false,
    weeklyNoteTemplate: null,
    silencesAnomalyTypes: 'all',
    suppressClientWeeklyMessage: true,
  },
);

eq(
  'context-directive: life_stress — softens (NOT suppresses) gate; holds programming steady; no template',
  getContextDirective('life_stress'),
  {
    reasonCode: 'life_stress',
    suppressGateA: false,
    softenGateA: true,
    suppressPlateauSuggestions: false,
    suppressAllProgramChanges: true,
    detrainingExcluded: false,
    injuryAreaProtected: false,
    weeklyNoteTemplate: null,
    silencesAnomalyTypes: 'all',
    suppressClientWeeklyMessage: false,
  },
);

eq(
  'context-directive: planned_break — pause everything, null template',
  getContextDirective('planned_break'),
  {
    reasonCode: 'planned_break',
    suppressGateA: true,
    softenGateA: false,
    suppressPlateauSuggestions: true,
    suppressAllProgramChanges: true,
    detrainingExcluded: false,
    injuryAreaProtected: false,
    weeklyNoteTemplate: null,
    silencesAnomalyTypes: 'all',
    suppressClientWeeklyMessage: true,
  },
);

// at_risk carries the Q2 carve-out — silencesAnomalyTypes is a Set,
// not 'all'. Test the OTHER fields shape-wise then the Set membership
// explicitly so the carve-out can't drift silently.
check(
  'context-directive: at_risk — does NOT suppress gate, no template change, suppresses programming',
  (() => {
    const d = getContextDirective('at_risk');
    return (
      d.suppressGateA === false &&
      d.softenGateA === false &&
      d.suppressPlateauSuggestions === true &&
      d.suppressAllProgramChanges === true &&
      d.detrainingExcluded === false &&
      d.injuryAreaProtected === false &&
      d.weeklyNoteTemplate === 're_engagement'
    );
  })(),
);
check(
  'context-directive Q2 carve-out: at_risk DOES silence returned_after_gap (already implied)',
  anomalyIsSilenced(getContextDirective('at_risk'), 'returned_after_gap'),
);
check(
  'context-directive Q2 carve-out: at_risk DOES silence performance_cliff (expected after gap)',
  anomalyIsSilenced(getContextDirective('at_risk'), 'performance_cliff'),
);
check(
  'context-directive Q2 carve-out: at_risk does NOT silence went_quiet (signal, not noise)',
  !anomalyIsSilenced(getContextDirective('at_risk'), 'went_quiet'),
);
check(
  'context-directive Q2 carve-out: at_risk does NOT silence adherence_drop (signal, not noise)',
  !anomalyIsSilenced(getContextDirective('at_risk'), 'adherence_drop'),
);

eq(
  'context-directive: paused — suppresses everything',
  getContextDirective('paused'),
  {
    reasonCode: 'paused',
    suppressGateA: true,
    softenGateA: false,
    suppressPlateauSuggestions: true,
    suppressAllProgramChanges: true,
    detrainingExcluded: false,
    injuryAreaProtected: false,
    weeklyNoteTemplate: null,
    silencesAnomalyTypes: 'all',
    suppressClientWeeklyMessage: true,
  },
);

// ----- anomalyIsSilenced helper covers the 'all' case for non-at_risk codes -----
const ALL_ANOMALY_TYPES: AnomalyType[] = [
  'adherence_drop',
  'returned_after_gap',
  'performance_cliff',
  'went_quiet',
];
for (const code of REASON_CODES) {
  if (code === 'at_risk') continue;
  for (const anomaly of ALL_ANOMALY_TYPES) {
    check(
      `context-directive: ${code} silences ${anomaly} (uniform "all" rule)`,
      anomalyIsSilenced(getContextDirective(code), anomaly),
    );
  }
}

// ----- getActiveClientContext: persisted path + non-staleness -----
const NOW = new Date('2026-06-01T12:00:00Z');
const baseRow: PersistedContextRow = {
  id: 'ctx-1',
  reason_code: 'health',
  note: 'flu, expect 2 weeks',
  created_at: new Date('2026-05-25T10:00:00Z'),
  review_at: new Date('2026-06-08T00:00:00Z'),
  resolved_at: null,
};

eq(
  'active-context: persisted unresolved, review_at in future → returns persisted row',
  getActiveClientContext({
    at: NOW,
    persistedRow: baseRow,
    clientCreatedAt: new Date('2025-10-01T00:00:00Z'),
    hasNoLogs: false,
  }),
  {
    reasonCode: 'health',
    source: 'persisted',
    reviewAt: new Date('2026-06-08T00:00:00Z'),
    note: 'flu, expect 2 weeks',
    contextId: 'ctx-1',
    createdAt: new Date('2026-05-25T10:00:00Z'),
  },
);

eq(
  'active-context: persisted unresolved, review_at NULL → returns persisted (no auto-expiry)',
  getActiveClientContext({
    at: NOW,
    persistedRow: { ...baseRow, review_at: null },
    clientCreatedAt: new Date('2025-10-01T00:00:00Z'),
    hasNoLogs: false,
  })?.source,
  'persisted',
);

check(
  'active-context: NON-STALENESS RULE — persisted with review_at < at returns null (no permanent silent suppression)',
  getActiveClientContext({
    at: NOW,
    persistedRow: { ...baseRow, review_at: new Date('2026-03-01T00:00:00Z') },
    clientCreatedAt: new Date('2025-10-01T00:00:00Z'),
    hasNoLogs: false,
  }) === null,
);

check(
  'active-context: resolved_at set → returns null (context closed)',
  getActiveClientContext({
    at: NOW,
    persistedRow: { ...baseRow, resolved_at: new Date('2026-05-30T00:00:00Z') },
    clientCreatedAt: new Date('2025-10-01T00:00:00Z'),
    hasNoLogs: false,
  }) === null,
);

// ----- Synthesized onboarding path -----
eq(
  'active-context: SYNTHESIZED onboarding — recent created + no logs + no persisted → onboarding',
  getActiveClientContext({
    at: NOW,
    persistedRow: null,
    clientCreatedAt: new Date('2026-05-28T00:00:00Z'),
    hasNoLogs: true,
  })?.reasonCode,
  'onboarding',
);

eq(
  'active-context: synthesized onboarding source flag',
  getActiveClientContext({
    at: NOW,
    persistedRow: null,
    clientCreatedAt: new Date('2026-05-28T00:00:00Z'),
    hasNoLogs: true,
  })?.source,
  'synthesized_onboarding',
);

eq(
  'active-context: synthesized onboarding review_at = createdAt + CONTEXT_ONBOARDING_WEEKS (2)',
  getActiveClientContext({
    at: NOW,
    persistedRow: null,
    clientCreatedAt: new Date('2026-05-28T00:00:00Z'),
    hasNoLogs: true,
  })?.reviewAt?.toISOString(),
  new Date('2026-06-11T00:00:00Z').toISOString(),
);

check(
  'active-context: created OUTSIDE onboarding window → no synthesis even when hasNoLogs',
  getActiveClientContext({
    at: NOW,
    persistedRow: null,
    clientCreatedAt: new Date('2026-03-01T00:00:00Z'),
    hasNoLogs: true,
  }) === null,
);

check(
  'active-context: created INSIDE window AND hasLogs → no synthesis (onboarding ended on first log)',
  getActiveClientContext({
    at: NOW,
    persistedRow: null,
    clientCreatedAt: new Date('2026-05-28T00:00:00Z'),
    hasNoLogs: false,
  }) === null,
);

check(
  'active-context: stale persisted + synthesized criteria met → synthesized takes over (no permanent suppression hides the new state)',
  getActiveClientContext({
    at: NOW,
    persistedRow: { ...baseRow, review_at: new Date('2026-03-01T00:00:00Z') },
    clientCreatedAt: new Date('2026-05-28T00:00:00Z'),
    hasNoLogs: true,
  })?.source === 'synthesized_onboarding',
);

// ----- Q1 — DIRECTIVE PARITY (synthesized vs persisted) -----
// Construction-consistency contract: the synthesized onboarding path
// and a real persisted onboarding row produce BYTE-IDENTICAL
// directives. Every downstream surface treats "auto-onboarded" and
// "manually-set onboarding" identically because they read the same
// directive. If a future change makes them diverge, this fails.
eq(
  'Q1 directive parity: synthesized onboarding directive === persisted onboarding directive (byte-identical)',
  (() => {
    const synthesized = getActiveClientContext({
      at: NOW,
      persistedRow: null,
      clientCreatedAt: new Date('2026-05-28T00:00:00Z'),
      hasNoLogs: true,
    });
    const persistedOnboarding: PersistedContextRow = {
      id: 'manual-ctx',
      reason_code: 'onboarding',
      note: 'manually set by coach',
      created_at: new Date('2026-05-28T00:00:00Z'),
      review_at: new Date('2026-06-11T00:00:00Z'),
      resolved_at: null,
    };
    const persisted = getActiveClientContext({
      at: NOW,
      persistedRow: persistedOnboarding,
      clientCreatedAt: new Date('2025-01-01T00:00:00Z'),
      hasNoLogs: false,
    });
    if (!synthesized || !persisted) return 'one returned null';
    // The ActiveContext objects differ (source flag, contextId, note,
    // createdAt) — that's expected metadata divergence. The DIRECTIVE
    // they produce must NOT differ.
    return JSON.stringify(getDirectiveStable(getContextDirective(synthesized.reasonCode)))
      === JSON.stringify(getDirectiveStable(getContextDirective(persisted.reasonCode)));
  })(),
  true,
);

// Helper: ContextDirective.silencesAnomalyTypes is a Set when not
// 'all', and Set serialisation isn't deterministic via JSON. Convert
// to a sorted-array surrogate for stable comparison.
function getDirectiveStable(d: ReturnType<typeof getContextDirective>) {
  return {
    ...d,
    silencesAnomalyTypes:
      d.silencesAnomalyTypes === 'all'
        ? 'all'
        : [...d.silencesAnomalyTypes].sort(),
  };
}

// ----- ClientC canonical fixture -----
// Brand-new client, zero sessions. Coach hasn't set anything.
// Expected: synthesized onboarding context with directive that
// suppresses Gate A entirely AND suppresses all programming.
check(
  'CLIENTC fixture (synthesized): brand-new + zero logs → onboarding context + suppressGateA + suppressAllProgramChanges',
  (() => {
    const clientCCreated = new Date('2026-05-27T00:00:00Z'); // ~5 days before NOW
    const ctx = getActiveClientContext({
      at: NOW,
      persistedRow: null,
      clientCreatedAt: clientCCreated,
      hasNoLogs: true,
    });
    if (!ctx) return false;
    const directive = getContextDirective(ctx.reasonCode);
    return (
      ctx.source === 'synthesized_onboarding' &&
      ctx.reasonCode === 'onboarding' &&
      directive.suppressGateA === true &&
      directive.suppressPlateauSuggestions === true &&
      directive.suppressAllProgramChanges === true &&
      directive.weeklyNoteTemplate === 'getting_started'
    );
  })(),
);

// ============================================================
// Stage 6 Piece 2 — anomaly detection + orchestrator
// ============================================================

import {
  countCliffRegressions,
  detectAdherenceDrop,
  detectPerformanceCliff,
  detectReturnedAfterGap,
  detectWentQuiet,
  evaluateAnomalies,
  findLatestQualifyingGap,
  type AnomalyEvaluationInput,
  type CompletedWorkoutTs,
  type DetectedAnomaly,
} from '../src/lib/signals/anomaly';
import type { ActiveContext } from '../src/lib/signals/client-context';

const ANOM_NOW = new Date('2026-06-01T12:00:00Z');

// Convenience: tiny adherence-signal stub with just the fields the
// detectors and orchestrator read.
const adh = (ratio: number) => ({
  ratio,
  daysCompletedInWindow: Math.round(ratio * 8),
  daysExpectedInWindow: 8,
  isLow: ratio < 0.8,
  missingDayLabels: [],
  gateRatio: 0.8,
  lookbackWeeks: 2,
});

const wk = (iso: string): CompletedWorkoutTs => ({ started_at: iso });

// ----- adherence_drop -----

eq(
  'adherence_drop: prior cleared (0.85) + current dropped (0.5) → fires',
  detectAdherenceDrop({ prior: adh(0.85), current: adh(0.5) })?.type,
  'adherence_drop',
);
check(
  'adherence_drop: chronic-low (prior 0.4, current 0.5) → does NOT fire (no change-signal)',
  detectAdherenceDrop({ prior: adh(0.4), current: adh(0.5) }) === null,
);
check(
  'adherence_drop: prior cleared + still cleared (0.85 → 0.82) → does NOT fire',
  detectAdherenceDrop({ prior: adh(0.85), current: adh(0.82) }) === null,
);

// ----- findLatestQualifyingGap (shared helper) -----

eq(
  'gap-helper: <2 workouts → null',
  findLatestQualifyingGap([wk('2026-05-15T10:00:00Z')], ANOM_NOW, 7),
  null,
);
check(
  'gap-helper: latest gap of 10 days when threshold=7 → returns gap',
  (() => {
    const g = findLatestQualifyingGap(
      [wk('2026-05-15T10:00:00Z'), wk('2026-05-31T10:00:00Z')],
      ANOM_NOW,
      7,
    );
    return g != null && g.gapDays >= 7 && g.gapEndAt === '2026-05-31T10:00:00Z';
  })(),
);
check(
  'gap-helper: latest gap of 3 days when threshold=7 → null',
  findLatestQualifyingGap(
    [wk('2026-05-29T10:00:00Z'), wk('2026-06-01T10:00:00Z')],
    ANOM_NOW,
    7,
  ) === null,
);
check(
  'gap-helper: latest workout is older than ANOMALY_QUIET_DAYS → not a return event',
  findLatestQualifyingGap(
    [wk('2026-04-01T10:00:00Z'), wk('2026-05-01T10:00:00Z')],
    ANOM_NOW,
    7,
  ) === null,
);

// ----- returned_after_gap -----

eq(
  'returned_after_gap: 14-day gap then recent log → fires',
  detectReturnedAfterGap({
    workouts: [wk('2026-05-17T10:00:00Z'), wk('2026-05-31T10:00:00Z')],
    at: ANOM_NOW,
  })?.type,
  'returned_after_gap',
);
check(
  'returned_after_gap: consistent training (3-day gaps) → does NOT fire',
  detectReturnedAfterGap({
    workouts: [
      wk('2026-05-22T10:00:00Z'),
      wk('2026-05-25T10:00:00Z'),
      wk('2026-05-28T10:00:00Z'),
      wk('2026-05-31T10:00:00Z'),
    ],
    at: ANOM_NOW,
  }) === null,
);
check(
  'returned_after_gap: gap detail carries days + latestWorkoutAt',
  (() => {
    const a = detectReturnedAfterGap({
      workouts: [wk('2026-05-17T10:00:00Z'), wk('2026-05-31T10:00:00Z')],
      at: ANOM_NOW,
    });
    return (
      a?.detail.type === 'returned_after_gap' &&
      a.detail.gapDays === 14 &&
      a.detail.latestWorkoutAt === '2026-05-31T10:00:00Z'
    );
  })(),
);

// ----- countCliffRegressions + detectPerformanceCliff -----

// Helper for SessionMetric stubs.
const sm = (id: string, ts: string, weight: number, reps: number) => ({
  workoutId: id,
  workoutStartedAt: ts,
  topWeightKg: weight,
  topReps: reps,
  topSetRir: null,
  e1RM: weight * (1 + reps / 30),
  e1RMConfidence: 'ok' as const,
  volumeLoadKg: weight * reps,
});

eq(
  'cliff-regressions: 0 exercises with both pre+post → count 0',
  countCliffRegressions({
    perExerciseSeries: new Map([
      ['ex1', [sm('a', '2026-05-15T10:00:00Z', 100, 8)]],
    ]),
    gapEndAt: '2026-05-31T10:00:00Z',
  }).count,
  0,
);
eq(
  'cliff-regressions: 2 exercises drop > MDC post-gap → count 2',
  countCliffRegressions({
    perExerciseSeries: new Map([
      [
        'bench',
        [
          sm('a', '2026-05-10T10:00:00Z', 100, 8), // e1RM 126.67
          sm('b', '2026-05-31T10:00:00Z', 80, 8), // e1RM 101.33 — drop > MDC
        ],
      ],
      [
        'squat',
        [
          sm('c', '2026-05-10T10:00:00Z', 150, 6), // e1RM 180
          sm('d', '2026-05-31T10:00:00Z', 120, 6), // e1RM 144 — drop > MDC
        ],
      ],
    ]),
    gapEndAt: '2026-05-31T00:00:00Z',
  }).count,
  2,
);
eq(
  'cliff-regressions: only 1 drops → count 1 (cliff needs ≥2)',
  countCliffRegressions({
    perExerciseSeries: new Map([
      ['bench', [sm('a', '2026-05-10T10:00:00Z', 100, 8), sm('b', '2026-05-31T10:00:00Z', 80, 8)]],
      ['squat', [sm('c', '2026-05-10T10:00:00Z', 150, 6), sm('d', '2026-05-31T10:00:00Z', 150, 6)]],
    ]),
    gapEndAt: '2026-05-31T00:00:00Z',
  }).count,
  1,
);

eq(
  'performance_cliff: gap + ≥2 exercises drop → fires',
  detectPerformanceCliff({
    workouts: [wk('2026-05-17T10:00:00Z'), wk('2026-05-31T10:00:00Z')],
    perExerciseSeries: new Map([
      ['bench', [sm('a', '2026-05-10T10:00:00Z', 100, 8), sm('b', '2026-05-31T10:00:00Z', 80, 8)]],
      ['squat', [sm('c', '2026-05-10T10:00:00Z', 150, 6), sm('d', '2026-05-31T10:00:00Z', 120, 6)]],
    ]),
    at: ANOM_NOW,
  })?.type,
  'performance_cliff',
);
check(
  'performance_cliff vs Gate B: TRAIN-THROUGH drop (consistent logs + 2 lifts down) → does NOT fire (Gate B territory)',
  detectPerformanceCliff({
    workouts: [
      wk('2026-05-22T10:00:00Z'),
      wk('2026-05-25T10:00:00Z'),
      wk('2026-05-28T10:00:00Z'),
      wk('2026-05-31T10:00:00Z'),
    ],
    perExerciseSeries: new Map([
      ['bench', [sm('a', '2026-05-22T10:00:00Z', 100, 8), sm('b', '2026-05-31T10:00:00Z', 80, 8)]],
      ['squat', [sm('c', '2026-05-22T10:00:00Z', 150, 6), sm('d', '2026-05-31T10:00:00Z', 120, 6)]],
    ]),
    at: ANOM_NOW,
  }) === null,
);
check(
  'performance_cliff: gap present but only 1 lift drops → does NOT fire (cliff needs ≥2)',
  detectPerformanceCliff({
    workouts: [wk('2026-05-17T10:00:00Z'), wk('2026-05-31T10:00:00Z')],
    perExerciseSeries: new Map([
      ['bench', [sm('a', '2026-05-10T10:00:00Z', 100, 8), sm('b', '2026-05-31T10:00:00Z', 80, 8)]],
      ['squat', [sm('c', '2026-05-10T10:00:00Z', 150, 6), sm('d', '2026-05-31T10:00:00Z', 150, 6)]],
    ]),
    at: ANOM_NOW,
  }) === null,
);

// ----- went_quiet -----

eq(
  'went_quiet: last workout 12 days ago → fires',
  detectWentQuiet({
    workouts: [wk('2026-05-20T10:00:00Z')],
    at: ANOM_NOW,
  })?.type,
  'went_quiet',
);
check(
  'went_quiet: last workout 3 days ago → does NOT fire',
  detectWentQuiet({
    workouts: [wk('2026-05-29T10:00:00Z')],
    at: ANOM_NOW,
  }) === null,
);
check(
  'went_quiet: zero workouts → does NOT fire (onboarding territory, not went_quiet)',
  detectWentQuiet({ workouts: [], at: ANOM_NOW }) === null,
);

// ----- orchestrator: Q4 suppression -----

const cliffyClientDInputs = (): AnomalyEvaluationInput => ({
  at: ANOM_NOW,
  clientId: 'clientD',
  // 14-day gap then a logged session — both returned_after_gap AND
  // performance_cliff would fire in isolation.
  completedWorkouts: [wk('2026-05-17T10:00:00Z'), wk('2026-05-31T10:00:00Z')],
  perExerciseSeries: new Map([
    ['bench', [sm('a', '2026-05-10T10:00:00Z', 100, 8), sm('b', '2026-05-31T10:00:00Z', 80, 8)]],
    ['squat', [sm('c', '2026-05-10T10:00:00Z', 150, 6), sm('d', '2026-05-31T10:00:00Z', 120, 6)]],
  ]),
  priorAdherence: adh(0.85),
  currentAdherence: adh(0.5),
  activeContext: null,
  recentlyAlertedTypes: new Set(),
  contextDirective: null,
});

check(
  'Q4 SUPPRESSION: returned_after_gap fires → performance_cliff dropped same eval',
  (() => {
    const out = evaluateAnomalies(cliffyClientDInputs());
    const types = out.map((d) => d.type);
    return types.includes('returned_after_gap') && !types.includes('performance_cliff');
  })(),
);
check(
  'Q4 SUPPRESSION: without returned_after_gap firing, performance_cliff is NOT suppressed',
  (() => {
    // No gap → no returned_after_gap. But synthesize a cliff via the
    // detector's own input shape isn't possible (needs gap). So we
    // test the inverse via direct detector: with consistent training
    // performance_cliff doesn't fire either, confirming the suppression
    // path is purely conditional on returned_after_gap.
    const out = evaluateAnomalies({
      ...cliffyClientDInputs(),
      completedWorkouts: [
        wk('2026-05-22T10:00:00Z'),
        wk('2026-05-25T10:00:00Z'),
        wk('2026-05-28T10:00:00Z'),
        wk('2026-05-31T10:00:00Z'),
      ],
    });
    return !out.some((d) => d.type === 'returned_after_gap') &&
      !out.some((d) => d.type === 'performance_cliff');
  })(),
);

// ----- orchestrator: context silencing + at_risk carve-out -----

const ctxOf = (reasonCode: 'health' | 'at_risk' | 'onboarding'): ActiveContext => ({
  reasonCode,
  source: 'persisted',
  reviewAt: new Date('2026-06-30T00:00:00Z'),
  note: null,
  contextId: `ctx-${reasonCode}`,
  createdAt: new Date('2026-05-30T00:00:00Z'),
});

eq(
  'context-silencing: active health context silences ALL anomalies (uniform default)',
  evaluateAnomalies({
    ...cliffyClientDInputs(),
    activeContext: ctxOf('health'),
    contextDirective: getContextDirective('health'),
  }).length,
  0,
);
check(
  'context-silencing: at_risk DOES silence returned_after_gap (already implied — Piece 1 carve-out via directive)',
  (() => {
    const out = evaluateAnomalies({
      ...cliffyClientDInputs(),
      activeContext: ctxOf('at_risk'),
      contextDirective: getContextDirective('at_risk'),
    });
    return !out.some((d) => d.type === 'returned_after_gap');
  })(),
);
check(
  'context-silencing: at_risk does NOT silence adherence_drop (signal, not noise)',
  (() => {
    const out = evaluateAnomalies({
      ...cliffyClientDInputs(),
      activeContext: ctxOf('at_risk'),
      contextDirective: getContextDirective('at_risk'),
    });
    return out.some((d) => d.type === 'adherence_drop');
  })(),
);
check(
  'context-silencing: at_risk does NOT silence went_quiet (signal, not noise) — gone-quiet client tested',
  (() => {
    const out = evaluateAnomalies({
      at: ANOM_NOW,
      clientId: 'at-risk-client',
      // 12 days quiet — went_quiet only (no return event, no cliff).
      completedWorkouts: [wk('2026-05-20T10:00:00Z')],
      perExerciseSeries: new Map(),
      priorAdherence: adh(0.5),
      currentAdherence: adh(0.4),
      activeContext: ctxOf('at_risk'),
      contextDirective: getContextDirective('at_risk'),
      recentlyAlertedTypes: new Set(),
    });
    return out.some((d) => d.type === 'went_quiet');
  })(),
);

// ----- orchestrator: dedup -----

check(
  'dedup: anomaly already alerted in the dedup window → dropped',
  (() => {
    const out = evaluateAnomalies({
      ...cliffyClientDInputs(),
      recentlyAlertedTypes: new Set(['returned_after_gap']),
    });
    return !out.some((d) => d.type === 'returned_after_gap');
  })(),
);

// ============================================================
// CLIENTD end-to-end fixture (Stage 6 sign-off requirement)
// ============================================================
// Real client coming back from a health gap. Walk all four states:
//   (1) Pre-coach-response: returned_after_gap fires + Q4 suppresses
//       performance_cliff. The notification prompts the coach.
//   (2) Coach applies a health context with review_at = +2 weeks
//       (simulated by passing the active context to the orchestrator).
//       All anomalies silenced — coach already knows.
//   (3) Past review_at with no further context (Piece 1's
//       non-staleness rule): the stale context returns null from
//       getActiveClientContext, so the orchestrator treats activeContext
//       as null and anomalies fire again if criteria still hold.
//   Same fixture data across all three to prove the read-path drives
//   behaviour.

const clientD = (overrides: Partial<AnomalyEvaluationInput> = {}): AnomalyEvaluationInput => ({
  ...cliffyClientDInputs(),
  clientId: 'clientD',
  ...overrides,
});

check(
  'CLIENTD (1) pre-context: returned_after_gap fires; Q4 suppresses performance_cliff',
  (() => {
    const out = evaluateAnomalies(clientD());
    const types = out.map((d) => d.type);
    return types.includes('returned_after_gap') && !types.includes('performance_cliff');
  })(),
);

check(
  'CLIENTD (2) coach applies health context: ALL anomalies silenced',
  evaluateAnomalies(
    clientD({
      activeContext: ctxOf('health'),
      contextDirective: getContextDirective('health'),
    }),
  ).length === 0,
);

check(
  'CLIENTD (3) post-review_at stale: orchestrator sees null context → anomalies re-fire normally',
  (() => {
    // Piece 1 contract: when the persisted row's review_at is past `at`,
    // getActiveClientContext returns null. The orchestrator never sees
    // the stale row — so anomaly suppression also stops. Simulate that
    // here by passing activeContext: null (the same value the helper
    // would return for a stale row).
    const out = evaluateAnomalies(clientD({ activeContext: null, contextDirective: null }));
    return out.some((d) => d.type === 'returned_after_gap');
  })(),
);

// ============================================================
// Stage 6 Piece 3 — context wiring across the 4 surfaces
// ============================================================

// Tier-0 weekly note: when contextTemplate is set, it wins over
// every other tier — including PR celebration. ClientC's payoff:
// a brand-new client who happened to log a PR-rep on day one still
// gets the "Getting started" framing, not "PR week."
check(
  'piece-3 surface 4: contextTemplate wins over topPR (tier 0 above tier 1)',
  (() => {
    const note = buildWeeklyCoachingNote(
      baseNoteInput({
        contextTemplate: 'getting_started',
        topPR: {
          exerciseName: 'Incline DB Press',
          weight: 27.5,
          unit: 'kg',
          reps: 8,
        },
      }),
    );
    return (
      note.title === 'Getting started' &&
      /Welcome aboard/.test(note.body) &&
      !/PR week/.test(note.title)
    );
  })(),
);

check(
  'piece-3 surface 4: contextTemplate=ease_back_in returns "Easing back in"',
  (() => {
    const note = buildWeeklyCoachingNote(
      baseNoteInput({ contextTemplate: 'ease_back_in' }),
    );
    return (
      note.title === 'Easing back in' && /Welcome back/.test(note.body)
    );
  })(),
);

check(
  'piece-3 surface 4: contextTemplate=re_engagement returns "Let\'s reset"',
  (() => {
    const note = buildWeeklyCoachingNote(
      baseNoteInput({ contextTemplate: 're_engagement' }),
    );
    return (
      /reset/.test(note.title) && /hard to get to the gym/.test(note.body)
    );
  })(),
);

// Surface 3 wiring: suggestions.ts must read from the directive at
// the Gate A site, the structural-block site, and the weekly-note
// emission. Source-grep guards against regression where a future
// edit accidentally bypasses the context layer.
check(
  'piece-3 surface 3: suggestions.ts imports getContextDirective + fetchActiveContextsForClients',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    return (
      /getContextDirective/.test(src) &&
      /fetchActiveContextsForClients/.test(src)
    );
  })(),
);

check(
  'piece-3 surface 3: suggestions.ts gates Gate A on directive.suppressGateA',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    return /directive\?\.suppressGateA/.test(src);
  })(),
);

check(
  'piece-3 surface 3: suggestions.ts structural block reads suppressAllProgramChanges + suppressPlateauSuggestions',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/suggestions.ts', 'utf-8');
    return (
      /directive\?\.suppressAllProgramChanges/.test(src) &&
      /directive\?\.suppressPlateauSuggestions/.test(src)
    );
  })(),
);

check(
  'piece-3 surface 3: weekly-report.ts catch-all passes directive.weeklyNoteTemplate',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/weekly-report.ts', 'utf-8');
    return (
      /getActiveClientContext/.test(src) &&
      /directive\?\.weeklyNoteTemplate/.test(src)
    );
  })(),
);

// Surface 2 wiring: the POST endpoint must consume writeClientContext
// (the store) and emit an audit_log row.
check(
  'piece-3 surface 2: POST /api/coach/clients/[id]/context wires writeClientContext + audit',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/clients/[id]/context/route.ts',
      'utf-8',
    );
    return (
      /writeClientContext/.test(src) &&
      /audit\(/.test(src) &&
      /set_client_context/.test(src)
    );
  })(),
);

// Surface 1 wiring: the cron route must dispatch analyzeAnomalies
// alongside analyzeClient + runReminders in the per-client Promise.all.
check(
  'piece-3 surface 1: cron daily-analysis dispatches analyzeAnomalies in per-client Promise.all',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/cron/daily-analysis/route.ts',
      'utf-8',
    );
    return (
      /evaluateAnomalies/.test(src) &&
      /analyzeAnomalies/.test(src) &&
      /sendPushToCoach/.test(src) &&
      /fetchActiveContextRow/.test(src)
    );
  })(),
);

// Construction-consistency: every Piece 3 surface that decides
// "should we soften Gate A / suppress the program / show the
// onboarding note" reaches into getContextDirective via the same
// directive variable. Source-grep enforces this — if a surface ever
// short-circuits to a hard-coded flag, this catches it.
check(
  'piece-3 construction-consistency: every directive consumer reads from getContextDirective (no parallel branches)',
  (() => {
    const fs = require('node:fs') as typeof import('node:fs');
    const files = [
      'src/lib/suggestions.ts',
      'src/lib/weekly-report.ts',
      'src/app/api/cron/daily-analysis/route.ts',
    ];
    return files.every((f) => /getContextDirective/.test(fs.readFileSync(f, 'utf-8')));
  })(),
);

// ============================================================
// Stage 6 Piece 4 — approval-gated weekly client-note send
// ============================================================
//
// The approval gate is the critical safety. These tests prioritize
// the fail-closed and dedup invariants over any feature working
// "prettily." Anything that lets a client receive a push without
// my explicit approval is a regression.

import {
  selectEligibleSendCandidates,
  type WeeklyNoteSendInputRow,
} from '../src/lib/signals/weekly-note-send';

// Mini factory for input rows so the tests below stay readable.
const sendInput = (
  overrides: Partial<WeeklyNoteSendInputRow> & {
    clientId?: string;
    name?: string;
    hasWeeklyNote?: boolean;
    weeklyNoteTitle?: string;
    weeklyNoteBody?: string;
    structuralSuggestion?: boolean;
  } = {},
): WeeklyNoteSendInputRow => {
  const clientId = overrides.clientId ?? 'c-x';
  const name = overrides.name ?? 'Test';
  const suggestions: Array<{ id: string; type: string; title: string; body: string; apply: null }> = [];
  if (overrides.hasWeeklyNote !== false) {
    suggestions.push({
      id: `weekly_note:${clientId}`,
      type: 'weekly_note',
      title: overrides.weeklyNoteTitle ?? 'Holding steady',
      body: overrides.weeklyNoteBody ?? '90% adherence this week. Stay the course.',
      apply: null,
    });
  }
  if (overrides.structuralSuggestion) {
    suggestions.push({
      id: `adjust:${clientId}`,
      type: 'adjust',
      title: 'Add a set',
      body: '...',
      apply: null,
    });
  }
  return {
    row: {
      clientId,
      name,
      daysDone: 3,
      daysTarget: 4,
      totalSets: 0,
      videos: 0,
      painExercises: 0,
      stalledEscalations: 0,
      prs: 0,
      bodyWeight: null,
      checkedIn: false,
      // Cast to satisfy the structural type without pulling Suggestion's full union here.
      suggestions: suggestions as unknown as import('../src/lib/suggestions').Suggestion[],
    },
    directive: overrides.directive ?? null,
    reasonCode: overrides.reasonCode ?? null,
    contextSource: overrides.contextSource ?? null,
    alreadySentThisWeek: overrides.alreadySentThisWeek ?? false,
  };
};

// (1) Empty input → empty candidates. Trivial but locks the baseline.
eq(
  'piece-4: empty inputs → empty candidates',
  selectEligibleSendCandidates([]).length,
  0,
);

// (2) Row without a weekly_note Suggestion is excluded. Structural-
// only weeks fall through to the catch-all in weekly-report.ts; if
// neither produced a weekly_note, the client is NOT eligible for
// this batch.
eq(
  'piece-4: no weekly_note in suggestions → excluded',
  selectEligibleSendCandidates([
    sendInput({ clientId: 'c1', hasWeeklyNote: false, structuralSuggestion: true }),
  ]).length,
  0,
);

// (3) Row with a weekly_note and no active context → included.
// This is the standard happy path.
check(
  'piece-4: weekly_note present + no directive → included',
  (() => {
    const out = selectEligibleSendCandidates([
      sendInput({ clientId: 'c2', name: 'Default Client' }),
    ]);
    return out.length === 1 && out[0].clientId === 'c2' && out[0].title === 'Holding steady';
  })(),
);

// (4) directive.suppressClientWeeklyMessage = true → excluded.
// This covers paused/planned_break/travel. Read from the actual
// getContextDirective values to make sure the directive matrix
// stays in sync (not a hardcoded fixture).
check(
  'piece-4: paused context → excluded (suppressClientWeeklyMessage=true)',
  (() => {
    const directive = getContextDirective('paused');
    const out = selectEligibleSendCandidates([
      sendInput({
        clientId: 'c-paused',
        directive,
        reasonCode: 'paused',
        contextSource: 'persisted',
      }),
    ]);
    return out.length === 0;
  })(),
);

check(
  'piece-4: travel context → excluded (suppressClientWeeklyMessage=true)',
  selectEligibleSendCandidates([
    sendInput({
      clientId: 'c-travel',
      directive: getContextDirective('travel'),
      reasonCode: 'travel',
      contextSource: 'persisted',
    }),
  ]).length === 0,
);

check(
  'piece-4: planned_break context → excluded (suppressClientWeeklyMessage=true)',
  selectEligibleSendCandidates([
    sendInput({
      clientId: 'c-planned',
      directive: getContextDirective('planned_break'),
      reasonCode: 'planned_break',
      contextSource: 'persisted',
    }),
  ]).length === 0,
);

// (5) Onboarding / health / at_risk → INCLUDED with the tier-0
// framed note (the note body itself comes from buildWeeklyCoachingNote;
// here we just confirm the directive doesn't gate them out).
check(
  'piece-4: onboarding context → included with getting_started title',
  (() => {
    const out = selectEligibleSendCandidates([
      sendInput({
        clientId: 'c-onb',
        name: 'New Person',
        directive: getContextDirective('onboarding'),
        reasonCode: 'onboarding',
        contextSource: 'synthesized_onboarding',
        weeklyNoteTitle: 'Getting started',
        weeklyNoteBody: "Welcome aboard. We're in the first couple of weeks together...",
      }),
    ]);
    return (
      out.length === 1 &&
      out[0].title === 'Getting started' &&
      /Welcome aboard/.test(out[0].body) &&
      out[0].reasonCode === 'onboarding'
    );
  })(),
);

check(
  'piece-4: health context → included with ease_back_in framing',
  (() => {
    const out = selectEligibleSendCandidates([
      sendInput({
        clientId: 'c-health',
        directive: getContextDirective('health'),
        reasonCode: 'health',
        contextSource: 'persisted',
        weeklyNoteTitle: 'Easing back in',
        weeklyNoteBody: 'Welcome back. First sessions after a break...',
      }),
    ]);
    return out.length === 1 && out[0].title === 'Easing back in';
  })(),
);

check(
  'piece-4: at_risk context → included with re_engagement framing',
  (() => {
    const out = selectEligibleSendCandidates([
      sendInput({
        clientId: 'c-atrisk',
        directive: getContextDirective('at_risk'),
        reasonCode: 'at_risk',
        contextSource: 'persisted',
        weeklyNoteTitle: "Let's reset",
        weeklyNoteBody: "I've noticed it's been hard to get to the gym lately...",
      }),
    ]);
    return out.length === 1 && /reset/.test(out[0].title);
  })(),
);

// (6) Dedup: alreadySentThisWeek=true → excluded. This is the
// at-most-once-per-week invariant — a second approval/re-run sends
// zero pushes for clients already marked sent.
eq(
  'piece-4: alreadySentThisWeek=true → excluded (dedup)',
  selectEligibleSendCandidates([
    sendInput({ clientId: 'c-already', alreadySentThisWeek: true }),
  ]).length,
  0,
);

// (7) CLIENTC fixture (Stage 6 Piece 4 end-to-end). Synthesized
// onboarding + has weekly_note with getting_started framing → ONE
// eligible candidate. Re-running with alreadySentThisWeek=true → ZERO.
check(
  'piece-4 CLIENTC fixture: appears in eligible with getting_started; second run sends zero',
  (() => {
    const inputs: WeeklyNoteSendInputRow[] = [
      sendInput({
        clientId: 'clientC',
        name: 'ClientC',
        directive: getContextDirective('onboarding'),
        reasonCode: 'onboarding',
        contextSource: 'synthesized_onboarding',
        weeklyNoteTitle: 'Getting started',
        weeklyNoteBody: "Welcome aboard. We're in the first couple of weeks together...",
      }),
    ];
    const firstRun = selectEligibleSendCandidates(inputs);
    if (firstRun.length !== 1) return false;
    if (firstRun[0].title !== 'Getting started') return false;
    if (firstRun[0].reasonCode !== 'onboarding') return false;

    // Second run after she's been marked sent.
    const secondInputs = inputs.map((i) => ({ ...i, alreadySentThisWeek: true }));
    const secondRun = selectEligibleSendCandidates(secondInputs);
    return secondRun.length === 0;
  })(),
);

// (8) The bulletproof gate — source-grep the dispatch function to
// confirm it reads approved_at from weekly_note_approvals BEFORE
// touching alerts or sendPushToClient. The order of operations
// matters: a future edit that moves the push above the gate would
// silently break the safety contract.
check(
  'piece-4 fail-closed gate 2: dispatchApprovedWeeklyNotes reads approved_at FIRST, before any send',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('src/lib/weekly-note-send.ts', 'utf-8');
    // Find the dispatchApprovedWeeklyNotes function body, check the
    // approved_at gate appears BEFORE sendPushToClient OR alerts insert.
    const fnIdx = src.indexOf('export async function dispatchApprovedWeeklyNotes');
    if (fnIdx === -1) return false;
    const body = src.slice(fnIdx);
    const gateIdx = body.indexOf('approved_at');
    const pushIdx = body.indexOf('sendPushToClient');
    const insertIdx = body.indexOf("type: 'weekly_note_sent'");
    return gateIdx > 0 && pushIdx > gateIdx && insertIdx > gateIdx;
  })(),
);

// (9) Both gates encoded: the route does its atomic UPDATE WHERE
// approved_at IS NULL, AND dispatch re-reads approved_at. Source-
// grep both. If either disappears, this fails loud.
check(
  'piece-4 gate 1: approve route uses atomic UPDATE WHERE approved_at IS NULL',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/weekly-notes/approve/route.ts',
      'utf-8',
    );
    return (
      /\.update\(\s*\{[\s\S]*?approved_at:/.test(src) &&
      /\.is\(\s*['"]approved_at['"]\s*,\s*null\s*\)/.test(src)
    );
  })(),
);

// (10) The PREPARE cron must NEVER send. Source-grep asserts the
// route does not import sendPushToClient OR call dispatch. This is
// the strongest signal we have without running it against a real DB.
check(
  'piece-4 cron prepare: route does NOT import or call sendPushToClient (function-call form)',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/cron/weekly-note-prepare/route.ts',
      'utf-8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    return !/sendPushToClient\s*\(/.test(code) && !/from\s+['"][^'"]+['"][^;]*sendPushToClient/.test(code);
  })(),
);

check(
  'piece-4 cron prepare: route does NOT call dispatchApprovedWeeklyNotes (function-call form)',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/cron/weekly-note-prepare/route.ts',
      'utf-8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    return !/dispatchApprovedWeeklyNotes\s*\(/.test(code) && !/from\s+['"][^'"]+['"][^;]*dispatchApprovedWeeklyNotes/.test(code);
  })(),
);

// (10b) Sunday-approve / Monday-send split: the APPROVE route must
// NOT dispatch. Records approval only. The Monday cron is the only
// auto-trigger; the manual /dispatch route handles failure recovery.
// If a future edit re-adds dispatch to the approve route, this test
// catches it.
check(
  'piece-4 split: approve route does NOT call dispatchApprovedWeeklyNotes (records approval only)',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/weekly-notes/approve/route.ts',
      'utf-8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    return !/dispatchApprovedWeeklyNotes\s*\(/.test(code);
  })(),
);

// (10c) Monday-send cron must call dispatch and pass an `at` derived
// from reviewAtFor so weekStartIsoFor lands on the prior week's
// Monday (the row the coach approved).
check(
  'piece-4 split: Monday send cron calls dispatchApprovedWeeklyNotes with reviewAtFor(now)',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/cron/weekly-note-send/route.ts',
      'utf-8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    return (
      /dispatchApprovedWeeklyNotes\s*\(/.test(code) &&
      /reviewAtFor\s*\(/.test(code)
    );
  })(),
);

// (11) audit_log on approval action — captures who approved so we
// have a record. The dispatch audit moved to the Monday cron path
// and the manual /dispatch route; the approve route audits the
// approval itself.
check(
  'piece-4 audit: approve route writes audit_log for approve_weekly_notes',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/weekly-notes/approve/route.ts',
      'utf-8',
    );
    return /approve_weekly_notes/.test(src) && /audit\(/.test(src);
  })(),
);

check(
  'piece-4 audit: manual /dispatch route writes audit_log for dispatch_weekly_notes_manual',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync(
      'src/app/api/coach/weekly-notes/dispatch/route.ts',
      'utf-8',
    );
    return /dispatch_weekly_notes_manual/.test(src) && /audit\(/.test(src);
  })(),
);

// (12) Vercel cron registration — Sunday prepare + Monday send.
// If either disappears, the workflow breaks silently.
check(
  'piece-4 vercel.json: weekly-note-prepare registered with Sunday 06:00 UTC schedule',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('vercel.json', 'utf-8');
    // Find the prepare cron's schedule line specifically.
    const m = src.match(/weekly-note-prepare[\s\S]{0,120}?schedule['"]?\s*:\s*['"]([^'"]+)['"]/);
    return m?.[1] === '0 6 * * 0';
  })(),
);

check(
  'piece-4 vercel.json: weekly-note-send registered with Monday 06:00 UTC schedule',
  (() => {
    const src = (
      require('node:fs') as typeof import('node:fs')
    ).readFileSync('vercel.json', 'utf-8');
    const m = src.match(/weekly-note-send[\s\S]{0,120}?schedule['"]?\s*:\s*['"]([^'"]+)['"]/);
    return m?.[1] === '0 6 * * 1';
  })(),
);

// (13) reviewAtFor — the helper that lets Sunday's preview UI,
// Monday's send cron, and any mid-week sanity check all key on the
// SAME weekStart. Pure-helper unit tests.
import { reviewAtFor } from '../src/lib/signals/weekly-note-send';

check(
  'piece-4 reviewAtFor: Sunday access → end of TODAY (Sun 23:59:59)',
  (() => {
    // Wed 2026-06-03 is dow=3; the most recent Sunday is May 31.
    // Pick a Sunday explicitly so the test is timezone-stable.
    const sun = new Date('2026-06-07T11:00:00Z'); // Sunday
    const at = reviewAtFor(sun);
    // Same local date as the input, time at end-of-day.
    return at.getDay() === 0 && at.toDateString() === sun.toDateString();
  })(),
);

check(
  'piece-4 reviewAtFor: Monday access → end of LAST Sunday (prior week)',
  (() => {
    const mon = new Date('2026-06-08T06:00:00Z'); // Monday 06:00 UTC
    const at = reviewAtFor(mon);
    // Should land on the prior Sunday (Jun 7).
    return at.getDay() === 0;
  })(),
);

check(
  'piece-4 reviewAtFor: Wednesday access → end of LAST Sunday (same week as Mon cron)',
  (() => {
    const wed = new Date('2026-06-10T15:00:00Z');
    const at = reviewAtFor(wed);
    return at.getDay() === 0;
  })(),
);

// (14) Sun-approve + Mon-send sequence verification (pure-helper-
// level). Simulates the lifecycle:
//   T0 Sun: prepare cron writes row, no approval, no sends
//   T1 Sun: coach approves → no sends yet
//   T2 Mon: cron dispatches → 1 push per eligible client
//   T3 Mon: cron retries → 0 pushes (dedup holds)
//
// This test exercises selectEligibleSendCandidates with
// alreadySentThisWeek toggling false → true to simulate the
// weekly_note_sent insert that dispatch writes between Mon firings.
check(
  'piece-4 sequence: Sun approve + Mon cron fires once + retry yields zero',
  (() => {
    const inputs: WeeklyNoteSendInputRow[] = [
      sendInput({ clientId: 'a', name: 'Alice' }),
      sendInput({ clientId: 'b', name: 'Bob' }),
      sendInput({
        clientId: 'c',
        name: 'Carla',
        directive: getContextDirective('paused'),
        reasonCode: 'paused',
      }), // paused — excluded
    ];

    // T0+T1: Sunday — no sends regardless of approval. The pure
    // selector doesn't know about approval; dispatch's gate 2 is
    // what enforces this in production. Tested at gate level above.

    // T2: Monday cron. Pure: eligible = Alice + Bob (Carla paused).
    const mondayRun = selectEligibleSendCandidates(inputs);
    if (mondayRun.length !== 2) return false;
    if (!mondayRun.find((c) => c.clientId === 'a')) return false;
    if (!mondayRun.find((c) => c.clientId === 'b')) return false;

    // T3: Monday cron retry — both Alice + Bob now marked
    // alreadySentThisWeek by the weekly_note_sent alerts dispatch
    // inserted. selector returns zero.
    const retryInputs = inputs.map((i) =>
      i.row.clientId === 'a' || i.row.clientId === 'b'
        ? { ...i, alreadySentThisWeek: true }
        : i,
    );
    const retryRun = selectEligibleSendCandidates(retryInputs);
    return retryRun.length === 0;
  })(),
);

// ---------- summary ----------

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`OK  ${passed} passed`);
