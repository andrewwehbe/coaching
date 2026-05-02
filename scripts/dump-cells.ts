import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
const buf = readFileSync(resolve(file));
const wb = XLSX.read(buf, { type: 'buffer' });
const sheet = wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
  header: 1,
  defval: '',
  blankrows: true,
});

console.log('Header row:');
console.log(rows[0]);
console.log();

console.log('First 25 rows, all columns:');
for (let r = 0; r < Math.min(25, rows.length); r++) {
  const row = rows[r] ?? [];
  for (let c = 0; c < row.length; c++) {
    const v = String(row[c] ?? '').trim();
    if (v) console.log(`  [r${r} c${c}]: ${JSON.stringify(v)}`);
  }
  console.log('  ---');
}
