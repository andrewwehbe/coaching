/**
 * Resurrect workout shells whose IDs appear in alerts.data.workout_id but no
 * longer have a row in workouts. This brings the in-app history count back
 * for clients I accidentally wiped with fix-this-week. The set/log data is
 * unrecoverable — only the workout shell with started_at, completed_at,
 * day_id, and the original UUID gets restored.
 */
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { startOfWeek, formatISO } from 'date-fns';

config({ path: resolve(process.cwd(), '.env.local') });

const APPLY = process.argv.includes('--apply');

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
      .limit(40);
    if (!alerts?.length) continue;

    // Group alerts by workout_id, keeping started_at + completed_at + day_id.
    type Plan = { startedAt?: string; completedAt?: string; dayId?: string };
    const byWorkoutId = new Map<string, Plan>();
    for (const a of alerts) {
      const data = a.data as { workout_id?: string; day_id?: string } | null;
      if (!data?.workout_id) continue;
      const cur = byWorkoutId.get(data.workout_id) ?? {};
      if (a.type === 'workout_started' && !cur.startedAt) {
        cur.startedAt = a.created_at as string;
        if (data.day_id) cur.dayId = data.day_id;
      }
      if (a.type === 'workout_completed' && !cur.completedAt) {
        cur.completedAt = a.created_at as string;
      }
      byWorkoutId.set(data.workout_id, cur);
    }

    const ids = [...byWorkoutId.keys()];
    if (!ids.length) continue;
    const { data: existing } = await supa.from('workouts').select('id').in('id', ids);
    const present = new Set((existing ?? []).map((w) => w.id));
    const missing = ids.filter((id) => !present.has(id));
    if (!missing.length) continue;

    for (const wid of missing) {
      const plan = byWorkoutId.get(wid)!;
      if (!plan.startedAt || !plan.dayId) {
        console.log(`${c.name}: skip ${wid} (missing startedAt/dayId in alerts)`);
        continue;
      }
      // Verify day_id still exists for this client's program.
      const { data: dayRow } = await supa
        .from('days')
        .select('id, programs!inner(client_id)')
        .eq('id', plan.dayId)
        .maybeSingle();
      // @ts-expect-error nested join typing
      if (!dayRow || dayRow.programs?.client_id !== c.id) {
        console.log(`${c.name}: skip ${wid} (day ${plan.dayId} no longer in their program)`);
        continue;
      }
      const startedDate = new Date(plan.startedAt);
      const weekStart = startOfWeek(startedDate, { weekStartsOn: 1 });
      const row = {
        id: wid,
        client_id: c.id,
        day_id: plan.dayId,
        started_at: plan.startedAt,
        completed_at: plan.completedAt ?? null,
        week_start: formatISO(weekStart, { representation: 'date' }),
        is_deload: false,
      };
      console.log(
        `${c.name}: restore ${wid} day=${plan.dayId.slice(0, 8)} started=${plan.startedAt.slice(0, 19)} completed=${plan.completedAt?.slice(0, 19) ?? '—'}`
      );
      if (APPLY) {
        const { error } = await supa.from('workouts').insert(row);
        if (error) console.error(`  insert failed:`, error);
      }
    }
  }
}

main().catch(console.error);
