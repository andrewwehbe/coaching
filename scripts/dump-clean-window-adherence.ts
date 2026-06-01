/**
 * Diagnostic — run computeAdherence with at=end-of-last-completed-week
 * so the 2-week lookback covers the two completed prior weeks
 * (2026-05-18..05-31), not the just-started current week. Compares
 * each client's clean-window ratio against the current-window
 * ratio that buildWeeklyReport produced earlier.
 *
 *   npx tsx --conditions=react-server scripts/dump-clean-window-adherence.ts
 *
 * Report-only. No code changes.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { startOfWeek, formatISO, subWeeks } from 'date-fns';

import { computeAdherence, type ScheduledDay } from '../src/lib/signals/adherence';
import { ADHERENCE_LOOKBACK_WEEKS } from '../src/lib/config';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa = createClient(SUPA_URL, SUPA_KEY);

(async () => {
  // The "clean window" anchor: end of the most-recently-completed
  // calendar week (Sunday 23:59:59 local-equivalent). The 2-week
  // lookback then covers two FULL completed weeks with no straddle.
  const currentMonday = startOfWeek(new Date(), { weekStartsOn: 1 });
  const lastCompletedSundayEnd = new Date(currentMonday.getTime() - 1);
  const cleanWindowEnd = lastCompletedSundayEnd;
  const cleanWindowStart = subWeeks(cleanWindowEnd, ADHERENCE_LOOKBACK_WEEKS);

  console.log(`Clean window: ${formatISO(cleanWindowStart, { representation: 'date' })} → ${formatISO(cleanWindowEnd, { representation: 'date' })} (${ADHERENCE_LOOKBACK_WEEKS} completed weeks)`);
  console.log(`(For comparison: the earlier report used at=${formatISO(new Date(), { representation: 'date' })} which straddles the just-started current week.)\n`);

  const { data: clients } = await supa
    .from('clients')
    .select('id, name, weekly_day_target')
    .eq('active', true)
    .order('name');

  if (!clients || clients.length === 0) {
    console.log('No active clients.');
    process.exit(0);
  }

  // Fetch workouts in the wider clean window, fetch each client's
  // active-program days. Same batched approach as weekly-report.ts.
  const ids = clients.map((c) => c.id);

  const [{ data: workouts }, { data: programs }] = await Promise.all([
    supa
      .from('workouts')
      .select('client_id, day_id, started_at')
      .in('client_id', ids)
      .gte('started_at', cleanWindowStart.toISOString())
      .lte('started_at', cleanWindowEnd.toISOString())
      .not('started_at', 'is', null),
    supa
      .from('programs')
      .select('client_id, days(id, day_index, label)')
      .in('client_id', ids)
      .eq('active', true),
  ]);

  const completedByClient = new Map<string, { day_id: string; started_at: string }[]>();
  for (const w of workouts ?? []) {
    const arr = completedByClient.get(w.client_id) ?? [];
    arr.push({ day_id: w.day_id, started_at: w.started_at });
    completedByClient.set(w.client_id, arr);
  }

  const daysByClient = new Map<string, ScheduledDay[]>();
  for (const p of (programs ?? []) as Array<{
    client_id: string;
    days: { id: string; day_index: number; label: string }[] | { id: string; day_index: number; label: string } | null;
  }>) {
    const dRaw = p.days;
    const days = Array.isArray(dRaw) ? dRaw : dRaw ? [dRaw] : [];
    daysByClient.set(p.client_id, days);
  }

  console.log(
    'client'.padEnd(22) +
      ' target  clean window adherence    bucket',
  );
  console.log('-'.repeat(80));

  let countOver80 = 0;
  let countUnder80 = 0;
  let countUnder50 = 0;
  const noTrainingClients: string[] = [];

  for (const c of clients) {
    const sig = computeAdherence({
      completedWorkouts: completedByClient.get(c.id) ?? [],
      scheduledDays: daysByClient.get(c.id) ?? [],
      weeklyDayTarget: c.weekly_day_target,
      at: cleanWindowEnd,
    });
    const pct = Math.round(sig.ratio * 100);
    let bucket: string;
    if (sig.ratio >= 0.8) {
      bucket = '>=80%  (clears gate)';
      countOver80++;
    } else if (sig.ratio >= 0.5) {
      bucket = '50-79% (under gate)';
      countUnder80++;
    } else {
      bucket = '<50%   (well under)';
      countUnder50++;
    }
    if (sig.daysCompletedInWindow === 0) noTrainingClients.push(c.name);
    console.log(
      c.name.slice(0, 21).padEnd(22) +
        String(c.weekly_day_target).padStart(7) +
        `   ${pct.toString().padStart(3)}% (${sig.daysCompletedInWindow}/${sig.daysExpectedInWindow})`.padEnd(24) +
        bucket,
    );
  }
  console.log('-'.repeat(80));

  console.log(`\nClean-window distribution (n=${clients.length}):`);
  console.log(`  >=80%  (clears gate)  : ${countOver80}`);
  console.log(`  50-79% (under gate)   : ${countUnder80}`);
  console.log(`  <50%   (well under)   : ${countUnder50}`);
  console.log(`  total under 80%       : ${countUnder80 + countUnder50}`);
  if (noTrainingClients.length > 0) {
    console.log(`\nClients with ZERO completed sessions in the clean window: ${noTrainingClients.length}`);
    for (const n of noTrainingClients) console.log(`  - ${n}`);
  }
})();
