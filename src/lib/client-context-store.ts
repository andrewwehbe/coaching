import 'server-only';

import { db } from './supabase';
import type {
  PersistedContextRow,
  ReasonCode,
} from './signals/client-context';

/**
 * Stage 6 Piece 3 — DB layer for client_context.
 *
 * Pure helper in signals/client-context.ts decides what an active
 * context MEANS; this module is the only thing that decides where the
 * row comes from / how a new one is written. Every surface that needs
 * a client's context (Surface 1 cron, Surface 2 POST endpoint, Surface
 * 3 suggestions.ts, weekly-report) calls in here — one place to keep
 * the read shape and the supersede-on-write transaction consistent.
 *
 * Three callable surfaces:
 *   fetchActiveContextRow(clientId)        → PersistedContextRow | null
 *   fetchActiveContextsForClients(ids[])   → Map<clientId, row>
 *   writeClientContext({...})              → { id }   (supersede + insert)
 *
 * Non-destructive: writeClientContext NEVER deletes. The prior active
 * row (if any) is marked resolved_at = now() inside the same call as
 * the INSERT — the partial unique index on (client_id) WHERE
 * resolved_at IS NULL guarantees we never observe two active rows for
 * one client. Performed via supabase-js as two sequential statements;
 * the index makes the constraint atomic with respect to other writers
 * (any racing INSERT would 23505-fail if it raced past our update).
 */

type ContextRowFromDb = {
  id: string;
  reason_code: ReasonCode;
  note: string | null;
  created_at: string;
  review_at: string | null;
  resolved_at: string | null;
};

function rowFromDb(row: ContextRowFromDb): PersistedContextRow {
  return {
    id: row.id,
    reason_code: row.reason_code,
    note: row.note,
    created_at: new Date(row.created_at),
    review_at: row.review_at ? new Date(row.review_at) : null,
    resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
  };
}

/**
 * Most recent unresolved row for one client, or null. The partial
 * unique index guarantees at most one. Returned row may still be
 * STALE (past review_at) — that decision belongs to
 * getActiveClientContext, NOT to this layer. We just hand back the
 * row; staleness is a directive concern.
 */
export async function fetchActiveContextRow(
  clientId: string,
): Promise<PersistedContextRow | null> {
  const { data, error } = await db()
    .from('client_context')
    .select('id, reason_code, note, created_at, review_at, resolved_at')
    .eq('client_id', clientId)
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`fetchActiveContextRow: ${error.message}`);
  if (!data) return null;
  return rowFromDb(data as ContextRowFromDb);
}

/**
 * Batched variant — one round-trip for the per-cron / per-week-report
 * fan-out. Returns a Map keyed by client_id. Missing entries simply
 * mean "no active row for that client" (the caller will then fall
 * through to synthesized-onboarding or null in getActiveClientContext).
 */
export async function fetchActiveContextsForClients(
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, PersistedContextRow>> {
  const out = new Map<string, PersistedContextRow>();
  if (clientIds.length === 0) return out;

  const { data, error } = await db()
    .from('client_context')
    .select(
      'id, client_id, reason_code, note, created_at, review_at, resolved_at',
    )
    .in('client_id', clientIds as string[])
    .is('resolved_at', null);
  if (error) {
    throw new Error(`fetchActiveContextsForClients: ${error.message}`);
  }

  for (const raw of (data ?? []) as Array<
    ContextRowFromDb & { client_id: string }
  >) {
    out.set(raw.client_id, rowFromDb(raw));
  }
  return out;
}

export type WriteClientContextInput = {
  clientId: string;
  coachUserId: string;
  reasonCode: ReasonCode;
  note?: string | null;
  reviewAt?: Date | null;
  at?: Date;
};

export type WriteClientContextResult =
  | { ok: true; id: string; supersededId: string | null }
  | { ok: false; error: string };

/**
 * Supersede-then-insert. The partial unique index forbids two
 * unresolved rows for the same client, so we MUST resolve the prior
 * one before inserting. If the prior resolution succeeds but the
 * insert fails, we leave the prior context resolved — that's the safer
 * direction (no permanent silent suppression).
 *
 * Callers (the POST endpoint in Surface 2) are responsible for the
 * audit_log write — this module stays storage-only so the audit/push
 * concerns live with the route, matching the deload.ts pattern.
 */
export async function writeClientContext(
  input: WriteClientContextInput,
): Promise<WriteClientContextResult> {
  const supa = db();
  const at = input.at ?? new Date();

  const { data: prior, error: priorErr } = await supa
    .from('client_context')
    .select('id')
    .eq('client_id', input.clientId)
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (priorErr) {
    return { ok: false, error: `fetch prior: ${priorErr.message}` };
  }

  let supersededId: string | null = null;
  if (prior) {
    supersededId = (prior as { id: string }).id;
    const { error: resolveErr } = await supa
      .from('client_context')
      .update({ resolved_at: at.toISOString() })
      .eq('id', supersededId);
    if (resolveErr) {
      return { ok: false, error: `supersede prior: ${resolveErr.message}` };
    }
  }

  const { data: inserted, error: insertErr } = await supa
    .from('client_context')
    .insert({
      client_id: input.clientId,
      reason_code: input.reasonCode,
      note: input.note ?? null,
      created_by: input.coachUserId,
      review_at: input.reviewAt ? input.reviewAt.toISOString() : null,
    })
    .select('id')
    .single();
  if (insertErr || !inserted) {
    return {
      ok: false,
      error: `insert context: ${insertErr?.message ?? 'unknown'}`,
    };
  }

  return { ok: true, id: (inserted as { id: string }).id, supersededId };
}
