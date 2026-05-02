/**
 * Make one day mirror another. Replaces the destination day's exercises
 * with copies of the source day's, using the SAME name_key so best_efforts
 * apply to both days. Useful when a coach set up a 2-day program but the
 * client actually does the same workout twice per week.
 *
 * Usage:
 *   npx tsx scripts/mirror-day.ts --pin <PIN> --src <dayIndex> --dst <dayIndex>
 *   add --apply to write
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
const SRC = Number(flag('src'));
const DST = Number(flag('dst'));
const APPLY = args.includes('--apply');
if (!PIN || !Number.isFinite(SRC) || !Number.isFinite(DST)) {
  console.error('Usage: npx tsx scripts/mirror-day.ts --pin <PIN> --src <dayIndex> --dst <dayIndex> [--apply]');
  process.exit(1);
}

async function main() {
  const supa = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data: clients } = await supa.from('clients').select('id, name, pin_hash');
  let client: { id: string; name: string } | null = null;
  for (const c of clients ?? []) {
    if (await bcrypt.compare(PIN!, c.pin_hash)) {
      client = { id: c.id, name: c.name };
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
  const dst = (days ?? []).find((d) => d.day_index === DST);
  if (!src || !dst) {
    console.error(`Src day ${SRC} or dst day ${DST} not found. Days: ${days?.map((d) => d.day_index).join(',')}`);
    process.exit(1);
  }

  const { data: srcEx } = await supa
    .from('exercises')
    .select('position, name, name_key, prescription_raw, prescribed_sets, rep_min, rep_max, rir_target, is_cardio, cardio_type, coach_note')
    .eq('day_id', src.id)
    .order('position');

  const { data: dstEx } = await supa.from('exercises').select('id, name').eq('day_id', dst.id);

  console.log(`Client: ${client.name}`);
  console.log(
    `Mirror Day ${SRC} (${src.label}, ${srcEx?.length ?? 0} ex) → Day ${DST} (${dst.label}, ${dstEx?.length ?? 0} ex currently)`
  );

  if (!APPLY) {
    console.log('\nDry-run. Re-run with --apply to write.');
    return;
  }

  await supa.from('exercises').delete().eq('day_id', dst.id);

  const { data: orphanBests } = await supa
    .from('best_efforts')
    .select('exercise_name_key')
    .eq('client_id', client.id)
    .like('exercise_name_key', `d${DST}::%`);
  if (orphanBests && orphanBests.length) {
    await supa
      .from('best_efforts')
      .delete()
      .eq('client_id', client.id)
      .in('exercise_name_key', orphanBests.map((b) => b.exercise_name_key));
    console.log(`  cleaned ${orphanBests.length} orphan bests scoped to d${DST}::`);
  }

  if (srcEx && srcEx.length) {
    const rows = srcEx.map((e) => ({
      day_id: dst.id,
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

  await supa.from('days').update({ label: src.label }).eq('id', dst.id);

  console.log(`Day ${DST} now mirrors Day ${SRC}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
