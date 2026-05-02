/**
 * One-off: set the (single) coach's PIN. Bcrypt-hashed before write.
 * Usage: npx tsx scripts/set-coach-pin.ts <new-PIN>
 */
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '.env.local') });

const PIN = process.argv[2];
if (!PIN || !/^\d{4,6}$/.test(PIN)) {
  console.error('Usage: npx tsx scripts/set-coach-pin.ts <4-6 digit PIN>');
  process.exit(1);
}

async function main() {
  const supa = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data: coaches } = await supa.from('coaches').select('id, name');
  if (!coaches?.length) {
    console.error('No coach row found.');
    process.exit(1);
  }
  if (coaches.length > 1) {
    console.error('Multiple coaches found — refusing to update all.');
    process.exit(1);
  }
  const c = coaches[0];
  const hash = await bcrypt.hash(PIN, 12);
  const { error } = await supa
    .from('coaches')
    .update({ pin_hash: hash, pin_attempts: 0, pin_locked_until: null })
    .eq('id', c.id);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`Updated PIN for ${c.name}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
