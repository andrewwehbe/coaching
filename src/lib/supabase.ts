import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SIGNED_URL_TTL_SECONDS } from './config';

let _client: SupabaseClient | null = null;

/**
 * Server-only Supabase client backed by the service-role key. Lazy so the
 * module is importable at build time without env vars present.
 */
export function db(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.'
    );
  }
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/** Sign a single storage path. Returns null if the path is missing or signing fails. */
export async function signMediaUrl(
  bucket: string,
  path: string | null | undefined,
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS
): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await db()
    .storage.from(bucket)
    .createSignedUrl(path, ttlSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Batch-sign many paths from the same bucket. Order of results matches input. */
export async function signMediaUrls(
  bucket: string,
  paths: ReadonlyArray<string | null | undefined>,
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS
): Promise<(string | null)[]> {
  const present = paths.filter((p): p is string => !!p);
  if (present.length === 0) return paths.map(() => null);
  const { data, error } = await db()
    .storage.from(bucket)
    .createSignedUrls(present, ttlSeconds);
  if (error || !data) return paths.map(() => null);
  const byPath = new Map<string, string>();
  for (const row of data) {
    if (row.path && row.signedUrl) byPath.set(row.path, row.signedUrl);
  }
  return paths.map((p) => (p ? byPath.get(p) ?? null : null));
}
