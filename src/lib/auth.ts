import 'server-only';

import { randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import bcrypt from 'bcryptjs';

import { db } from './supabase';

export const SESSION_COOKIE = 'coaching_session';
export const SESSION_TTL_DAYS = 365;
export const MAX_PIN_ATTEMPTS = 10;
export const RATE_LIMIT_15M = 5;
export const RATE_LIMIT_24H = 20;

export type SessionUser =
  | { type: 'coach'; id: string; name: string }
  | { type: 'client'; id: string; name: string; active: boolean };

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
 * Best-effort client IP from common proxy headers. In dev this falls back to
 * a constant so rate-limit tests still work locally.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip') ||
    h.get('cf-connecting-ip') ||
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

/**
 * Try every coach + every active client for a matching PIN. Returns the
 * matched user record on success, or null. On account match but lockout
 * active, returns { lockedUntil }. Updates pin_attempts/lockout state.
 */
export async function attemptPinLogin(
  pin: string
): Promise<
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'invalid' | 'locked'; lockedUntil?: Date }
> {
  const supa = db();

  // We can't query by hash, so we have to fetch all candidates and bcrypt-
  // compare. With low user counts (single coach + dozens of clients) this
  // is fine. For larger scale, we'd switch to a deterministic lookup key.
  const [{ data: coaches }, { data: clients }] = await Promise.all([
    supa.from('coaches').select('id,name,pin_hash,pin_attempts,pin_locked_until'),
    supa
      .from('clients')
      .select('id,name,pin_hash,pin_attempts,pin_locked_until,active')
      .eq('active', true),
  ]);

  const now = new Date();

  for (const c of coaches ?? []) {
    if (c.pin_locked_until && new Date(c.pin_locked_until) > now) {
      // Don't reveal lockout for unmatched accounts; only check after match.
    }
    if (await checkPin(pin, c.pin_hash)) {
      if (c.pin_locked_until && new Date(c.pin_locked_until) > now) {
        return { ok: false, reason: 'locked', lockedUntil: new Date(c.pin_locked_until) };
      }
      await supa
        .from('coaches')
        .update({ pin_attempts: 0, pin_locked_until: null })
        .eq('id', c.id);
      return {
        ok: true,
        user: { type: 'coach', id: c.id, name: c.name },
      };
    }
  }

  for (const c of clients ?? []) {
    if (await checkPin(pin, c.pin_hash)) {
      if (c.pin_locked_until && new Date(c.pin_locked_until) > now) {
        return { ok: false, reason: 'locked', lockedUntil: new Date(c.pin_locked_until) };
      }
      await supa
        .from('clients')
        .update({ pin_attempts: 0, pin_locked_until: null })
        .eq('id', c.id);
      return {
        ok: true,
        user: { type: 'client', id: c.id, name: c.name, active: c.active },
      };
    }
  }

  // No match. Bump attempts on every account that's not yet locked. (Spreads
  // attack cost; eventually locks any account being targeted.)
  // NOTE: alternative is to track per-IP only — this approach also catches
  // distributed brute force on a single account.
  const lockoutUntil = new Date(now.getTime() + 60 * 60_000); // 1 hour
  for (const c of coaches ?? []) {
    const next = (c.pin_attempts ?? 0) + 1;
    await supa
      .from('coaches')
      .update({
        pin_attempts: next,
        pin_locked_until: next >= MAX_PIN_ATTEMPTS ? lockoutUntil.toISOString() : c.pin_locked_until,
      })
      .eq('id', c.id);
  }
  for (const c of clients ?? []) {
    const next = (c.pin_attempts ?? 0) + 1;
    await supa
      .from('clients')
      .update({
        pin_attempts: next,
        pin_locked_until: next >= MAX_PIN_ATTEMPTS ? lockoutUntil.toISOString() : c.pin_locked_until,
      })
      .eq('id', c.id);
  }

  return { ok: false, reason: 'invalid' };
}

/**
 * Issues a session row and sets the session cookie. Returns the session id.
 */
export async function issueSession(user: SessionUser, userAgent: string | null): Promise<string> {
  const supa = db();
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60_000);

  // Track the device (one row per session for now; we'll merge in M5).
  const { data: device } = await supa
    .from('devices')
    .insert({
      user_type: user.type,
      user_id: user.id,
      user_agent: userAgent,
    })
    .select('id')
    .single();

  await supa.from('sessions').insert({
    id: token,
    user_type: user.type,
    user_id: user.id,
    device_id: device?.id ?? null,
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

export async function readSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const supa = db();
  const { data: session } = await supa
    .from('sessions')
    .select('*')
    .eq('id', token)
    .maybeSingle();

  if (!session || session.revoked) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  // Touch last_used_at without awaiting — best-effort.
  void supa
    .from('sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', token);

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
      .select('id,name,active')
      .eq('id', session.user_id)
      .maybeSingle();
    if (!c) return null;
    return { type: 'client', id: c.id, name: c.name, active: c.active };
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
