/**
 * Look for clients with workout_started/completed alerts that no longer have
 * a corresponding workout row. Those are real sessions that fix-this-week
 * blew away.
 */
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '.env.local') });

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function main() {
  const { data: clients } = await supa.from('clients').select('id, name');
  for (const c of clients ?? []) {
    const { data: alerts } = await supa
      .from('alerts')
      .select('type, message, created_at, data')
      .eq('client_id', c.id)
      .in('type', ['workout_started', 'workout_completed'])
      .order('created_at', { ascending: false })
      .limit(20);
    if (!alerts?.length) continue;

    const ids = new Set<string>();
    for (const a of alerts) {
      const data = a.data as { workout_id?: string } | null;
      if (data?.workout_id) ids.add(data.workout_id);
    }
    if (!ids.size) continue;

    const { data: workouts } = await supa
      .from('workouts')
      .select('id, started_at, completed_at')
      .in('id', [...ids]);
    const present = new Set((workouts ?? []).map((w) => w.id));
    const missing = [...ids].filter((id) => !present.has(id));
    if (missing.length) {
      console.log(`\n${c.name} (${c.id})`);
      for (const m of missing) {
        const matching = alerts.filter(
          (a) => (a.data as { workout_id?: string } | null)?.workout_id === m
        );
        for (const a of matching) {
          console.log(`  MISSING workout ${m}  alert=${a.type}  at=${a.created_at?.slice(0, 19)}  ${a.message}`);
        }
      }
    }
  }
}

main().catch(console.error);
