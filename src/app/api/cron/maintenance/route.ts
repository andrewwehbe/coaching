/**
 * Weekly maintenance cron (sweep report step 2).
 *
 * Schedule: Sundays 03:00 (see vercel.json). Two jobs:
 *
 * 1. Table prunes — sessions, rate_limits. Both grew forever before this:
 *    - sessions: rows expired 30+ days ago, and revoked rows already past
 *      expiry. Live sessions are never touched.
 *    - rate_limits: per-IP counters whose 24h window closed 2+ days ago.
 *    alerts and audit_log are deliberately NOT pruned — alerts double as
 *    the cron dedup ledger and audit_log is the audit trail.
 *
 * 2. Storage orphan sweep — check-in-photos and workout-videos buckets.
 *    Objects are only reachable through check_in_photos.storage_url and
 *    sets.video_url; presigned-but-never-attached uploads, cascade-deleted
 *    check-ins, and reset workouts all leave objects behind (no .remove()
 *    existed anywhere before this). Deletes objects that are BOTH
 *    unreferenced AND older than 7 days — the age floor means an upload
 *    mid-flight (signed URL issued, row not yet written) can never be
 *    swept.
 *
 * Idempotent; safe to re-run. Failures in one job don't block the other.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyCronSecret } from '@/lib/cron-auth';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

const ORPHAN_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LIST_PAGE_SIZE = 1000;
const REMOVE_BATCH_SIZE = 100;
/** Per-run ceiling so a pathological backlog can't blow the function budget. */
const MAX_DELETES_PER_RUN = 2000;

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<NextResponse> {
  const unauth = verifyCronSecret(req);
  if (unauth) return unauth;

  const [prunes, storage] = await Promise.all([pruneTables(), sweepStorage()]);
  return NextResponse.json({ ok: true, prunes, storage });
}

async function pruneTables() {
  const supa = db();
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

  const [expired, revoked, rate] = await Promise.all([
    supa.from('sessions').delete({ count: 'exact' }).lt('expires_at', thirtyDaysAgo),
    supa
      .from('sessions')
      .delete({ count: 'exact' })
      .eq('revoked', true)
      .lt('expires_at', nowIso),
    supa.from('rate_limits').delete({ count: 'exact' }).lt('window_24h', twoDaysAgo),
  ]);

  const errors = [expired.error, revoked.error, rate.error]
    .filter(Boolean)
    .map((e) => e!.message);
  if (errors.length) log.error('maintenance.prune_failed', errors.join('; '));

  return {
    sessionsExpired: expired.count ?? 0,
    sessionsRevoked: revoked.count ?? 0,
    rateLimits: rate.count ?? 0,
    errors,
  };
}

type BucketSpec = {
  bucket: string;
  /** Returns every storage path the DB still references for this bucket. */
  referencedPaths: () => Promise<Set<string>>;
};

const BUCKETS: BucketSpec[] = [
  {
    bucket: 'check-in-photos',
    referencedPaths: async () => {
      const { data } = await db()
        .from('check_in_photos')
        .select('storage_url');
      return new Set((data ?? []).map((r) => r.storage_url as string));
    },
  },
  {
    bucket: 'workout-videos',
    referencedPaths: async () => {
      const { data } = await db()
        .from('sets')
        .select('video_url')
        .not('video_url', 'is', null);
      return new Set((data ?? []).map((r) => r.video_url as string));
    },
  },
];

async function sweepStorage() {
  const results: Record<
    string,
    { scanned: number; deleted: number; errors: string[] }
  > = {};
  for (const spec of BUCKETS) {
    try {
      results[spec.bucket] = await sweepBucket(spec);
    } catch (e) {
      results[spec.bucket] = {
        scanned: 0,
        deleted: 0,
        errors: [e instanceof Error ? e.message : 'unknown'],
      };
    }
  }
  return results;
}

async function sweepBucket(spec: BucketSpec) {
  const supa = db();
  const referenced = await spec.referencedPaths();
  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const errors: string[] = [];
  let scanned = 0;
  const orphans: string[] = [];

  // Objects live under {clientId}/ prefixes; storage list() is per-folder,
  // so enumerate the top-level folders first.
  const { data: folders, error: rootErr } = await supa.storage
    .from(spec.bucket)
    .list('', { limit: LIST_PAGE_SIZE });
  if (rootErr) return { scanned, deleted: 0, errors: [rootErr.message] };

  for (const folder of folders ?? []) {
    // Files at root (id set) are unexpected; only descend into folders.
    if (folder.id !== null) continue;
    let offset = 0;
    for (;;) {
      const { data: files, error } = await supa.storage
        .from(spec.bucket)
        .list(folder.name, { limit: LIST_PAGE_SIZE, offset });
      if (error) {
        errors.push(`${folder.name}: ${error.message}`);
        break;
      }
      for (const f of files ?? []) {
        if (f.id === null) continue; // nested folder, not expected
        scanned++;
        const path = `${folder.name}/${f.name}`;
        const createdAt = f.created_at ? new Date(f.created_at).getTime() : NaN;
        // Unknown age → keep. Referenced or young → keep.
        if (Number.isNaN(createdAt) || createdAt > cutoff) continue;
        if (referenced.has(path)) continue;
        orphans.push(path);
      }
      if (!files || files.length < LIST_PAGE_SIZE) break;
      offset += LIST_PAGE_SIZE;
    }
  }

  const toDelete = orphans.slice(0, MAX_DELETES_PER_RUN);
  if (orphans.length > toDelete.length) {
    log.warn('maintenance.sweep_capped', {
      bucket: spec.bucket,
      orphans: orphans.length,
      cap: MAX_DELETES_PER_RUN,
    });
  }

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += REMOVE_BATCH_SIZE) {
    const batch = toDelete.slice(i, i + REMOVE_BATCH_SIZE);
    const { error } = await supa.storage.from(spec.bucket).remove(batch);
    if (error) {
      errors.push(`remove: ${error.message}`);
      break;
    }
    deleted += batch.length;
  }

  if (deleted > 0) {
    log.info('maintenance.sweep_deleted', { bucket: spec.bucket, deleted });
  }
  return { scanned, deleted, errors };
}
