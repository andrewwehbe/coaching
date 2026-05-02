import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function main() {
  const { data } = await supa
    .from('clients')
    .select('id, name, active, photo_check_in_enabled, body_weight_freq, weekly_day_target, created_at')
    .order('created_at', { ascending: true });
  for (const c of data ?? []) {
    console.log(
      `  ${c.id.slice(0, 8)}  ${c.name.padEnd(20)}  active=${c.active}  photo=${c.photo_check_in_enabled}  bw=${c.body_weight_freq}  d=${c.weekly_day_target}  ${c.created_at.slice(0, 16)}`
    );
  }
}
main();
