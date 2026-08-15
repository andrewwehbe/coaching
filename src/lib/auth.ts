import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import bcrypt from 'bcryptjs';

import { db } from './supabase';
import {
  SESSION_TTL_DAYS,
  MAX_PIN_ATTEMPTS,
  RATE_LIMIT_15M,
  RATE_LIMIT_24H,
} from './config';

export const SESSION_COOKIE = 'coaching_session';
export { SESSION_TTL_DAYS, MAX_PIN_ATTEMPTS, RATE_LIMIT_15M, RATE_LIMIT_24H };

export type SessionUser =
  | { type: 'coach'; id: string; name: string }
  | {
      type: 'client';
      id: string;
      name: string;
      /** Name shown to the client themselves on /today; falls back to `name`. */
      greetingName: string;
      active: boolean;
    };

function newToken(): string {
  return randomBytes(32).toString('hex');
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 12);
}

export async function checkPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

/**
 * Returns hex HMAC-SHA256 of the PIN under PIN_HMAC_KEY, or null if the
 * env var isn't set. Used as a deterministic lookup key so login can find
 * the candidate account in O(1) instead of bcrypt-comparing against every
 * row. The bcrypt verify still runs once on the matched row, so DB-only
 * leak of pin_hmac doesn't reveal the PIN — and HMAC without the key is
 * unreversible.
 */
export function pinHmac(pin: string): string | null {
  const key = process.env.PIN_HMAC_KEY;
  if (!key) return null;
  return createHmac('sha256', key).update(pin).digest('hex');
}

/**
 * Best-effort client IP from common proxy headers. In dev this falls back to
 * a constant so rate-limit tests still work locally.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  // Platform-verified headers first: Vercel sets x-real-ip /
  // x-vercel-forwarded-for itself, so they can't be spoofed by the caller.
  // The first x-forwarded-for element is attacker-controlled behind some
  // proxies, so it's only the last resort (dev / non-Vercel hosts).
  return (
    h.get('x-real-ip') ||
    h.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('cf-connecting-ip') ||
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

/**
 * Returns true if the IP is allowed to attempt; false if rate-limited.
 * On allow, increments the counters.
 */
export async function checkAndBumpRateLimit(ip: string): Promise<boolean> {
  const now = new Date();
  const supa = db();

  const { data: row } = await supa
    .from('rate_limits')
    .select('*')
    .eq('ip', ip)
    .maybeSingle();

  let attempts15m = 0;
  let attempts24h = 0;
  let window15m = now;
  let window24h = now;

  if (row) {
    const win15 = new Date(row.window_15m);
    const win24 = new Date(row.window_24h);
    attempts15m = now.getTime() - win15.getTime() > 15 * 60_000 ? 0 : row.attempts_15m;
    attempts24h = now.getTime() - win24.getTime() > 24 * 60 * 60_000 ? 0 : row.attempts_24h;
    window15m = attempts15m === 0 ? now : win15;
    window24h = attempts24h === 0 ? now : win24;
  }

  if (attempts15m >= RATE_LIMIT_15M || attempts24h >= RATE_LIMIT_24H) {
    return false;
  }

  await supa.from('rate_limits').upsert({
    ip,
    attempts_15m: attempts15m + 1,
    window_15m: window15m.toISOString(),
    attempts_24h: attempts24h + 1,
    window_24h: window24h.toISOString(),
  });

  return true;
}

type CoachRow = {
  id: string;
  name: string;
  pin_hash: string;
  pin_attempts: number | null;
  pin_locked_until: string | null;
};

type ClientRow = {
  id: string;
  name: string;
  greeting_name: string | null;
  pin_hash: string;
  pin_attempts: number | null;
  pin_locked_until: string | null;
  active: boolean;
};

/**
 * Try to match a PIN to a coach or active client. If PIN_HMAC_KEY is set
 * AND the row has pin_hmac populated, login is O(1) — look up by hash,
 * bcrypt-verify once. Otherwise fall back to bcrypt-loop across all rows
 * (legacy behaviour, slow but correct). New PINs always populate pin_hmac.
 *
 * Brute-force protection is the IP rate-limit; per-account counters are
 * deliberately not bumped on no-match (see S1 in REVIEW history).
 */
export async function attemptPinLogin(
  pin: string,
): Promise<
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'invalid' | 'locked'; lockedUntil?: Date }
> {
  const supa = db();
  const hmac = pinHmac(pin);

  // Fast path: if we can compute an HMAC, ask the DB for any rows that
  // match. There's no cross-table uniqueness so we look both up.
  if (hmac) {
    const [{ data: coachHits }, { data: clientHits }] = await Promise.all([
      supa
        .from('coaches')
        .select('id, name, pin_hash, pin_attempts, pin_locked_until')
        .eq('pin_hmac', hmac),
      supa
        .from('clients')
        .select('id, name, greeting_name, pin_hash, pin_attempts, pin_locked_until, active')
        .eq('pin_hmac', hmac)
        .eq('active', true),
    ]);

    for (const c of (coachHits ?? []) as CoachRow[]) {
      const r = await tryCoach(c, pin);
      if (r) return r;
    }
    for (const c of (clientHits ?? []) as ClientRow[]) {
      const r = await tryClient(c, pin);
      if (r) return r;
    }
    // Fall through to legacy loop if no hmac hit — covers accounts that
    // haven't been migrated yet.
  }

  // Legacy / fallback bcrypt-loop. Skips rows that already have pin_hmac
  // populated when we have a key (those would have matched the fast path).
  const [{ data: coaches }, { data: clients }] = await Promise.all([
    supa
      .from('coaches')
      .select('id, name, pin_hash, pin_attempts, pin_locked_until, pin_hmac'),
    supa
      .from('clients')
      .select('id, name, greeting_name, pin_hash, pin_attempts, pin_locked_until, pin_hmac, active')
      .eq('active', true),
  ]);

  for (const c of (coaches ?? []) as Array<CoachRow & { pin_hmac: string | null }>) {
    if (hmac && c.pin_hmac) continue; // already covered by fast path
    const r = await tryCoach(c, pin);
    if (r) return r;
  }
  for (const c of (clients ?? []) as Array<ClientRow & { pin_hmac: string | null }>) {
    if (hmac && c.pin_hmac) continue;
    const r = await tryClient(c, pin);
    if (r) return r;
  }

  return { ok: false, reason: 'invalid' };
}

