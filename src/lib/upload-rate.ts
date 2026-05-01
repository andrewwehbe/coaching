import 'server-only';

/**
 * Per-user, per-endpoint upload presign rate limiter. Uses in-memory state.
 *
 * In a serverless environment each cold instance has its own counters, but
 * abuse (sustained spam) survives instance restarts well enough to be
 * caught — and authenticated users already pass the auth gate, so this is
 * defense-in-depth, not the primary control.
 */

type Bucket = {
  windowStart: number;
  count: number;
};

const SHORT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LONG_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const shortBuckets = new Map<string, Bucket>();
const longBuckets = new Map<string, Bucket>();

function bump(
  store: Map<string, Bucket>,
  key: string,
  windowMs: number,
  limit: number,
  now: number
): boolean {
  const b = store.get(key);
  if (!b || now - b.windowStart > windowMs) {
    store.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

export function checkUploadRate(
  userId: string,
  endpoint: string,
  limits: { perTenMin: number; perDay: number }
): boolean {
  const key = `${endpoint}:${userId}`;
  const now = Date.now();
  const okShort = bump(shortBuckets, key, SHORT_WINDOW_MS, limits.perTenMin, now);
  const okLong = bump(longBuckets, key, LONG_WINDOW_MS, limits.perDay, now);
  return okShort && okLong;
}
