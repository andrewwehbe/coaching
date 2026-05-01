/**
 * Seed dev data: 1 coach (PIN 12345), 1 client "Test Client" (PIN 67890),
 * and a hand-coded 4-day program.
 *
 * Usage:
 *   1. Fill in .env.local with NEXT_PUBLIC_SUPABASE_URL and
 *      SUPABASE_SERVICE_ROLE_KEY.
 *   2. Run the SQL migration in supabase/migrations/0001_init.sql.
 *   3. Run: npx tsx scripts/seed.ts
 *
 * Safe to re-run: it deletes existing rows for the seeded coach + client
 * by name first.
 */
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supa = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COACH_PIN = '12345';
const CLIENT_PIN = '67890';
const COACH_NAME = 'Andrew';
const CLIENT_NAME = 'Test Client';

async function main() {
  const coachHash = await bcrypt.hash(COACH_PIN, 12);
  const clientHash = await bcrypt.hash(CLIENT_PIN, 12);

  // Wipe any prior seed.
  await supa.from('clients').delete().eq('name', CLIENT_NAME);
  await supa.from('coaches').delete().eq('name', COACH_NAME);

  const { data: coach, error: coachErr } = await supa
    .from('coaches')
    .insert({ name: COACH_NAME, pin_hash: coachHash })
    .select()
    .single();
  if (coachErr) throw coachErr;
  console.log('Coach seeded:', coach!.id, '— PIN:', COACH_PIN);

  const { data: client, error: clientErr } = await supa
    .from('clients')
    .insert({
      name: CLIENT_NAME,
      pin_hash: clientHash,
      weekly_day_target: 4,
      photo_check_in_enabled: true,
      body_weight_freq: 'weekly',
    })
    .select()
    .single();
  if (clientErr) throw clientErr;
  console.log('Client seeded:', client!.id, '— PIN:', CLIENT_PIN);

  const { data: program } = await supa
    .from('programs')
    .insert({ client_id: client!.id, source_filename: 'seed', active: true })
    .select()
    .single();

  type Ex = {
    name: string;
    rx: string;
    sets: number;
    rmin: number;
    rmax: number;
    rir: string;
  };
  const days: { label: string; exercises: Ex[] }[] = [
    {
      label: 'Day 1 - Torso A',
      exercises: [
        { name: 'Incline Dumbbell Press', rx: '3x5-8 @4 RIR', sets: 3, rmin: 5, rmax: 8, rir: '4' },
        { name: 'Single Arm Lat Pulldown', rx: '3x6-10 @3 RIR', sets: 3, rmin: 6, rmax: 10, rir: '3' },
        { name: 'Single Arm Cable Row', rx: '3x6-10 @3 RIR', sets: 3, rmin: 6, rmax: 10, rir: '3' },
        { name: 'Lateral Raise', rx: '3x8-10 @3 RIR', sets: 3, rmin: 8, rmax: 10, rir: '3' },
        { name: 'Cable Face Pull', rx: '2x8-10 @3 RIR', sets: 2, rmin: 8, rmax: 10, rir: '3' },
      ],
    },
    {
      label: 'Day 2 - Limbs A',
      exercises: [
        { name: 'Pendulum Squat', rx: '3x5-8 @4 RIR', sets: 3, rmin: 5, rmax: 8, rir: '4' },
        { name: 'SLDL', rx: '2x5-8 @4 RIR', sets: 2, rmin: 5, rmax: 8, rir: '4' },
        { name: 'Leg Extension', rx: '2x8-10 @3 RIR', sets: 2, rmin: 8, rmax: 10, rir: '3' },
        { name: 'Lying Hamstring Curl', rx: '3x8-10 @3 RIR', sets: 3, rmin: 8, rmax: 10, rir: '3' },
        { name: 'Overhead V-Bar Tricep Extension', rx: '3x8-10 @3 RIR', sets: 3, rmin: 8, rmax: 10, rir: '3' },
        { name: 'Bayesian Curl', rx: '2x8-10 @3 RIR', sets: 2, rmin: 8, rmax: 10, rir: '3' },
      ],
    },
    {
      label: 'Day 3 - Torso B',
      exercises: [
        { name: 'Chest Press Machine', rx: '3x5-8 @4 RIR', sets: 3, rmin: 5, rmax: 8, rir: '4' },
        { name: 'Lat Pulldown Machine', rx: '3x6-10 @3 RIR', sets: 3, rmin: 6, rmax: 10, rir: '3' },
        { name: 'Chest Supported Row', rx: '3x6-10 @3 RIR', sets: 3, rmin: 6, rmax: 10, rir: '3' },
        { name: 'Lateral Raise', rx: '3x8-10 @3 RIR', sets: 3, rmin: 8, rmax: 10, rir: '3' },
        { name: 'Cable Face Pull', rx: '2x8-10 @3 RIR', sets: 2, rmin: 8, rmax: 10, rir: '3' },
      ],
    },
    {
      label: 'Day 4 - Limbs B',
      exercises: [
        { name: 'Hack Squat', rx: '3x6-10 @3 RIR', sets: 3, rmin: 6, rmax: 10, rir: '3' },
        { name: 'SLDL', rx: '2x5-8 @4 RIR', sets: 2, rmin: 5, rmax: 8, rir: '4' },
        { name: 'Leg Extension', rx: '2x8-10 @3 RIR', sets: 2, rmin: 8, rmax: 10, rir: '3' },
        { name: 'Lying Hamstring Curl', rx: '3x8-10 @3 RIR', sets: 3, rmin: 8, rmax: 10, rir: '3' },
        { name: 'V-Bar Tricep Extension', rx: '2x8-10 @3 RIR', sets: 2, rmin: 8, rmax: 10, rir: '3' },
        { name: 'Incline Bench Dumbbell Curl', rx: '2x8-10 @3 RIR', sets: 2, rmin: 8, rmax: 10, rir: '3' },
      ],
    },
  ];

  for (const [i, d] of days.entries()) {
    const { data: day } = await supa
      .from('days')
      .insert({ program_id: program!.id, day_index: i + 1, label: d.label })
      .select()
      .single();

    const rows = d.exercises.map((e, j) => ({
      day_id: day!.id,
      position: j + 1,
      name: e.name,
      name_key: e.name.trim().toLowerCase(),
      prescription_raw: e.rx,
      prescribed_sets: e.sets,
      rep_min: e.rmin,
      rep_max: e.rmax,
      rir_target: e.rir,
    }));
    await supa.from('exercises').insert(rows);
  }

  console.log('\nSeed complete. Login PINs:');
  console.log('  Coach (Andrew):       ', COACH_PIN);
  console.log('  Client (Test Client): ', CLIENT_PIN);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
