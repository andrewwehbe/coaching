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

// The catalog is a curated, slow-changing list (one row per exercise,
// inserted by migration). Reading it once per server instance and caching
// in module memory keeps suggestion-building cheap. TTL is generous —
// updates land via migration, so a stale read for a few minutes is fine.
const CATALOG_TTL_MS = 5 * 60_000;
let _catalogAt = 0;
let _catalog: CatalogEntry[] | null = null;
let _byGroup: Map<string, CatalogEntry[]> | null = null;

async function loadCatalog(): Promise<{ all: CatalogEntry[]; byGroup: Map<string, CatalogEntry[]> }> {
  const fresh = _catalog && Date.now() - _catalogAt < CATALOG_TTL_MS;
  if (fresh && _catalog && _byGroup) return { all: _catalog, byGroup: _byGroup };

  const supa = db();
  const { data: all } = await supa
    .from('catalog_exercises')
    .select('id, name, group_key');

  const list = (all as CatalogEntry[] | null) ?? [];
  const byGroup = new Map<string, CatalogEntry[]>();
  for (const c of list) {
    const arr = byGroup.get(c.group_key) ?? [];
    arr.push(c);
    byGroup.set(c.group_key, arr);
  }
  _catalog = list;
  _byGroup = byGroup;
  _catalogAt = Date.now();
  return { all: list, byGroup };
}

function bestMatch(name: string, all: CatalogEntry[]): CatalogEntry | null {
  const target = bag(name);
  let best: CatalogEntry | null = null;
  let bestScore = 0;
  for (const c of all) {
    const score = jaccard(target, bag(c.name));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best && bestScore >= 0.34 ? best : null;
}

/**
 * Best-effort: return the catalog entry whose name is closest to the
 * given exercise. If the best Jaccard score is < 0.34, treat as no
 * match (the alternatives list will be empty so the suggestion's
 * Apply will be hidden).
 */
export async function matchCatalogFor(exerciseName: string): Promise<CatalogMatch> {
  const { all, byGroup } = await loadCatalog();
  if (all.length === 0) return { match: null, alternatives: [] };

  const best = bestMatch(exerciseName, all);
  if (!best) return { match: null, alternatives: [] };

  const alternatives = (byGroup.get(best.group_key) ?? []).filter((c) => c.name !== best.name);
  return { match: best, alternatives };
}

/** Batched version for the suggestions builder. */
export async function matchCatalogForMany(
  names: string[],
): Promise<Map<string, CatalogMatch>> {
  const out = new Map<string, CatalogMatch>();
  if (names.length === 0) return out;

  const { all, byGroup } = await loadCatalog();
  if (all.length === 0) {
    for (const n of names) out.set(n, { match: null, alternatives: [] });
    return out;
  }

  for (const name of names) {
    const best = bestMatch(name, all);
    if (!best) {
      out.set(name, { match: null, alternatives: [] });
      continue;
    }
    const alternatives = (byGroup.get(best.group_key) ?? []).filter((c) => c.name !== best.name);
    out.set(name, { match: best, alternatives });
  }
  return out;
}
