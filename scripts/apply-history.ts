/**
 * Backfill an existing client into the app:
 *   - Creates a fresh program from the xlsx structure
 *   - Inserts best_efforts rows from the historical log cells
 *   - Inserts skeleton workout rows for fully-completed past weeks +
 *     completed days of the current week, so the app's "today" suggestion
 *     and weekly_day_target counter agree with the client's real position
 *
 * Usage (dry-run, default):
 *   npx tsx scripts/apply-history.ts <xlsx-path> --pin <PIN> --current-week <N> --completed-days-this-week <D>
 *
 * Add --apply to actually write.
 *
 * Refuses to run if the client already has a program — pass --force to wipe
 * existing program/workouts/bests for that client first.
 */
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';
import { startOfWeek, formatISO, subWeeks, addDays } from 'date-fns';

config({ path: resolve(process.cwd(), '.env.local') });

// -------- CLI parsing --------
const args = process.argv.slice(2);
const xlsxPath = args[0];
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function bool(name: string): boolean {
  return args.includes(`--${name}`);
}
const PIN = flag('pin');
const CURRENT_WEEK = Number(flag('current-week'));
const DONE_DAYS = Number(flag('completed-days-this-week'));
const APPLY = bool('apply');
const FORCE = bool('force');

if (!xlsxPath || !PIN || !Number.isFinite(CURRENT_WEEK) || !Number.isFinite(DONE_DAYS)) {
  console.error(
    'Usage: npx tsx scripts/apply-history.ts <xlsx> --pin <PIN> --current-week <N> --completed-days-this-week <D> [--apply] [--force]'
  );
  process.exit(1);
}

// -------- Supabase --------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// -------- Sheet parsing (mirrors the inspector) --------
const FIRST_LOG_COL = 2;
const PRESCRIPTION_COL = 1;
const PRESCRIPTION_RE =
  /^\s*(\d+)\s*x\s*(\d+)(?:\s*-\s*(\d+))?\s*(?:@\s*([^\s]+(?:\s+[^\s]+)*?))?\s*$/i;
const CARDIO_RE = /^\s*(\d+)\s*x\s*(\d+)\s*min\b/i;

