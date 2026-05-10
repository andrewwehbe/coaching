-- Deterministic, server-side-keyed PIN lookup. Currently login does an
-- O(N) bcrypt-loop — bcrypt cost 12 is ~50-100ms per compare, so with
-- N clients login takes ~100*N ms. With pin_hmac populated, login is
-- O(1): compute HMAC of the typed PIN, look up the matching row by
-- index, bcrypt-verify just that one row.
--
-- The HMAC is keyed by PIN_HMAC_KEY (server-side env). DB compromise
-- alone leaks bcrypt hashes (slow to brute-force) and HMACs that
-- can't be reversed without the key. Backfill is organic — existing
-- accounts get a pin_hmac the next time their PIN is regenerated.
-- Login falls back to the bcrypt-loop for accounts without a hash.

alter table coaches add column if not exists pin_hmac text;
alter table clients add column if not exists pin_hmac text;

create index if not exists coaches_pin_hmac_idx on coaches (pin_hmac);
create index if not exists clients_pin_hmac_idx on clients (pin_hmac);
