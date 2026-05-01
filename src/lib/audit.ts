import 'server-only';

import { db } from './supabase';

export type ActorType = 'coach' | 'client' | 'system';

export async function audit(params: {
  actorType: ActorType;
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  const supa = db();
  await supa.from('audit_log').insert({
    actor_type: params.actorType,
    actor_id: params.actorId,
    action: params.action,
    target_type: params.targetType ?? null,
    target_id: params.targetId ?? null,
    details: params.details ?? null,
  });
}
