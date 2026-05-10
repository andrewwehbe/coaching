import 'server-only';

import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

import { hashPin, pinHmac } from './auth';
import { db } from './supabase';

/**
 * Generate a 5-digit numeric PIN that doesn't collide with any existing
 * coach or client PIN. We can't query by hash, so we fetch all hashes and
 * bcrypt-compare each candidate. With small user counts this is fine.
 *
 * Returns the plaintext PIN (to show the coach once), the bcrypt hash to
 * store, and the HMAC for fast login lookup (null if PIN_HMAC_KEY isn't
 * configured — the system still works, just on the bcrypt-loop path).
 */
export async function generateUniquePin(): Promise<{
  pin: string;
  hash: string;
  hmac: string | null;
}> {
  const supa = db();
  const [{ data: coaches }, { data: clients }] = await Promise.all([
    supa.from('coaches').select('pin_hash'),
    supa.from('clients').select('pin_hash'),
  ]);
  const hashes = [
    ...(coaches ?? []).map((c) => c.pin_hash as string),
    ...(clients ?? []).map((c) => c.pin_hash as string),
  ];

  const maxAttempts = 200;
  for (let i = 0; i < maxAttempts; i++) {
    const pin = String(randomInt(0, 100_000)).padStart(5, '0');
    let collides = false;
    for (const h of hashes) {
      if (await bcrypt.compare(pin, h)) {
        collides = true;
        break;
      }
    }
    if (!collides) {
      const hash = await hashPin(pin);
      return { pin, hash, hmac: pinHmac(pin) };
    }
  }
  throw new Error('Could not generate a unique PIN after many attempts.');
}
