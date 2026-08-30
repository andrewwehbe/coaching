/**
 * Create a client AND their first program from a JSON spec, with a coach-
 * chosen PIN. Goes through the same write path as the app: bcrypt-12 PIN +
 * HMAC, commit_program RPC (one transaction), coach_note/muscle_group fill,
 * program_revisions v1 snapshot, audit_log rows.
 *
 * Dry-run by default: prints the plan, checks PIN/name are free, exits.
 * Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/create-client-with-program.ts --spec scripts/programs/<name>.json --pin <5-digit PIN> [--apply]
 *
 * Spec shape: see scripts/programs/ralf.json.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';

import { parsePrescription } from '../src/lib/sheet-parser';
import { nameKeyFor, normalize } from '../src/lib/exercise-name';

config({ path: resolve(process.cwd(), '.env.local') });

const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const SPEC_PATH = flag('spec');
const PIN = flag('pin');
const APPLY = args.includes('--apply');
// --update: the client already exists; rewrite their ACTIVE program in place
// from the spec (same path as the coach editor / program/save route). Day
// ids are kept by day_index, exercise ids are kept when the name matches
// within the same day, everything else is archived. Client fields and PIN
// are untouched.
const UPDATE = args.includes('--update');

if (!SPEC_PATH || (!UPDATE && (!PIN || !/^\d{4,6}$/.test(PIN)))) {
  console.error(
    'Usage:\n' +
      '  create: npx tsx scripts/create-client-with-program.ts --spec <file.json> --pin <4-6 digit PIN> [--apply]\n' +
      '  edit:   npx tsx scripts/create-client-with-program.ts --spec <file.json> --update [--apply]',
  );
  process.exit(1);
}

const MUSCLE_GROUPS = new Set([
  'chest', 'back', 'quads', 'hamstrings', 'glutes',
  'shoulders', 'biceps', 'triceps', 'calves', 'abs', 'other',
]);
const BW_FREQ = new Set(['none', 'daily', '3x', 'weekly']);
const EQUIPMENT = new Set(['full_gym', 'home_gym', 'dumbbells_only', 'bodyweight']);

type SpecExercise = {
  name: string;
  prescription_raw: string;
  coach_note?: string | null;
  muscle_group?: string | null;
};
type Spec = {
  name: string;
  greeting_name?: string | null;
  weekly_day_target?: number;
  body_weight_freq?: string;
  photo_check_in_enabled?: boolean;
  meal_plan_enabled?: boolean;
  equipment?: string | null;
  source_filename?: string;
  days: Array<{ label: string; exercises: SpecExercise[] }>;
};

const spec: Spec = JSON.parse(readFileSync(resolve(process.cwd(), SPEC_PATH), 'utf8'));

// ---- validate spec up front so nothing half-writes -------------------------
const problems: string[] = [];
if (!spec.name?.trim()) problems.push('spec.name is required');
if (!Array.isArray(spec.days) || spec.days.length === 0) problems.push('spec.days must be non-empty');
const target = spec.weekly_day_target ?? 4;
if (!Number.isInteger(target) || target < 1 || target > 7) problems.push('weekly_day_target must be 1-7');
const bwFreq = spec.body_weight_freq ?? 'none';
if (!BW_FREQ.has(bwFreq)) problems.push(`body_weight_freq "${bwFreq}" invalid`);
if (spec.equipment != null && !EQUIPMENT.has(spec.equipment)) problems.push(`equipment "${spec.equipment}" invalid`);
for (const [di, day] of (spec.days ?? []).entries()) {
  if (!day.label?.trim()) problems.push(`Day ${di + 1}: label required`);
  if (!day.exercises?.length) problems.push(`Day ${di + 1}: no exercises`);
  const seen = new Set<string>();
  for (const [ei, ex] of (day.exercises ?? []).entries()) {
    const where = `Day ${di + 1} #${ei + 1} "${ex.name}"`;
    if (!ex.name?.trim()) problems.push(`${where}: name required`);
    if (!parsePrescription(ex.prescription_raw ?? '')) problems.push(`${where}: prescription "${ex.prescription_raw}" invalid`);
    if (ex.muscle_group != null && !MUSCLE_GROUPS.has(ex.muscle_group)) problems.push(`${where}: muscle_group "${ex.muscle_group}" invalid`);
    const k = normalize(ex.name ?? '');
    if (seen.has(k)) problems.push(`${where}: duplicate exercise within the day`);
    seen.add(k);
  }
}
if (problems.length) {
  console.error('Spec invalid:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}

// ---- build the commit_program payload (mirrors sheet-parser key collation) --
// Same exercise name on a later day reuses the first day's name_key so
// best_efforts collate across the mirrored A/B sessions.
const nameToFirstKey = new Map<string, string>();
const daysPayload = spec.days.map((day, di) => {
  const dayIndex = di + 1;
  return {
    label: day.label.trim(),
    exercises: day.exercises.map((ex) => {
      const rx = parsePrescription(ex.prescription_raw)!;
      const dedupeKey = normalize(ex.name);
      let key = nameToFirstKey.get(dedupeKey);
      if (!key) {
        key = nameKeyFor(dayIndex, ex.name);
        nameToFirstKey.set(dedupeKey, key);
      }
      return {
        name: ex.name.trim(),
        name_key: key,
        prescription_raw: ex.prescription_raw.trim(),
        prescribed_sets: rx.sets,
        rep_min: rx.rep_min,
        rep_max: rx.rep_max,
        rir_target: rx.rir,
        is_cardio: rx.is_cardio,
        cardio_type: null as string | null,
        // Not consumed by commit_program; applied in a follow-up update.
        coach_note: ex.coach_note?.trim() || null,
        muscle_group: ex.muscle_group ?? null,
      };
    }),
  };
});

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function printPlan() {
  console.log(`\nClient: ${spec.name}  (greeting: ${spec.greeting_name ?? '-'})${UPDATE ? '  [UPDATE existing program]' : ''}`);
  if (!UPDATE) {
    console.log(`  target=${target}/wk  bw=${bwFreq}  photo=${!!spec.photo_check_in_enabled}  meal=${!!spec.meal_plan_enabled}  equipment=${spec.equipment ?? '-'}`);
    console.log(`  PIN: ${PIN}`);
  }
  console.log(`Program: ${spec.source_filename ?? '(no source_filename)'}`);
  for (const [di, d] of daysPayload.entries()) {
    console.log(`\n  D${di + 1} ${d.label}`);
    for (const [ei, e] of d.exercises.entries()) {
      console.log(`    ${ei + 1}. ${e.name} | ${e.prescription_raw} | ${e.muscle_group ?? '-'} | ${e.name_key}`);
      if (e.coach_note) console.log(`       note: ${e.coach_note}`);
    }
  }
  const total = daysPayload.reduce((n, d) => n + d.exercises.length, 0);
  console.log(`\n  ${daysPayload.length} days, ${total} exercises`);
}

type ExistingDay = {
  id: string;
  day_index: number;
  label: string;
  exercises: Array<{ id: string; position: number; name: string; name_key: string; archived_at: string | null }>;
};

async function updateProgram(coachId: string) {
  const { data: clients } = await supa
    .from('clients')
    .select('id, name, active')
    .ilike('name', spec.name.trim());
  if (!clients || clients.length !== 1) {
    console.error(`\nExpected exactly one client named "${spec.name}", found ${clients?.length ?? 0}. Refusing.`);
    process.exit(1);
  }
  const client = clients[0];

  const { data: program } = await supa
    .from('programs')
    .select('id')
    .eq('client_id', client.id)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!program) {
    console.error(`\n${client.name} has no active program. Use create mode instead.`);
    process.exit(1);
  }

  const { data: existingDays } = await supa
    .from('days')
    .select('id, day_index, label, exercises(id, position, name, name_key, archived_at)')
    .eq('program_id', program.id)
    .order('day_index');
  const byIndex = new Map<number, ExistingDay>();
  for (const d of (existingDays ?? []) as ExistingDay[]) byIndex.set(d.day_index, d);

  // Days are never deleted (workouts FK them). If the spec has fewer days
  // than the program, refuse rather than silently leave stale days live.
  if (byIndex.size > daysPayload.length) {
    console.error(`\nProgram has ${byIndex.size} days but spec has ${daysPayload.length}. Days cannot be removed here; refusing.`);
    process.exit(1);
  }

  const incomingIds = new Set<string>();
  const keyMigrations: Array<{ oldKey: string; newKey: string }> = [];
  const summary: string[] = [];

  const p_days = daysPayload.map((day, di) => {
    const dayIndex = di + 1;
    const existing = byIndex.get(dayIndex);
    const dayId = existing?.id ?? randomUUID();
    const live = (existing?.exercises ?? []).filter((e) => !e.archived_at);
    const byName = new Map<string, (typeof live)[number]>();
    for (const e of live) if (!byName.has(normalize(e.name))) byName.set(normalize(e.name), e);

    const exercises = day.exercises.map((ex, ei) => {
      const match = byName.get(normalize(ex.name));
      const exId = match?.id ?? randomUUID();
      if (match) {
        incomingIds.add(match.id);
        byName.delete(normalize(ex.name));
        if (match.name_key !== ex.name_key) keyMigrations.push({ oldKey: match.name_key, newKey: ex.name_key });
      }
      summary.push(`  D${dayIndex} ${ei + 1}. ${match ? 'keep' : 'NEW '} ${ex.name}${match && match.position !== ei + 1 ? ` (was #${match.position})` : ''}`);
      return {
        id: exId,
        is_new: !match,
        position: ei + 1,
        name: ex.name,
        name_key: ex.name_key,
        prescription_raw: ex.prescription_raw,
        prescribed_sets: ex.prescribed_sets,
        rep_min: ex.rep_min,
        rep_max: ex.rep_max,
        rir_target: ex.rir_target,
        is_cardio: ex.is_cardio,
        coach_note: ex.coach_note,
        muscle_group: ex.muscle_group,
      };
    });
    return { id: dayId, is_new: !existing, day_index: dayIndex, label: day.label, exercises };
  });

  const archiveIds: string[] = [];
  for (const d of byIndex.values()) {
    for (const e of d.exercises) {
      if (e.archived_at || incomingIds.has(e.id)) continue;
      archiveIds.push(e.id);
      summary.push(`  D${d.day_index} ARCHIVE ${e.name}`);
    }
  }

  console.log(`\nEdit plan for program ${program.id}:`);
  console.log(summary.join('\n'));
  if (keyMigrations.length) {
    console.log(`  name_key changes: ${keyMigrations.map((m) => `${m.oldKey} -> ${m.newKey}`).join(', ')}`);
  }

  if (!APPLY) {
    console.log('\nDry run: nothing written. Re-run with --apply to write.');
    return;
  }

  const { data, error } = await supa.rpc('save_program_edit', {
    p_client_id: client.id,
    p_program_id: program.id,
    p_days,
    p_archive_ids: archiveIds,
  });
  const res = data as { ok?: true; error?: string } | null;
  if (error || !res?.ok) {
    console.error('\nsave_program_edit failed:', error ?? res);
    process.exit(1);
  }
  console.log('\nsave_program_edit ok');

  // Best-effort key migration: copy (never delete) a PR under the old key
  // to the new key when the new key has none yet. Mirrors lib/best-effort
  // migrateBestEffortKey's simple case; a conflict is left for the coach.
  for (const m of keyMigrations) {
    const { data: old } = await supa
      .from('best_efforts')
      .select('best_weight, best_unit, best_reps, source_set_id')
      .eq('client_id', client.id)
      .eq('exercise_name_key', m.oldKey)
      .maybeSingle();
    if (!old) continue;
    const { data: exists } = await supa
      .from('best_efforts')
      .select('exercise_name_key')
      .eq('client_id', client.id)
      .eq('exercise_name_key', m.newKey)
      .maybeSingle();
    if (exists) {
      console.log(`  best_effort kept: ${m.newKey} already has a PR; ${m.oldKey} left as is`);
      continue;
    }
    const { error: ce } = await supa
      .from('best_efforts')
      .insert({ client_id: client.id, exercise_name_key: m.newKey, ...old });
    console.log(`  best_effort ${ce ? 'copy FAILED: ' + ce.message : 'copied'} ${m.oldKey} -> ${m.newKey}`);
  }

  await recordRevision(program.id, coachId, 'edit');

  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: coachId,
    action: 'program.edit',
    target_type: 'program',
    target_id: program.id,
    details: {
      client_id: client.id,
      day_count: p_days.length,
      exercise_count: p_days.reduce((n, d) => n + d.exercises.length, 0),
      archived: archiveIds.length,
      via: 'scripts/create-client-with-program.ts --update',
    },
  });
  console.log(`\nDone. ${client.name}'s program updated (${archiveIds.length} archived).`);
}

async function recordRevision(programId: string, coachId: string, reason: 'sheet_upload' | 'edit') {
  const { data: snapDays } = await supa
    .from('days')
    .select(
      'id, day_index, label, exercises(id, position, name, name_key, prescription_raw, prescribed_sets, rep_min, rep_max, rir_target, is_cardio, coach_note, muscle_group, archived_at)',
    )
    .eq('program_id', programId)
    .order('day_index');
  const snapshot = (snapDays ?? []).map((d) => ({
    day_id: d.id,
    day_index: d.day_index,
    label: d.label,
    exercises: ((d.exercises ?? []) as Array<{ position: number }>).slice().sort((a, b) => a.position - b.position),
  }));
  const { data: latest } = await supa
    .from('program_revisions')
    .select('version_number')
    .eq('program_id', programId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (latest?.version_number ?? 0) + 1;
  const { error } = await supa.from('program_revisions').insert({
    program_id: programId,
    version_number: version,
    edited_by: coachId,
    reason,
    snapshot,
  });
  if (error) console.error('  revision snapshot failed (non-fatal):', error.message);
  else console.log(`Recorded program revision v${version}`);
}

async function main() {
  printPlan();

  if (UPDATE) {
    const { data: coaches } = await supa.from('coaches').select('id').limit(1);
    if (!coaches?.[0]) {
      console.error('\nNo coach row found; cannot attribute audit/revision.');
      process.exit(1);
    }
    await updateProgram(coaches[0].id);
    return;
  }

  // Refuse to create a second client with the same name.
  const { data: dupes } = await supa.from('clients').select('id, name, active').ilike('name', spec.name.trim());
  if (dupes && dupes.length) {
    console.error(`\nA client named "${spec.name}" already exists (${dupes.map((d) => `${d.id.slice(0, 8)} active=${d.active}`).join(', ')}). Refusing.`);
    process.exit(1);
  }

  // PIN collision check across all coaches + clients (same rule as lib/pin.ts).
  const [{ data: coaches }, { data: clients }] = await Promise.all([
    supa.from('coaches').select('id, name, pin_hash'),
    supa.from('clients').select('id, name, pin_hash'),
  ]);
  for (const r of [...(coaches ?? []), ...(clients ?? [])]) {
    if (await bcrypt.compare(PIN!, r.pin_hash)) {
      console.error(`\nPIN ${PIN} already in use by ${r.name} (${r.id}). Refusing.`);
      process.exit(1);
    }
  }
  const coach = coaches?.[0];
  if (!coach) {
    console.error('\nNo coach row found; cannot attribute audit/revision.');
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDry run: PIN is free, name is free, spec is valid. Re-run with --apply to write.');
    return;
  }

  // 1. Client
  const hash = await bcrypt.hash(PIN!, 12);
  const hmacKey = process.env.PIN_HMAC_KEY;
  const hmac = hmacKey ? createHmac('sha256', hmacKey).update(PIN!).digest('hex') : null;
  const { data: client, error: cErr } = await supa
    .from('clients')
    .insert({
      name: spec.name.trim(),
      greeting_name: spec.greeting_name?.trim() || null,
      pin_hash: hash,
      pin_hmac: hmac,
      weekly_day_target: target,
      body_weight_freq: bwFreq,
      photo_check_in_enabled: !!spec.photo_check_in_enabled,
      meal_plan_enabled: !!spec.meal_plan_enabled,
      equipment: spec.equipment ?? null,
    })
    .select('id, name')
    .single();
  if (cErr || !client) {
    console.error('\nClient insert failed:', cErr);
    process.exit(1);
  }
  console.log(`\nCreated client ${client.name} ${client.id}`);
  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: coach.id,
    action: 'create_client',
    target_type: 'client',
    target_id: client.id,
    details: { name: client.name, via: 'scripts/create-client-with-program.ts' },
  });

  // 2. Program (one transaction in Postgres)
  const programId = randomUUID();
  const { data: rpc, error: pErr } = await supa.rpc('commit_program', {
    p_client_id: client.id,
    p_program_id: programId,
    p_source_filename: spec.source_filename ?? `${spec.name} (coach build)`,
    p_days: daysPayload,
  });
  const rpcResult = rpc as { ok?: true; error?: string } | null;
  if (pErr || !rpcResult?.ok) {
    console.error('\ncommit_program failed:', pErr ?? rpcResult);
    console.error(`Client ${client.id} was created without a program. Fix by re-running the program step or deleting the client.`);
    process.exit(1);
  }
  console.log(`Committed program ${programId}`);

  // 3. coach_note + muscle_group (commit_program doesn't take them)
  const { data: days, error: dErr } = await supa
    .from('days')
    .select('id, day_index, exercises(id, position)')
    .eq('program_id', programId)
    .order('day_index');
  if (dErr || !days) {
    console.error('\nCould not read back days:', dErr);
    process.exit(1);
  }
  let filled = 0;
  for (const d of days) {
    const src = daysPayload[d.day_index - 1];
    for (const ex of d.exercises as Array<{ id: string; position: number }>) {
      const s = src.exercises[ex.position - 1];
      if (!s.coach_note && !s.muscle_group) continue;
      const { error } = await supa
        .from('exercises')
        .update({ coach_note: s.coach_note, muscle_group: s.muscle_group })
        .eq('id', ex.id);
      if (error) {
        console.error(`  note/muscle_group update failed for ${s.name}:`, error.message);
      } else {
        filled++;
      }
    }
  }
  console.log(`Filled coach_note/muscle_group on ${filled} exercises`);

  // 4. Revision v1 snapshot (same shape as lib/program-revision.ts)
  await recordRevision(programId, coach.id, 'sheet_upload');

  // 5. Audit
  await supa.from('audit_log').insert({
    actor_type: 'coach',
    actor_id: coach.id,
    action: 'program.upload',
    target_type: 'program',
    target_id: programId,
    details: {
      client_id: client.id,
      filename: spec.source_filename ?? null,
      day_count: daysPayload.length,
      exercise_count: daysPayload.reduce((n, d) => n + d.exercises.length, 0),
      via: 'scripts/create-client-with-program.ts',
    },
  });

  console.log(`\nDone. ${client.name} can log in with PIN ${PIN}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
