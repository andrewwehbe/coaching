import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCoachApi } from '@/lib/coach-guard';
import { audit } from '@/lib/audit';
import { writeClientContext } from '@/lib/client-context-store';
import type { ReasonCode } from '@/lib/signals/client-context';

type Params = Promise<{ id: string }>;

/**
 * Stage 6 Piece 3 Surface 2 — coach sets / replaces a client's context.
 *
 * The eight valid reason codes mirror the CHECK constraint in 0028
 * AND the switch arms in signals/client-context.getContextDirective.
 * Keeping the enum here in lockstep is intentional: the route is the
 * boundary; new codes need migration + directive + this enum, in the
 * same commit, by design.
 *
 * Supersede-then-insert lives in lib/client-context-store —
 * non-destructive (the prior context becomes resolved_at = now(), the
 * row stays for audit). audit_log fires AFTER successful write,
 * matching the deload route's pattern.
 */
const ReasonCodes = [
  'onboarding',
  'health',
  'injury',
  'travel',
  'life_stress',
  'planned_break',
  'at_risk',
  'paused',
] as const satisfies ReadonlyArray<ReasonCode>;

const Body = z.object({
  reason_code: z.enum(ReasonCodes),
  note: z.string().max(2000).nullish(),
  review_at: z
    .string()
    .datetime({ offset: true })
    .nullish(),
});

export async function POST(req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const reviewAt = parsed.data.review_at
    ? new Date(parsed.data.review_at)
    : null;

  const result = await writeClientContext({
    clientId: id,
    coachUserId: guard.user.id,
    reasonCode: parsed.data.reason_code,
    note: parsed.data.note ?? null,
    reviewAt,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  await audit({
    actorType: 'coach',
    actorId: guard.user.id,
    action: 'set_client_context',
    targetType: 'client',
    targetId: id,
    details: {
      context_id: result.id,
      reason_code: parsed.data.reason_code,
      review_at: parsed.data.review_at ?? null,
      superseded_id: result.supersededId,
    },
  });

  return NextResponse.json({
    ok: true,
    contextId: result.id,
    supersededId: result.supersededId,
  });
}