type Ex = {
  name: string;
  name_key: string;
  prescription_raw: string;
  prescribed_sets: number;
  rep_min: number | null;
  rep_max: number | null;
  rir_target: string | null;
  is_cardio: boolean;
  cardio_type: 'treadmill' | 'elliptical' | 'stairmaster' | null;
};
type Day = { label: string; exercises: Ex[]; rowIdxByExName: Map<string, number> };
type Best = { weight: number; unit: 'kg' | 'lb'; reps: number };

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
// Per-day scoped key: same name on different days tracks separately.
function scopedKey(dayIndex: number, name: string): string {
  return `d${dayIndex}::${normalize(name)}`;
}
function detectCardio(name: string): Ex['cardio_type'] {
  const n = name.toLowerCase();
  if (/\btreadmill\b/.test(n)) return 'treadmill';
  if (/\belliptical\b/.test(n)) return 'elliptical';
  if (/\bstair\s*master\b|\bstairmaster\b|\bstair[-\s]*climber\b/.test(n)) return 'stairmaster';
  return null;
}
function parsePrescription(raw: string): {
  sets: number;
  rep_min: number | null;
  rep_max: number | null;
  rir: string | null;
  is_cardio: boolean;
} | null {
  const cardio = raw.match(CARDIO_RE);
  if (cardio) {
    return {
      sets: parseInt(cardio[1], 10),
      rep_min: parseInt(cardio[2], 10),
      rep_max: parseInt(cardio[2], 10),
      rir: null,
      is_cardio: true,
    };
  }
  const m = raw.match(PRESCRIPTION_RE);
  if (!m) return null;
  const lo = parseInt(m[2], 10);
  const hi = m[3] ? parseInt(m[3], 10) : lo;
  let rir: string | null = null;
  const tail = (m[4] ?? '').trim();
  if (tail) {
    const rirMatch = tail.match(/^(\d+(?:\s*-\s*\d+)?)\s*rir\b/i);
    if (rirMatch) rir = rirMatch[1].replace(/\s+/g, '');
    else return null;
  }
  return {
    sets: parseInt(m[1], 10),
    rep_min: lo,
    rep_max: hi,
    rir,
    is_cardio: false,
  };
}
function takeHigh(rangeOrNum: string): number {
  return Math.max(...rangeOrNum.split(/\s*-\s*/).map((s) => parseInt(s, 10)));
}
function parseCellSets(text: string): { weight: number | null; unit: 'kg' | 'lb'; reps: number | null }[] {
  if (!text) return [];
  const lines = text.split(/[\r\n;]+/).map((s) => s.trim()).filter(Boolean);
  const out: { weight: number | null; unit: 'kg' | 'lb'; reps: number | null }[] = [];
  for (const line of lines) {
    if (/(\d+(?:\.\d+)?)\s*min\b/i.test(line)) {
      // cardio — ignored for best_efforts
      continue;
    }
    const verbose = line.match(
      /weight\s*:\s*(\d+(?:\.\d+)?)\s*(kgs?|lbs?|lb)?\s*(?:reps?\s*:\s*(\d+(?:\s*-\s*\d+)?))?/i
    );
    if (verbose) {
      const weight = parseFloat(verbose[1]);
      const unit = ((verbose[2] ?? 'kg').toLowerCase().startsWith('lb') ? 'lb' : 'kg') as 'kg' | 'lb';
      const reps = verbose[3] ? takeHigh(verbose[3]) : null;
      out.push({ weight, unit, reps });
      continue;
    }
    const wxr = line.match(/(\d+(?:\.\d+)?)\s*(kgs?|lbs?|lb)?\s*[x×]\s*(\d+(?:\s*-\s*\d+)?)/i);
    if (wxr) {
      out.push({
        weight: parseFloat(wxr[1]),
        unit: ((wxr[2] ?? 'kg').toLowerCase().startsWith('lb') ? 'lb' : 'kg') as 'kg' | 'lb',
        reps: takeHigh(wxr[3]),
      });
      continue;
    }
    const wur = line.match(/(\d+(?:\.\d+)?)\s*(kgs?|lbs?|lb)\s+(\d+(?:\s*-\s*\d+)?)\s*reps?\b/i);
    if (wur) {
      out.push({
        weight: parseFloat(wur[1]),
        unit: (wur[2].toLowerCase().startsWith('lb') ? 'lb' : 'kg') as 'kg' | 'lb',
        reps: takeHigh(wur[3]),
      });
    }
  }
  return out;
}

function parseFile(file: Buffer | ArrayBuffer): {
  days: Day[];
  weekCols: { col: number; num: number }[];
  rows: unknown[][];
} {
  const wb = XLSX.read(file, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
  });

  const header = rows[0] ?? [];
  const weekCols: { col: number; num: number }[] = [];
  for (let c = FIRST_LOG_COL; c < header.length; c++) {
    const cell = String(header[c] ?? '').trim();
    const m = cell.match(/^week\s*(\d+)$/i);
    if (m) weekCols.push({ col: c, num: parseInt(m[1], 10) });
  }

  const days: Day[] = [];
  let cur: Day | null = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const a = String(row[0] ?? '').trim();
    const b = String(row[PRESCRIPTION_COL] ?? '').trim();
    if (!a && !b) continue;
    if (a && !b) {
      cur = { label: a, exercises: [], rowIdxByExName: new Map() };
      days.push(cur);
      continue;
    }
    if (a && b && cur) {
      const p = parsePrescription(b);
      if (!p) continue;
      const dayIdx = days.length; // 1-based — current day was just pushed
      const ex: Ex = {
        name: a,
        name_key: scopedKey(dayIdx, a),
        prescription_raw: b,
        prescribed_sets: p.sets,
        rep_min: p.rep_min,
        rep_max: p.rep_max,
        rir_target: p.rir,
        is_cardio: p.is_cardio,
        cardio_type: detectCardio(a),
      };
      cur.exercises.push(ex);
      cur.rowIdxByExName.set(ex.name_key, r);
    }
  }

  return { days, weekCols, rows };
}

