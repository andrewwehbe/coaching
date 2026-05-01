import * as XLSX from 'xlsx';

import { normalize } from './exercise-name';

export type ParsedExercise = {
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

export type ParsedDay = {
  label: string;
  exercises: ParsedExercise[];
};

export type ParsedProgram = {
  days: ParsedDay[];
};

export type ParseError = {
  row: number;
  message: string;
};

export type ParseResult =
  | { ok: true; program: ParsedProgram }
  | { ok: false; errors: ParseError[] };

const PRESCRIPTION_COL = 1;

const PRESCRIPTION_RE =
  /^\s*(\d+)\s*x\s*(\d+)(?:\s*-\s*(\d+))?\s*(?:@\s*([^\s]+(?:\s+[^\s]+)*?))?\s*$/i;
const CARDIO_RE = /^\s*(\d+)\s*x\s*(\d+)\s*min\b/i;

export function parseSheet(file: ArrayBuffer | Buffer): ParseResult {
  const errors: ParseError[] = [];

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file, { type: 'buffer' });
  } catch {
    return {
      ok: false,
      errors: [{ row: 0, message: 'Could not read file as a spreadsheet.' }],
    };
  }

  if (!workbook.SheetNames.length) {
    return { ok: false, errors: [{ row: 0, message: 'Workbook contains no sheets.' }] };
  }

  // Match Apps Script behavior: program lives on the LAST sheet.
  const sheet = workbook.Sheets[workbook.SheetNames[workbook.SheetNames.length - 1]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
  });

  if (rows.length === 0) {
    return { ok: false, errors: [{ row: 0, message: 'Sheet is empty.' }] };
  }

  const header = rows[0] ?? [];
  const weekHeaders: { col: number; num: number }[] = [];
  for (let c = 0; c < header.length; c++) {
    const cell = String(header[c] ?? '').trim();
    const m = cell.match(/^week\s*(\d+)$/i);
    if (m) weekHeaders.push({ col: c, num: parseInt(m[1], 10) });
  }

  if (weekHeaders.length === 0) {
    errors.push({
      row: 1,
      message: 'No "Week N" headers found in row 1.',
    });
    return { ok: false, errors };
  }

  const days: ParsedDay[] = [];
  let currentDay: ParsedDay | null = null;
  let currentDayRow = -1;
  const seenInDay = new Set<string>();

  // Some sheets put the first day label in col A of the header row alongside
  // the "Week N" headers (e.g. "Lower posterior + upper anterior"). If row 0's
  // col A is non-empty, isn't itself a Week header, and col B is empty, treat
  // it as the first implicit day.
  const headerColA = String(header[0] ?? '').trim();
  const headerColB = String(header[PRESCRIPTION_COL] ?? '').trim();
  if (
    headerColA &&
    !headerColB &&
    !/^week\s*\d+$/i.test(headerColA) &&
    headerColA.toLowerCase() !== 'name'
  ) {
    currentDay = { label: headerColA, exercises: [] };
    currentDayRow = 0;
    days.push(currentDay);
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const a = String(row[0] ?? '').trim();
    const b = String(row[PRESCRIPTION_COL] ?? '').trim();

    if (!a && !b) continue;

    if (a && !b) {
      if (currentDay && currentDay.exercises.length === 0) {
        errors.push({
          row: currentDayRow + 1,
          message: `Day "${currentDay.label}" has no exercises.`,
        });
      }
      currentDay = { label: a, exercises: [] };
      currentDayRow = r;
      seenInDay.clear();
      days.push(currentDay);
      continue;
    }

    if (!a && b) {
      errors.push({
        row: r + 1,
        message: 'Row has a prescription but no exercise name.',
      });
      continue;
    }

    if (!currentDay) {
      errors.push({
        row: r + 1,
        message: `Exercise "${a}" appears before any day header.`,
      });
      continue;
    }

    if (!b) {
      errors.push({
        row: r + 1,
        message: `Exercise "${a}" is missing a prescription.`,
      });
      continue;
    }

    const parsed = parsePrescription(b);
    if (!parsed) {
      errors.push({
        row: r + 1,
        message: `Exercise "${a}" has an unrecognized prescription "${b}". Expected "<sets>x<reps>" or "<sets>x<min>-<max>" with optional "@N RIR" or "<sets>x<min> min" for cardio.`,
      });
      continue;
    }

    const key = normalize(a);
    if (seenInDay.has(key)) {
      errors.push({
        row: r + 1,
        message: `Duplicate exercise "${a}" in day "${currentDay.label}".`,
      });
      continue;
    }
    seenInDay.add(key);

    currentDay.exercises.push({
      name: a,
      name_key: key,
      prescription_raw: b,
      prescribed_sets: parsed.sets,
      rep_min: parsed.rep_min,
      rep_max: parsed.rep_max,
      rir_target: parsed.rir,
      is_cardio: parsed.is_cardio,
      cardio_type: detectCardioType(a),
    });
  }

  if (currentDay && currentDay.exercises.length === 0) {
    errors.push({
      row: currentDayRow + 1,
      message: `Day "${currentDay.label}" has no exercises.`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (days.length === 0) {
    return { ok: false, errors: [{ row: 0, message: 'No day headers found in sheet.' }] };
  }

  return { ok: true, program: { days } };
}

type ParsedPrescription = {
  sets: number;
  rep_min: number | null;
  rep_max: number | null;
  rir: string | null;
  is_cardio: boolean;
};

function parsePrescription(raw: string): ParsedPrescription | null {
  const text = raw.trim();
  const cardio = text.match(CARDIO_RE);
  if (cardio) {
    return {
      sets: parseInt(cardio[1], 10),
      rep_min: parseInt(cardio[2], 10),
      rep_max: parseInt(cardio[2], 10),
      rir: null,
      is_cardio: true,
    };
  }

  const m = text.match(PRESCRIPTION_RE);
  if (!m) return null;

  const sets = parseInt(m[1], 10);
  const lo = parseInt(m[2], 10);
  const hi = m[3] ? parseInt(m[3], 10) : lo;
  const tail = (m[4] ?? '').trim();

  let rir: string | null = null;
  if (tail) {
    const rirMatch = tail.match(/^(\d+(?:\s*-\s*\d+)?)\s*rir\b/i);
    if (rirMatch) rir = rirMatch[1].replace(/\s+/g, '');
    else return null;
  }

  return {
    sets,
    rep_min: lo,
    rep_max: hi,
    rir,
    is_cardio: false,
  };
}

function detectCardioType(
  name: string
): 'treadmill' | 'elliptical' | 'stairmaster' | null {
  const n = name.toLowerCase();
  if (/\btreadmill\b/.test(n)) return 'treadmill';
  if (/\belliptical\b/.test(n)) return 'elliptical';
  if (/\bstair\s*master\b|\bstairmaster\b|\bstair[-\s]*climber\b/.test(n)) return 'stairmaster';
  return null;
}
