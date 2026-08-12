/**
 * Inspects an existing client xlsx and reports:
 *   - Program structure (days + exercises)
 *   - Per-exercise best effort across all logged weeks
 *   - Number of fully-logged weeks (so we can tell "what week" the client is on)
 *
 * Usage: npx tsx scripts/inspect-history.ts <path-to-xlsx>
 *
 * No DB writes. Pure reporting so we can sanity-check before seeding.
 */
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npx tsx scripts/inspect-history.ts <path-to-xlsx>');
  process.exit(1);
}

const buf = readFileSync(resolve(file));
const wb = XLSX.read(buf, { type: 'buffer' });
if (!wb.SheetNames.length) {
  console.error('Empty workbook');
  process.exit(1);
}
const sheet = wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
  header: 1,
  defval: '',
  blankrows: true,
});

console.log(`Sheet: ${wb.SheetNames[wb.SheetNames.length - 1]}`);
console.log(`Total rows: ${rows.length}\n`);

// ---- Find week headers ----
// Cols 0+1 are name + prescription. Some sheets have "Week 1" in col 0
// by mistake — skip it. Same gating the Apps Script had via FIRST_LOG_COL.
const FIRST_LOG_COL = 2;
const header = rows[0] ?? [];
type WeekCol = { col: number; num: number };
const weekCols: WeekCol[] = [];
for (let c = FIRST_LOG_COL; c < header.length; c++) {
  const cell = String(header[c] ?? '').trim();
  const m = cell.match(/^week\s*(\d+)$/i);
  if (m) weekCols.push({ col: c, num: parseInt(m[1], 10) });
}
console.log(`Week columns found: ${weekCols.map((w) => `Week ${w.num} @col ${w.col}`).join(', ')}\n`);

if (weekCols.length === 0) {
  console.error('No "Week N" headers in row 1 — nothing to import');
  process.exit(1);
}

// ---- Walk rows: collect day blocks + exercise rows ----
type ExerciseRow = { name: string; rowIdx: number; dayLabel: string };
const exercises: ExerciseRow[] = [];

const PRESCRIPTION_COL = 1;

const headerColA = String(header[0] ?? '').trim();
const headerColB = String(header[PRESCRIPTION_COL] ?? '').trim();
let currentDay: string | null = null;

if (
  headerColA &&
  !headerColB &&
  !/^week\s*\d+$/i.test(headerColA) &&
  headerColA.toLowerCase() !== 'name'
) {
  currentDay = headerColA;
}

for (let r = 1; r < rows.length; r++) {
  const row = rows[r] ?? [];
  const a = String(row[0] ?? '').trim();
  const b = String(row[PRESCRIPTION_COL] ?? '').trim();
  if (!a && !b) continue;
  if (a && !b) {
    currentDay = a;
    continue;
  }
  if (a && b && currentDay) {
    exercises.push({ name: a, rowIdx: r, dayLabel: currentDay });
  }
}

console.log(`Days detected: ${[...new Set(exercises.map((e) => e.dayLabel))].length}`);
console.log(`Total exercises: ${exercises.length}\n`);

// ---- Cell parsing: extract sets from a logged cell ----
type SetRow = {
  weight: number | null;
  unit: 'kg' | 'lb';
  reps: number | null;
  rir: number | null;
  cardioMin: number | null;
};