function computeBests(
  days: Day[],
  weekCols: { col: number; num: number }[],
  rows: unknown[][]
): Map<string, Best> {
  const bests = new Map<string, Best>();
  for (const day of days) {
    for (const ex of day.exercises) {
      if (ex.is_cardio) continue;
      const rowIdx = day.rowIdxByExName.get(ex.name_key)!;
      const row = rows[rowIdx] ?? [];
      let cur: Best | null = null;
      for (const wc of weekCols) {
        const cell = String(row[wc.col] ?? '').trim();
        const sets = parseCellSets(cell);
        for (const s of sets) {
          if (s.weight == null || s.reps == null) continue;
          if (
            !cur ||
            s.weight > cur.weight ||
            (s.weight === cur.weight && s.reps > cur.reps)
          ) {
            cur = { weight: s.weight, unit: s.unit, reps: s.reps };
          }
        }
      }
      if (cur) {
        // Keep the best across all days that share the same name_key.
        const existing = bests.get(ex.name_key);
        if (
          !existing ||
          cur.weight > existing.weight ||
          (cur.weight === existing.weight && cur.reps > existing.reps)
        ) {
          bests.set(ex.name_key, cur);
        }
      }
    }
  }
  return bests;
}

// -------- Main --------
async function main() {
  const buf = readFileSync(resolve(xlsxPath));
  const { days, weekCols, rows } = parseFile(buf);
  const bests = computeBests(days, weekCols, rows);

  console.log(`Parsed: ${days.length} days, ${days.reduce((s, d) => s + d.exercises.length, 0)} exercises, ${bests.size} bests`);

  // Find client by PIN.
  const { data: clients, error: cErr } = await supa
    .from('clients')
    .select('id, name, pin_hash, active');
  if (cErr) throw cErr;
  let client: { id: string; name: string } | null = null;
  for (const c of clients ?? []) {
    if (await bcrypt.compare(PIN!, c.pin_hash)) {
      client = { id: c.id, name: c.name };
      break;
    }
  }
  if (!client) {
    console.error(`No client matched PIN ${PIN}.`);
    process.exit(1);
  }
  console.log(`Matched client: ${client.name} (${client.id})`);

  // Existing data check.
  const [{ data: existingPrograms }, { data: existingWorkouts }, { data: existingBests }] =
    await Promise.all([
      supa.from('programs').select('id').eq('client_id', client.id).eq('active', true),
      supa.from('workouts').select('id').eq('client_id', client.id),
      supa.from('best_efforts').select('exercise_name_key').eq('client_id', client.id),
    ]);

  const hasExisting =
    (existingPrograms?.length ?? 0) > 0 ||
    (existingWorkouts?.length ?? 0) > 0 ||
    (existingBests?.length ?? 0) > 0;

  if (hasExisting && !FORCE) {
    console.error(
      `Client already has program/workouts/bests. Re-run with --force to wipe and re-seed.`
    );
    process.exit(1);
  }

  // Compute week_starts.
  // CURRENT_WEEK = the program-week number that "this real-world week" represents.
  // This week's Monday = week_start for CURRENT_WEEK.
  // Earlier weeks step backward by 7 days each.
  const thisMonday = startOfWeek(new Date(), { weekStartsOn: 1 });
  function weekStartFor(programWeek: number): Date {
    const offset = CURRENT_WEEK - programWeek;
    return subWeeks(thisMonday, offset);
  }

  // Build the workout plan.
  const workoutsToInsert: { week: number; dayIdx: number; week_start: string; started_at: string; completed_at: string }[] = [];
  for (let w = 1; w <= CURRENT_WEEK; w++) {
    const isCurrent = w === CURRENT_WEEK;
    const dayCount = isCurrent ? DONE_DAYS : days.length;
    const ws = weekStartFor(w);
    for (let d = 0; d < dayCount; d++) {
      // started_at = the date of (Monday + d days), at 9am local
      const date = addDays(ws, d);
      date.setHours(9, 0, 0, 0);
      const completed = new Date(date.getTime() + 60 * 60 * 1000); // +1 hr
      workoutsToInsert.push({
        week: w,
        dayIdx: d,
        week_start: formatISO(ws, { representation: 'date' }),
        started_at: date.toISOString(),
        completed_at: completed.toISOString(),
      });
    }
  }

  console.log(`\n=== PLAN ===`);
  console.log(`  Insert program (active)`);
  console.log(`  Insert ${days.length} days, ${days.reduce((s, d) => s + d.exercises.length, 0)} exercises`);
  console.log(`  Insert ${bests.size} best_efforts rows`);
  console.log(`  Insert ${workoutsToInsert.length} skeleton workout rows`);
  console.log(`  Week range: ${weekStartFor(1).toDateString()} .. ${thisMonday.toDateString()}`);
  if (FORCE && hasExisting) {
    console.log(`  WIPE existing program/workouts/bests first (--force)`);
  }

  if (!APPLY) {
    console.log(`\nDry-run. Re-run with --apply to write.`);
    return;
  }

  // ---- WRITE ----
  if (FORCE && hasExisting) {
    console.log(`Wiping existing data...`);
    await supa.from('best_efforts').delete().eq('client_id', client.id);
    await supa.from('workouts').delete().eq('client_id', client.id);
    // programs cascade via days->exercises FKs
    await supa.from('programs').delete().eq('client_id', client.id);
  }

  console.log(`Inserting program...`);
  const { data: program, error: pErr } = await supa
    .from('programs')
    .insert({
      client_id: client.id,
      source_filename: xlsxPath.split(/[\\/]/).pop() ?? 'apply-history',
      active: true,
    })
    .select('id')
    .single();
  if (pErr || !program) throw pErr ?? new Error('program insert failed');

  // Days + exercises
  const dayIdByIndex = new Map<number, string>();
  for (const [i, day] of days.entries()) {
    const dayIndex = i + 1;
    const { data: dayRow, error: dErr } = await supa
      .from('days')
      .insert({ program_id: program.id, day_index: dayIndex, label: day.label })
      .select('id')
      .single();
    if (dErr || !dayRow) throw dErr ?? new Error('day insert failed');
    dayIdByIndex.set(i, dayRow.id);

    if (day.exercises.length > 0) {
      const rows = day.exercises.map((e, j) => ({
        day_id: dayRow.id,
        position: j + 1,
        name: e.name,
        name_key: e.name_key,
        prescription_raw: e.prescription_raw,
        prescribed_sets: e.prescribed_sets,
        rep_min: e.rep_min,
        rep_max: e.rep_max,
        rir_target: e.rir_target,
        is_cardio: e.is_cardio,
        cardio_type: e.cardio_type,
      }));
      const { error: eErr } = await supa.from('exercises').insert(rows);
      if (eErr) throw eErr;
    }
  }
  console.log(`  ✓ ${days.length} days + ${days.reduce((s, d) => s + d.exercises.length, 0)} exercises`);

  // Best efforts
  if (bests.size > 0) {
    const rows = [...bests.entries()].map(([key, b]) => ({
      client_id: client.id,
      exercise_name_key: key,
      best_weight: b.weight,
      best_unit: b.unit,
      best_reps: b.reps,
    }));
    const { error: bErr } = await supa.from('best_efforts').upsert(rows, {
      onConflict: 'client_id,exercise_name_key',
    });
    if (bErr) throw bErr;
    console.log(`  ✓ ${bests.size} best_efforts`);
  }

  // Skeleton workouts
  if (workoutsToInsert.length > 0) {
    const rows = workoutsToInsert.map((w) => ({
      client_id: client.id,
      day_id: dayIdByIndex.get(w.dayIdx)!,
      started_at: w.started_at,
      completed_at: w.completed_at,
      week_start: w.week_start,
      is_deload: false,
    }));
    const { error: wErr } = await supa.from('workouts').insert(rows);
    if (wErr) throw wErr;
    console.log(`  ✓ ${workoutsToInsert.length} skeleton workouts`);
  }

  console.log(`\nDone. Open the app as ${client.name} to verify.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
