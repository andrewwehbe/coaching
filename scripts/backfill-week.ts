/**
 * Insert skeleton workouts (started_at = 9am, completed_at = +1h) for a
 * client's current week so the dashboard "X/Y days" count matches reality.
 * Used when re-creating a profile loses the in-app workout history.
 *
 * Usage:
 *   npx tsx scripts/backfill-week.ts --pin <PIN> --days N [--apply]
 */
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';
import { startOfWeek, formatISO, addDays } from 'date-fns';

config({ path: resolve(process.cwd(), '.env.local') });

const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const PIN = flag('pin');
const DAYS = Number(flag('days'));
const APPLY = args.includes('--apply');
if (!PIN || !Number.isFinite(DAYS) || DAYS < 1) {
  console.error('Usage: npx tsx scripts/backfill-week.ts --pin <PIN> --days N [--apply]');
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
    .select('id, day_index')
    .eq('program_id', program.id)
    .order('day_index');
  if (!days || days.length < DAYS) {
    console.error(`Program has ${days?.length ?? 0} days but you asked for ${DAYS}`);
    process.exit(1);
  }

  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });

  const { data: existing } = await supa
    .from('workouts')
    .select('id, day_id')
    .eq('client_id', client.id)
    .eq('week_start', weekStartIso);
  const existingDayIds = new Set((existing ?? []).map((w) => w.day_id));

  const toInsert: { day_id: string; started_at: string; completed_at: string }[] = [];
  let calendarOffset = 0;
  for (const d of days) {
    if (toInsert.length + existingDayIds.size >= DAYS) break;
    if (existingDayIds.has(d.id)) continue;
    const date = addDays(weekStart, calendarOffset);
    date.setHours(9, 0, 0, 0);
    const completed = new Date(date.getTime() + 60 * 60 * 1000);
    toInsert.push({
      day_id: d.id,
      started_at: date.toISOString(),
      completed_at: completed.toISOString(),
    });
    calendarOffset++;
  }

  console.log(`Client: ${client.name}`);
  console.log(`Week start: ${weekStartIso}`);
  console.log(`Existing workouts this week: ${existing?.length ?? 0}`);
  console.log(`Insert ${toInsert.length} skeleton workouts → final count ${existingDayIds.size + toInsert.length}/${DAYS}`);

  if (!APPLY) {
    console.log('\nDry-run. Re-run with --apply.');
    return;
  }
  if (toInsert.length === 0) {
    console.log('Nothing to insert.');
    return;
  }
  const rows = toInsert.map((w) => ({
    client_id: client.id,
    day_id: w.day_id,
    started_at: w.started_at,
    completed_at: w.completed_at,
    week_start: weekStartIso,
    is_deload: false,
  }));
  const { error } = await supa.from('workouts').insert(rows);
  if (error) {
    console.error('insert failed', error);
    process.exit(1);
  }
  console.log(`Inserted ${rows.length} workouts.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
