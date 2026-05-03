import 'server-only';

import { db } from './supabase';

/**
 * Match a free-text exercise name (from a client's program) against the
 * curated catalog and return its group_key, plus alternatives in the
 * same group.
 *
 * Matching is fuzzy on a normalized form: lower-case, alphanumerics
 * only, sorted-token bag. So "Lat Pulldown Wide Grip" matches
 * "Wide-grip lat pulldown".
 */

export type CatalogEntry = {
  id: string;
  name: string;
  group_key: string;
};

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const STOP = new Set(['the', 'a', 'an', 'with', 'on', 'and', 'or', 'in', 'of', 'machine']);

function bag(s: string): Set<string> {
  return new Set(tokens(s).filter((t) => !STOP.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export type CatalogMatch = {
  match: CatalogEntry | null;
  alternatives: CatalogEntry[];
};

/**
 * Best-effort: return the catalog entry whose name is closest to the
 * given exercise. If the best Jaccard score is < 0.34, treat as no
 * match (the alternatives list will be empty so the suggestion's
 * Apply will be hidden).
 */
export async function matchCatalogFor(exerciseName: string): Promise<CatalogMatch> {
  const supa = db();
  const { data: all } = await supa
    .from('catalog_exercises')
    .select('id, name, group_key');
  if (!all || all.length === 0) return { match: null, alternatives: [] };

  const target = bag(exerciseName);
  let best: CatalogEntry | null = null;
  let bestScore = 0;
  for (const c of all) {
    const score = jaccard(target, bag(c.name));
    if (score > bestScore) {
      bestScore = score;
      best = c as CatalogEntry;
    }
  }
  if (!best || bestScore < 0.34) return { match: null, alternatives: [] };

  const alternatives = (all as CatalogEntry[]).filter(
    (c) => c.group_key === best!.group_key && c.name !== best!.name,
  );
  return { match: best, alternatives };
}

/** Batched version for the suggestions builder. */
export async function matchCatalogForMany(
  names: string[],
): Promise<Map<string, CatalogMatch>> {
  const supa = db();
  const out = new Map<string, CatalogMatch>();
  if (names.length === 0) return out;

  const { data: all } = await supa
    .from('catalog_exercises')
    .select('id, name, group_key');
  if (!all || all.length === 0) {
    for (const n of names) out.set(n, { match: null, alternatives: [] });
    return out;
  }

  const byGroup = new Map<string, CatalogEntry[]>();
  for (const c of all as CatalogEntry[]) {
    const arr = byGroup.get(c.group_key) ?? [];
    arr.push(c);
    byGroup.set(c.group_key, arr);
  }

  for (const name of names) {
    const target = bag(name);
    let best: CatalogEntry | null = null;
    let bestScore = 0;
    for (const c of all as CatalogEntry[]) {
      const score = jaccard(target, bag(c.name));
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best || bestScore < 0.34) {
      out.set(name, { match: null, alternatives: [] });
      continue;
    }
    const alternatives = (byGroup.get(best.group_key) ?? []).filter((c) => c.name !== best!.name);
    out.set(name, { match: best, alternatives });
  }
  return out;
}