async function tryCoach(
  c: CoachRow,
  pin: string,
): Promise<{ ok: true; user: SessionUser } | { ok: false; reason: 'locked'; lockedUntil: Date } | null> {
  if (!(await checkPin(pin, c.pin_hash))) return null;
  const now = new Date();
  if (c.pin_locked_until && new Date(c.pin_locked_until) > now) {
    return { ok: false, reason: 'locked', lockedUntil: new Date(c.pin_locked_until) };
  }
  const supa = db();
  await supa
    .from('coaches')
    .update({ pin_attempts: 0, pin_locked_until: null })
    .eq('id', c.id);
  return { ok: true, user: { type: 'coach', id: c.id, name: c.name } };
}

async function tryClient(
  c: ClientRow,
  pin: string,
): Promise<{ ok: true; user: SessionUser } | { ok: false; reason: 'locked'; lockedUntil: Date } | null> {
  if (!(await checkPin(pin, c.pin_hash))) return null;
  const now = new Date();
  if (c.pin_locked_until && new Date(c.pin_locked_until) > now) {
    return { ok: false, reason: 'locked', lockedUntil: new Date(c.pin_locked_until) };
  }
  const supa = db();
  await supa
    .from('clients')
    .update({ pin_attempts: 0, pin_locked_until: null })
    .eq('id', c.id);
  return {
    ok: true,
    user: {
      type: 'client',
      id: c.id,
      name: c.name,
      greetingName: c.greeting_name ?? c.name,
      active: c.active,
    },
  };
}

/**
 * Issues a session row and sets the session cookie. Returns the session id.
 */
export async function issueSession(user: SessionUser, userAgent: string | null): Promise<string> {
  void userAgent; // device row is now created lazily on push subscribe
  const supa = db();
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60_000);

  // We used to insert a `devices` row on every login as scaffolding for push,
  // but that polluted the table with orphan rows that had no push subscription.
  // Devices are now created only by /api/push/subscribe, so a real device row
  // implies a real subscription. Sessions just record device_id = null here.
  await supa.from('sessions').insert({
    id: token,
    user_type: user.type,
    user_id: user.id,
    device_id: null,
    expires_at: expires.toISOString(),
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires,
  });

  return token;
}

/**
 * Resolves the session cookie to a user. Wrapped in React.cache so the
 * layout and page of one navigation share a single lookup instead of each
 * paying for their own. The lookup itself is one round trip: the
 * get_session_user RPC (0034) validates the token, fetches the user row,
 * and does a throttled last_used touch inside one call. Falls back to the
 * legacy two-query path if the function isn't deployed (e.g. a local DB
 * behind on migrations).
 */
export const readSession = cache(async (): Promise<SessionUser | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const h = await headers();
  const ip =
    h.get('x-real-ip') ||
    h.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    null;
  const ua = h.get('user-agent') ?? null;

  const supa = db();
  const { data, error } = await supa.rpc('get_session_user', {
    p_token: token,
    p_ip: ip,
    p_ua: ua,
  });

  if (error) return readSessionLegacy(token, ip, ua);
  if (!data) return null;

  const u = data as {
    type: 'coach' | 'client';
    id: string;
    name: string;
    greeting_name?: string | null;
    active?: boolean;
  };
  if (u.type === 'coach') {
    return { type: 'coach', id: u.id, name: u.name };
  }
  return {
    type: 'client',
    id: u.id,
    name: u.name,
    greetingName: u.greeting_name ?? u.name,
    active: u.active ?? false,
  };
});

async function readSessionLegacy(
  token: string,
  ip: string | null,
  ua: string | null,
): Promise<SessionUser | null> {
  const supa = db();
  const { data: session } = await supa
    .from('sessions')
    .select('*')
    .eq('id', token)
    .maybeSingle();

  if (!session || session.revoked) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  // Touch last_used_at + bind IP/UA for the /settings session list.
  // Best-effort — a failed touch must not break the request.
  supa
    .from('sessions')
    .update({
      last_used_at: new Date().toISOString(),
      last_used_ip: ip,
      last_used_ua: ua,
    })
    .eq('id', token)
    .then(undefined, () => {});

  if (session.user_type === 'coach') {
    const { data: c } = await supa
      .from('coaches')
      .select('id,name')
      .eq('id', session.user_id)
      .maybeSingle();
    if (!c) return null;
    return { type: 'coach', id: c.id, name: c.name };
  } else {
    const { data: c } = await supa
      .from('clients')
      .select('id,name,greeting_name,active')
      .eq('id', session.user_id)
      .maybeSingle();
    if (!c) return null;
    return {
      type: 'client',
      id: c.id,
      name: c.name,
      greetingName: c.greeting_name ?? c.name,
      active: c.active,
    };
  }
}

export async function revokeSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const supa = db();
    await supa.from('sessions').update({ revoked: true }).eq('id', token);
    cookieStore.delete(SESSION_COOKIE);
  }
}
