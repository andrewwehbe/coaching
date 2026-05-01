/**
 * Smoke test for the sheet parser. Run manually:
 *   npx tsx tests/parse.test.ts <path-to-xlsx>
 *
 * No assertions framework — exits non-zero with a diff-style message
 * if anything looks off.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseSheet } from '../src/lib/sheet-parser';

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: tsx tests/parse.test.ts <path-to-xlsx>');
    process.exit(1);
  }
  const buf = readFileSync(resolve(arg));
  const result = parseSheet(buf);

  if (!result.ok) {
    console.error(`PARSE FAILED with ${result.errors.length} error(s):`);
    for (const e of result.errors) {
      console.error(`  row ${e.row}: ${e.message}`);
    }
    process.exit(1);
  }

  console.log(`OK: ${result.program.days.length} day(s)`);
  for (const [i, d] of result.program.days.entries()) {
    console.log(`  ${i + 1}. ${d.label} (${d.exercises.length} exercises)`);
    for (const ex of d.exercises) {
      const cardio = ex.is_cardio ? ' [cardio]' : '';
      console.log(
        `       - ${ex.name} :: ${ex.prescribed_sets}x${ex.rep_min}-${ex.rep_max} @${ex.rir_target ?? '—'}${cardio}`
      );
    }
  }
}

main();
