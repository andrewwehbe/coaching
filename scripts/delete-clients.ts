/**
 * Delete clients by id. Cascading FKs in the schema (programs → days →
 * exercises, workouts → exercise_logs → sets, etc.) clean up downstream
 * data automatically. Sessions, devices, alerts, check_ins, best_efforts,
 * stalled_history, swap_proposals all cascade on client_id delete.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('Usage: npx tsx scripts/delete-clients.ts <id> [<id> ...]');
  process.exit(1);
}

async function main() {
  for (const id of ids) {
    const { data: c } = await supa
      .from('clients')
      .select('id, name')
      .eq('id', id)
      .maybeSingle();
    if (!c) {
      console.log(`  ${id} — not found, skipping`);
      continue;
    }
    const { error } = await supa.from('clients').delete().eq('id', id);
    if (error) {
      console.error(`  ${id} (${c.name}) — FAILED: ${error.message}`);
    } else {
      console.log(`  ${id} (${c.name}) — deleted`);
    }
  }
}
main();