// Cell formats observed across the sheets:
//   "82.5kg x 8 @3 RIR"             → weight=82.5, reps=8, rir=3
//   "80 kgs x 6"                    → weight=80,   reps=6
//   "10 kgs 7-8 reps"               → weight=10,   reps=8 (high end of range)
//   "100 lbs 6 reps"                → weight=100,  unit=lb, reps=6
//   "Weight: 12 kgs Reps: 6 RIR: 0-2" → weight=12, reps=6, rir=0 (low end of RIR range)
//   "Reps: 6"                       → reps=6, no weight
//   "8 reps"                        → reps=8, no weight
//   "25 min"                        → cardioMin=25
function parseCell(text: string): SetRow[] {
  if (!text) return [];
  const lines = text
    .split(/[\r\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const sets: SetRow[] = [];

  for (const line of lines) {
    // Cardio first — "20 min" / "25min"
    const cardio = line.match(/(\d+(?:\.\d+)?)\s*min\b/i);
    if (cardio) {
      sets.push({
        weight: null,
        unit: 'kg',
        reps: null,
        rir: null,
        cardioMin: parseFloat(cardio[1]),
      });
      continue;
    }

    // Verbose form: "Weight: X unit Reps: Y RIR: Z"
    const verbose = line.match(
      /weight\s*:\s*(\d+(?:\.\d+)?)\s*(kgs?|lbs?|lb)?\s*(?:reps?\s*:\s*(\d+(?:\s*-\s*\d+)?))?(?:\s*rir\s*:\s*(\d+(?:\s*-\s*\d+)?))?/i
    );
    if (verbose) {
      const weight = parseFloat(verbose[1]);
      const unit = ((verbose[2] ?? 'kg').toLowerCase().startsWith('lb') ? 'lb' : 'kg') as
        | 'kg'
        | 'lb';
      const repsRaw = verbose[3];
      const rirRaw = verbose[4];
      const reps = repsRaw ? takeHigh(repsRaw) : null;
      const rir = rirRaw ? takeLow(rirRaw) : null;
      sets.push({ weight, unit, reps, rir, cardioMin: null });
      continue;
    }

    // Strip RIR for the remaining parsers.
    let rest = line;
    let rir: number | null = null;
    const rirMatch = rest.match(/@\s*(\d+(?:\s*-\s*\d+)?)\s*rir\b/i);
    if (rirMatch) {
      rir = takeLow(rirMatch[1]);
      rest = rest.replace(rirMatch[0], ' ');
    }

    // "weight unit x reps"  (with explicit x)
    const wxr = rest.match(/(\d+(?:\.\d+)?)\s*(kgs?|lbs?|lb)?\s*[x×]\s*(\d+(?:\s*-\s*\d+)?)/i);
    if (wxr) {
      const weight = parseFloat(wxr[1]);
      const unit = ((wxr[2] ?? 'kg').toLowerCase().startsWith('lb') ? 'lb' : 'kg') as 'kg' | 'lb';
      const reps = takeHigh(wxr[3]);
      sets.push({ weight, unit, reps, rir, cardioMin: null });
      continue;
    }

    // "weight unit reps reps"  — a common sheet form, no explicit x
    //   "10 kgs 7-8 reps", "70 lbs 7 reps", "7.5kg 6 reps"
    const wur = rest.match(
      /(\d+(?:\.\d+)?)\s*(kgs?|lbs?|lb)\s+(\d+(?:\s*-\s*\d+)?)\s*reps?\b/i
    );
    if (wur) {
      const weight = parseFloat(wur[1]);
      const unit = (wur[2].toLowerCase().startsWith('lb') ? 'lb' : 'kg') as 'kg' | 'lb';
      const reps = takeHigh(wur[3]);
      sets.push({ weight, unit, reps, rir, cardioMin: null });
      continue;
    }

    // "Reps: 6" — reps only
    const repsOnly = rest.match(/reps?\s*:?\s*(\d+(?:\s*-\s*\d+)?)/i);
    if (repsOnly) {
      sets.push({
        weight: null,
        unit: 'kg',
        reps: takeHigh(repsOnly[1]),
        rir,
        cardioMin: null,
      });
      continue;
    }

    // "8 reps" — trailing reps only
    const trailingReps = rest.match(/^(\d+(?:\s*-\s*\d+)?)\s*reps?\b/i);
    if (trailingReps) {
      sets.push({
        weight: null,
        unit: 'kg',
        reps: takeHigh(trailingReps[1]),
        rir,
        cardioMin: null,
      });
    }
  }
  return sets;
}

function takeHigh(rangeOrNum: string): number {
  // "7-8" → 8 ; "6" → 6
  const parts = rangeOrNum.split(/\s*-\s*/).map((s) => parseInt(s, 10));
  return Math.max(...parts);
}
function takeLow(rangeOrNum: string): number {
  const parts = rangeOrNum.split(/\s*-\s*/).map((s) => parseInt(s, 10));
  return Math.min(...parts);
}

// ---- For each exercise, scan every week column and find best ----
type Best = {
  weight: number;
  unit: 'kg' | 'lb';
  reps: number;
  inWeek: number;
};
type ExerciseSummary = {
  dayLabel: string;
  name: string;
  best: Best | null;
  weeksLogged: Set<number>;
  cardio: boolean;
};

const summaries: ExerciseSummary[] = [];

for (const ex of exercises) {
  const row = rows[ex.rowIdx] ?? [];
  const summary: ExerciseSummary = {
    dayLabel: ex.dayLabel,
    name: ex.name,
    best: null,
    weeksLogged: new Set(),
    cardio: false,
  };
  for (const wc of weekCols) {
    const cell = String(row[wc.col] ?? '').trim();
    if (!cell) continue;
    const sets = parseCell(cell);
    if (sets.length === 0) continue;
    summary.weeksLogged.add(wc.num);
    for (const s of sets) {
      if (s.cardioMin != null) {
        summary.cardio = true;
        continue;
      }
      if (s.weight != null && s.reps != null) {
        const beats =
          !summary.best ||
          s.weight > summary.best.weight ||
          (s.weight === summary.best.weight && s.reps > summary.best.reps);
        if (beats) {
          summary.best = { weight: s.weight, unit: s.unit, reps: s.reps, inWeek: wc.num };
        }
      }
    }
  }
  summaries.push(summary);
}

// ---- Determine "current week" ----
// The latest week with ANY logged data.
const allLoggedWeeks = new Set<number>();
for (const s of summaries) for (const w of s.weeksLogged) allLoggedWeeks.add(w);
const sortedLoggedWeeks = [...allLoggedWeeks].sort((a, b) => a - b);
const latestWeek = sortedLoggedWeeks.at(-1) ?? 0;

// Per-day completion check: count how many exercises in each day have data this week
const exercisesByDay = new Map<string, ExerciseSummary[]>();
for (const s of summaries) {
  const arr = exercisesByDay.get(s.dayLabel) ?? [];
  arr.push(s);
  exercisesByDay.set(s.dayLabel, arr);
}

console.log('=== BEST EFFORTS (would seed best_efforts table) ===\n');
for (const s of summaries) {
  if (s.cardio) {
    console.log(`  [${s.dayLabel}] ${s.name}  →  cardio (no PR seeded)`);
    continue;
  }
  if (s.best) {
    console.log(
      `  [${s.dayLabel}] ${s.name}  →  ${s.best.weight}${s.best.unit.toUpperCase()} × ${s.best.reps} (set in week ${s.best.inWeek})`
    );
  } else {
    console.log(`  [${s.dayLabel}] ${s.name}  →  no logged sets`);
  }
}

console.log(`\n=== WEEK POSITION ===`);
console.log(`Weeks with any logged data: ${sortedLoggedWeeks.join(', ') || '(none)'}`);
console.log(`Latest week: ${latestWeek}`);

console.log(`\n=== PER-DAY COMPLETION IN WEEK ${latestWeek} ===`);
for (const [dayLabel, exs] of exercisesByDay) {
  const inLatest = exs.filter((e) => e.weeksLogged.has(latestWeek)).length;
  const total = exs.length;
  const status = inLatest === 0 ? 'not started' : inLatest === total ? 'complete' : `partial (${inLatest}/${total})`;
  console.log(`  ${dayLabel}: ${status}`);
}

console.log('\n(No DB writes performed.)');
