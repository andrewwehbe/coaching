/**
 * Append a new day to a client's program that mirrors an existing day —
 * same exercises, same name_keys (so best_efforts apply across both).
 * Optionally bump the client's weekly_day_target.
 *
 * Usage:
 *   npx tsx scripts/add-mirror-day.ts --pin <PIN> --mirror-of <dayIndex> [--weekly-target N] [--apply]
 */
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '.env.local') });

const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const PIN = flag('pin');
const SRC = Number(flag('mirror-of'));
const TARGET = flag('weekly-target') ? Number(flag('weekly-target')) : null;
const APPLY = args.includes('--apply');
if (!PIN || !Number.isFinite(SRC)) {
  console.error('Usage: npx tsx scripts/add-mirror-day.ts --pin <PIN> --mirror-of <dayIndex> [--weekly-target N] [--apply]');
  process.exit(1);
}

async function main() {
  const supa = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data: clients } = await supa.from('clients').select('id, name, pin_hash, weekly_day_target');
  let client: { id: string; name: string; weekly_day_target: number } | null = null;
  for (const c of clients ?? []) {
    if (await bcrypt.compare(PIN!, c.pin_hash)) {
      client = { id: c.id, name: c.name, weekly_day_target: c.weekly_day_target };
      break;
    }
  }
  if (!client) {
    console.error(`No client matched PIN ${PIN}`);
    process.exit(1);
  }

  const { data: program } = await supa
    .from('programs')
    .select('id')
    .eq('client_id', client.id)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!program) {
    console.error('No active program');
    process.exit(1);
  }

  const { data: days } = await supa
    .from('days')
    .select('id, day_index, label')
    .eq('program_id', program.id)
    .order('day_index');
  const src = (days ?? []).find((d) => d.day_index === SRC);
  if (!src) {
    console.error(`Src day ${SRC} not found. Days: ${days?.map((d) => d.day_index).join(',')}`);
    process.exit(1);
  }
  const nextIndex = Math.max(...(days ?? []).map((d) => d.day_index)) + 1;

  const { data: srcEx } = await supa
    .from('exercises')
    .select('position, name, name_key, prescription_raw, prescribed_sets, rep_min, rep_max, rir_target, is_cardio, cardio_type, coach_note')
    .eq('day_id', src.id)
    .order('position');

  console.log(`Client: ${client.name} (current weekly_day_target=${client.weekly_day_target})`);
  console.log(`Append Day ${nextIndex} mirroring Day ${SRC} (${src.label}, ${srcEx?.length ?? 0} ex)`);
  if (TARGET != null) console.log(`Set weekly_day_target → ${TARGET}`);

  if (!APPLY) {
    console.log('\nDry-run. Re-run with --apply.');
    return;
  }

  const { data: newDay } = await supa
    .from('days')
    .insert({ program_id: program.id, day_index: nextIndex, label: src.label })
    .select('id')
    .single();
  if (!newDay) {
    console.error('Failed to insert day');
    process.exit(1);
  }
  if (srcEx && srcEx.length) {
    const rows = srcEx.map((e) => ({
      day_id: newDay.id,
      position: e.position,
      name: e.name,
      name_key: e.name_key,
      prescription_raw: e.prescription_raw,
      prescribed_sets: e.prescribed_sets,
      rep_min: e.rep_min,
      rep_max: e.rep_max,
      rir_target: e.rir_target,
      is_cardio: e.is_cardio,
      cardio_type: e.cardio_type,
      coach_note: e.coach_note,
    }));
    await supa.from('exercises').insert(rows);
  }
  if (TARGET != null) {
    await supa.from('clients').update({ weekly_day_target: TARGET }).eq('id', client.id);
  }
  console.log(`Day ${nextIndex} added (mirrors Day ${SRC}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
