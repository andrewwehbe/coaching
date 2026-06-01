/**
 * Seed exercises.is_compound from name_key heuristics.
 *
 *   npx tsx scripts/backfill-is-compound.ts            # dry-run (default)
 *   npx tsx scripts/backfill-is-compound.ts --apply    # actually write
 *
 * Per the established pattern, data seeding lives in scripts/ (not in
 * the migration) so the coach can review the dry-run output and
 * correct mislabels before applying.
 *
 * The heuristic is keyword-based and intentionally CONSERVATIVE:
 *   - COMPOUND keywords win → is_compound = true
 *   - ISOLATION keywords win → is_compound = false
 *   - Both match or neither matches → is_compound stays null
 *     ("ambiguous", coach reviews manually in the program editor)
 *
 * Edge cases the coach should eyeball:
 *   - Cable variants of compound patterns (cable row, cable pulldown)
 *     → treated as compound
 *   - Machine presses (chest press, shoulder press machine) → compound
 *   - Unilateral compounds (split squat, single-leg press) → compound
 *   - Single-arm cable curls / extensions → isolation
 *   - Hip thrust / glute bridge → compound (hip + knee extension)
 *   - Shrugs → isolation (single joint, scapular elevation)
 *
 * The script will NOT overwrite rows that already have is_compound
 * set — coach edits are sacred.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const supa = createClient(SUPA_URL, SUPA_KEY);

// Word-boundaried. Rev2 (post Stage-3 sign-off):
//   - Plural-form misses: noun tokens now carry `s?` (shrug→shrugs,
//     raise→raises, dip→dips, squat→squats, etc).
//   - Added: pullover, JM press, tate press, skullcrusher, hyperextension,
//     pec dec (typo of pec deck), spaced pushdowns, abductor/adductor noun
//     forms, bare bench, bare pendulum, multi-word incline/flat presses
//     ("Incline Bench Dumbbell Press" etc, up to 3 words between).
//   - Both-match → ambiguous is preserved as the safety valve. Adding a
//     compound token can't "steal" an isolation row that has both signals.
//   - Coach still eyeballs the full list before --apply; the regex's job
//     is the easy 80%, not the final call.
const COMPOUND_RE =
  /\b(?:squats?|deadlifts?|rdls?|romanian|sldls?|bench(?:es)?|incline(?:\s+\w+){0,3}\s+press(?:es)?|flat(?:\s+\w+){0,3}\s+press(?:es)?|dumbbell\s*press(?:es)?|db\s*press(?:es)?|chest\s*press(?:es)?|overhead\s*press(?:es)?|shoulder\s*press(?:es)?|military(?:\s*press(?:es)?)?|push\s*press(?:es)?|pull\s*ups?|pull-ups?|pullups?|chin\s*ups?|chin-ups?|chinups?|pulldowns?|pull\s*downs?|rows?|hip\s*thrusts?|glute\s*bridges?|leg\s*press(?:es)?|hack\s*squats?|split\s*squats?|bulgarian|lunges?|step\s*ups?|step-ups?|dips?|t-bar|landmine|cleans?|snatch(?:es)?|jerks?|thrusters?|good\s*mornings?|sumo|pendulum)\b/i;

const ISOLATION_RE =
  /\b(?:curls?|extensions?|hyperextensions?|hyper-extensions?|(?:fly|flie|flye)s?|raises?|laterals?|abductions?|adductions?|abductors?|adductors?|kickbacks?|shrugs?|calf|calves|crunch(?:es)?|sit\s*ups?|sit-ups?|situps?|leg\s*raises?|leg\s*curls?|leg\s*extensions?|cable\s*crunch(?:es)?|tricep\s*pushdowns?|pushdowns?|push\s*downs?|pec\s*decks?|pec\s*decs?|reverse\s*(?:fly|flie|flye)s?|cable\s*single|single\s*arm\s*cable|face\s*pulls?|rear\s*delt|pullovers?|jm\s*press(?:es)?|tate\s*press(?:es)?|skull\s*crushers?|skullcrushers?)\b/i;

type Verdict = 'compound' | 'isolation' | 'ambiguous';

function infer(name: string): Verdict {
  const c = COMPOUND_RE.test(name);
  const i = ISOLATION_RE.test(name);
  if (c && !i) return 'compound';
  if (i && !c) return 'isolation';
  // Both or neither — ambiguous.
  return 'ambiguous';
}

(async () => {
  const { data, error } = await supa
    .from('exercises')
    .select('id, name, name_key, is_compound, archived_at')
    .is('archived_at', null);
  if (error) {
    console.error('Failed to fetch exercises:', error.message);
    process.exit(1);
  }

  const groups: Record<Verdict, { id: string; name: string }[]> = {
    compound: [],
    isolation: [],
    ambiguous: [],
  };
  const skipped: { id: string; name: string; existing: boolean }[] = [];
  for (const row of data ?? []) {
    if (row.is_compound !== null) {
      skipped.push({ id: row.id, name: row.name, existing: row.is_compound });
      continue;
    }
    const verdict = infer(row.name);
    groups[verdict].push({ id: row.id, name: row.name });
  }

  // Dedupe by name for readability — coach reviews by display name,
  // not by every per-day exercise row.
  const dedupe = (arr: { id: string; name: string }[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of arr) {
      const k = a.name.trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a.name.trim());
    }
    return out.sort();
  };

  const compounds = dedupe(groups.compound);
  const isolations = dedupe(groups.isolation);
  const ambiguous = dedupe(groups.ambiguous);

  console.log(`\n=== BACKFILL is_compound — ${apply ? 'APPLY' : 'DRY-RUN'} ===\n`);
  console.log(`Total active exercises:    ${(data ?? []).length}`);
  console.log(`Already classified:         ${skipped.length}  (unchanged)`);
  console.log(`Distinct names — compound:  ${compounds.length}`);
  console.log(`Distinct names — isolation: ${isolations.length}`);
  console.log(`Distinct names — ambiguous: ${ambiguous.length}\n`);

  console.log('--- COMPOUND (would set is_compound = true) ---');
  for (const n of compounds) console.log(`  ${n}`);
  console.log('\n--- ISOLATION (would set is_compound = false) ---');
  for (const n of isolations) console.log(`  ${n}`);
  console.log('\n--- AMBIGUOUS (leaves null, needs coach review) ---');
  for (const n of ambiguous) console.log(`  ${n}`);

  if (!apply) {
    console.log('\nDry-run. Re-run with --apply to write.');
    return;
  }

  // Apply: batch updates per verdict, only for rows we'd classify.
  const toUpdate: { id: string; is_compound: boolean }[] = [];
  for (const r of groups.compound) toUpdate.push({ id: r.id, is_compound: true });
  for (const r of groups.isolation) toUpdate.push({ id: r.id, is_compound: false });

  console.log(`\nApplying ${toUpdate.length} row update(s)...`);
  // Supabase doesn't have a batch UPDATE with per-row values; iterate.
  let written = 0;
  for (const u of toUpdate) {
    const { error: e } = await supa
      .from('exercises')
      .update({ is_compound: u.is_compound })
      .eq('id', u.id);
    if (e) {
      console.error(`  ! ${u.id}: ${e.message}`);
    } else {
      written++;
    }
  }
  console.log(`Done: ${written} of ${toUpdate.length} written.`);
})();
