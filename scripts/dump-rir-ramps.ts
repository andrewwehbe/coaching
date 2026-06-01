/**
 * Dump the full 5-week RIR ramp for one strength-biased compound and
 * one hypertrophy-biased isolation, including the deload-week column,
 * for the Stage-3 sanity check. Not run in CI — pure inspection tool.
 *
 *   npx tsx scripts/dump-rir-ramps.ts
 */
import { prescribeRir } from '../src/lib/signals/rir-prescription';

type Row = {
  label: string;
  rep_min: number;
  rep_max: number;
  is_compound: boolean;
};

const LIFTS: Row[] = [
  // Strength-biased compound — e.g. a 3-6 back squat.
  { label: 'Barbell Squat (3-6, compound)', rep_min: 3, rep_max: 6, is_compound: true },
  // Hypertrophy-biased isolation — e.g. a 12-15 cable lateral raise.
  { label: 'Cable Lateral Raise (12-15, isolation)', rep_min: 12, rep_max: 15, is_compound: false },
];

const BLOCK_LEN = 5;

function fmt(min: number, max: number): string {
  return min === max ? `${min}` : `${min}-${max}`;
}

for (const lift of LIFTS) {
  console.log(`\n=== ${lift.label} (intermediate, blockLen=${BLOCK_LEN}) ===`);
  console.log(
    'block-wk  rampPos   normal RIR   deload-wk RIR   notes',
  );
  console.log('-'.repeat(70));
  for (let wsld = 0; wsld < BLOCK_LEN; wsld++) {
    const normal = prescribeRir({
      rep_min: lift.rep_min,
      rep_max: lift.rep_max,
      is_compound: lift.is_compound,
      weekInProgram: wsld + 1,
      weeksSinceLastDeload: wsld,
      blockLengthWeeks: BLOCK_LEN,
      isDeloadWeek: false,
    });
    const deload = prescribeRir({
      rep_min: lift.rep_min,
      rep_max: lift.rep_max,
      is_compound: lift.is_compound,
      weekInProgram: wsld + 1,
      weeksSinceLastDeload: wsld,
      blockLengthWeeks: BLOCK_LEN,
      isDeloadWeek: true,
    });
    const notes: string[] = [];
    if (normal.compoundFloorApplied) notes.push('compound-floor');
    console.log(
      `   ${wsld + 1}      ${normal.rampPosition.toFixed(2)}      ${fmt(normal.min, normal.max).padEnd(10)}   ${fmt(deload.min, deload.max).padEnd(10)}     ${notes.join(', ')}`,
    );
  }
}

console.log('\n(load held on deload weeks per Coleman 2024 — only RIR backs off.)\n');
