/**
 * One-off: set a specific client's PIN.
 * Usage: npx tsx scripts/set-client-pin.ts <client-id> <new-PIN>
 */
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '.env.local') });

const [, , clientId, pin] = process.argv;
if (!clientId || !pin || !/^\d{4,6}$/.test(pin)) {
  console.error('Usage: npx tsx scripts/set-client-pin.ts <client-id> <4-6 digit PIN>');
  process.exit(1);
}

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const { data: client } = await supa
    .from('clients')
    .select('id, name')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) {
    console.error(`No client with id ${clientId}`);
    process.exit(1);
  }

  // Collision check across all coaches + active clients (skip the row we're updating).
  const [{ data: coaches }, { data: clients }] = await Promise.all([
    supa.from('coaches').select('id, name, pin_hash'),
    supa.from('clients').select('id, name, pin_hash').neq('id', clientId),
  ]);
  for (const r of [...(coaches ?? []), ...(clients ?? [])]) {
    if (await bcrypt.compare(pin, r.pin_hash)) {
      console.error(`PIN ${pin} already in use by ${r.name} (${r.id}). Refusing to set duplicate.`);
      process.exit(1);
    }
  }

  const hash = await bcrypt.hash(pin, 12);
  const hmacKey = process.env.PIN_HMAC_KEY;
  const hmac = hmacKey ? createHmac('sha256', hmacKey).update(pin).digest('hex') : null;

  const { error } = await supa
    .from('clients')
    .update({
      pin_hash: hash,
      pin_hmac: hmac,
      pin_attempts: 0,
      pin_locked_until: null,
    })
    .eq('id', clientId);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`Updated PIN for ${client.name} (${client.id}) → ${pin}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
