/**
 * Stage 5 empirical proof — invoke buildWeeklyReport for the current
 * week and dump where the weekly coaching note appears vs where a
 * structural suggestion fired instead. Confirms:
 *   - The always-non-null property in production data (every client
 *     gets at least one Suggestion).
 *   - The weekly note appears ONLY for clients without a structural
 *     suggestion.
 *   - The tier selected per client based on real signals.
 *
 *   npx tsx --conditions=react-server scripts/dump-weekly-note.ts
 *
 * The --conditions=react-server flag is REQUIRED. weekly-report.ts and
 * its transitive imports (suggestions.ts, client-context-store.ts,
 * etc.) start with `import 'server-only';` so they refuse to load
 * under the default tsx runtime. The react-server condition routes
 * the server-only package to its empty no-op export, which is exactly
 * the behavior we want for a script — we're running OUTSIDE the
 * Next.js client/server split, so the guard has nothing to enforce.
 * Matches the pattern in dump-clean-window-adherence.ts. .env.local
 * is loaded explicitly below (no extra flag needed).
 *
 * Stage 6 Piece 3 reuse: same script also surfaces ClientC's
 * synthesized-onboarding outcome — her row should show tier
 * 'getting_started' / title "Getting started", not 'accessory'.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import { startOfWeek } from 'date-fns';
import { createClient } from '@supabase/supabase-js';

import { buildWeeklyReport } from '../src/lib/weekly-report';
import {
  getActiveClientContext,
  type ActiveContext,
} from '../src/lib/signals/client-context';
import { fetchActiveContextsForClients } from '../src/lib/client-context-store';

(async () => {
  // Stage 5 v2: invoke with at = end of last completed week so the
  // adherence gate's 2-week lookback covers two FULL completed weeks
  // (clean window). On Monday morning the default at=now() catches the
  // just-started week and inflates the "below 80%" bucket. Let the
  // command line override:
  //   npx tsx ... scripts/dump-weekly-note.ts current  → at = now()
  //   npx tsx ... scripts/dump-weekly-note.ts          → at = clean window
  const useCurrent = process.argv.includes('current');
  let at: Date;
  if (useCurrent) {
    at = new Date();
  } else {
    const monday = startOfWeek(new Date(), { weekStartsOn: 1 });
    at = new Date(monday.getTime() - 1); // last completed Sunday 23:59:59.999
  }
  console.log(`Running buildWeeklyReport with at=${at.toISOString()} (${useCurrent ? 'current week, straddles start' : 'clean window — two completed weeks'})`);
  console.log('READ-ONLY: buildWeeklyReport + suggestions.ts + weekly-report.ts contain ZERO inserts / updates / pushes. No alerts written. No client notifications sent.\n');
  const report = await buildWeeklyReport(at);
  console.log(`=== Weekly report — week of ${report.weekStart} ===`);
  console.log(`${report.rows.length} active clients\n`);

  // Stage 6 Piece 3 — surface the active client_context per row so the
  // preview shows which clients are getting context-driven framing
  // (onboarding/health/at_risk/etc.) and which are on the standard
  // 5-tier path. We replicate the context fetch here rather than
  // change ClientWeekRow's shape, since this is a preview-only need.
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supa = createClient(supaUrl, supaKey);
  const ids = report.rows.map((r) => r.clientId);
  const [{ data: clientRows }, { data: anyLogRows }, persistedContextByClient] =
    await Promise.all([
      supa.from('clients').select('id, created_at').in('id', ids),
      supa
        .from('workouts')
        .select('client_id')
        .in('client_id', ids)
        .not('completed_at', 'is', null),
      fetchActiveContextsForClients(ids),
    ]);
  const createdAtByClient = new Map<string, Date>();
  for (const c of clientRows ?? []) {
    if (c.created_at) createdAtByClient.set(c.id as string, new Date(c.created_at as string));
  }
  const clientsWithAnyLog = new Set<string>(
    (anyLogRows ?? []).map((r) => r.client_id as string),
  );
  const activeContextByClient = new Map<string, ActiveContext>();
  for (const r of report.rows) {
    const createdAt = createdAtByClient.get(r.clientId);
    if (!createdAt) continue;
    const ctx = getActiveClientContext({
      at,
      persistedRow: persistedContextByClient.get(r.clientId) ?? null,
      clientCreatedAt: createdAt,
      hasNoLogs: !clientsWithAnyLog.has(r.clientId),
    });
    if (ctx) activeContextByClient.set(r.clientId, ctx);
  }

  let weeklyNoteCount = 0;
  let structuralOnlyCount = 0;
  let bothCount = 0;
  const tierTally: Record<string, number> = {};
  const contextTally: Record<string, number> = {};

  console.log(
    'client'.padEnd(20) +
      'adherence'.padStart(11) +
      '#sug'.padStart(6) +
      'note?'.padStart(8) +
      'tier'.padEnd(20).padStart(22) +
      'context'.padEnd(26) +
      'first title',
  );
  console.log('-'.repeat(140));
  for (const row of report.rows) {
    const note = row.suggestions.find((s) => s.type === 'weekly_note');
    const structural = row.suggestions.filter((s) => s.type !== 'weekly_note');
    const hasNote = note != null;
    const hasStructural = structural.length > 0;
    if (hasNote) weeklyNoteCount++;
    if (hasStructural && !hasNote) structuralOnlyCount++;
    if (hasNote && hasStructural) bothCount++;

    let tier = '—';
    if (note) {
      // Tier 0 (Stage 6 Piece 3) wins above PR; check first.
      if (/^Getting started$/.test(note.title)) tier = '0: getting_started';
      else if (/^Easing back in$/.test(note.title)) tier = '0: ease_back_in';
      else if (/reset/i.test(note.title) && /Let.s/.test(note.title)) tier = '0: re_engagement';
      else if (/PR week/.test(note.title)) tier = '1: PR';
      else if (/Push closer to target/.test(note.title)) tier = '2: effort gap';
      else if (/^This week on/.test(note.title)) tier = '3: RIR target';
      else if (/Tag a muscle group/.test(note.title)) tier = '4: accessory';
      else if (/Holding steady/.test(note.title)) tier = '5: hold steady';
      else tier = 'unknown';
      tierTally[tier] = (tierTally[tier] ?? 0) + 1;
    }

    const ctx = activeContextByClient.get(row.clientId);
    const contextLabel = ctx
      ? `${ctx.reasonCode}${ctx.source === 'synthesized_onboarding' ? ' (synth)' : ' (persisted)'}`
      : '-';
    if (ctx) contextTally[ctx.reasonCode] = (contextTally[ctx.reasonCode] ?? 0) + 1;

    const adherencePct =
      row.daysTarget > 0
        ? `${Math.round(Math.min(1, row.daysDone / row.daysTarget) * 100)}% (${row.daysDone}/${row.daysTarget})`
        : `- (${row.daysDone}/${row.daysTarget})`;
    const firstTitle = (note?.title ?? structural[0]?.title ?? '').slice(0, 50);
    console.log(
      row.name.slice(0, 19).padEnd(20) +
        adherencePct.padStart(11) +
        String(row.suggestions.length).padStart(6) +
        (hasNote ? 'yes' : 'no').padStart(8) +
        '  ' +
        tier.padEnd(20) +
        contextLabel.padEnd(26) +
        firstTitle,
    );
  }

  console.log('-'.repeat(140));
  console.log(`\nAggregates:`);
  console.log(`  clients with weekly note          : ${weeklyNoteCount}`);
  console.log(`  clients with structural only      : ${structuralOnlyCount}`);
  console.log(`  clients with both (should be 0)   : ${bothCount}`);
  console.log(`  clients with NO suggestion at all : ${report.rows.filter((r) => r.suggestions.length === 0).length}  (always-non-null property — must be 0)`);
  console.log(`  clients with active context       : ${activeContextByClient.size}`);

  console.log(`\nTier distribution (across ${weeklyNoteCount} weekly notes):`);
  for (const [tier, count] of Object.entries(tierTally).sort()) {
    console.log(`  ${tier.padEnd(22)} ${count}`);
  }
  if (Object.keys(contextTally).length > 0) {
    console.log(`\nActive-context distribution:`);
    for (const [code, count] of Object.entries(contextTally).sort()) {
      console.log(`  ${code.padEnd(22)} ${count}`);
    }
  }

  // Print every weekly note's full body — this IS the preview the
  // coach reads before deciding whether to surface anything to clients.
  console.log(`\n=== Full weekly notes ===`);
  for (const row of report.rows) {
    const note = row.suggestions.find((s) => s.type === 'weekly_note');
    if (!note) continue;
    const ctx = activeContextByClient.get(row.clientId);
    const ctxLabel = ctx
      ? ` [context: ${ctx.reasonCode} ${ctx.source === 'synthesized_onboarding' ? '(synth)' : '(persisted)'}]`
      : '';
    console.log(`\n--- ${row.name}${ctxLabel} ---`);
    console.log(`title: ${note.title}`);
    console.log(`body:  ${note.body}`);
  }
})();
