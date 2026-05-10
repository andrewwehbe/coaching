import 'server-only';

import { db } from './supabase';

/**
 * Coach↔client link lookup. Replaces the hardcoded LINKED_CLIENT_ID env
 * fallback with a row in the coach_links table (one row per coach,
 * pointing at the coach's personal client account).
 *
 * Env COACH_LINKED_CLIENT_ID / CLIENT_LINKED_COACH_ID are still honored
 * as a fallback during the migration window — once coach_links is
 * populated they become inert.
 */

export type CoachLink = { coachId: string; clientId: string };

export async function linkForCoach(coachId: string): Promise<CoachLink | null> {
  const supa = db();
  const { data } = await supa
    .from('coach_links')
    .select('coach_id, client_id')
    .eq('coach_id', coachId)
    .maybeSingle();
  if (data) return { coachId: data.coach_id, clientId: data.client_id };

  const envClientId = process.env.COACH_LINKED_CLIENT_ID;
  if (envClientId) return { coachId, clientId: envClientId };
  return null;
}

export async function linkForClient(clientId: string): Promise<CoachLink | null> {
  const supa = db();
  const { data } = await supa
    .from('coach_links')
    .select('coach_id, client_id')
    .eq('client_id', clientId)
    .maybeSingle();
  if (data) return { coachId: data.coach_id, clientId: data.client_id };

  const envClientId = process.env.COACH_LINKED_CLIENT_ID;
  const envCoachId = process.env.CLIENT_LINKED_COACH_ID;
  if (envClientId && envCoachId && envClientId === clientId) {
    return { coachId: envCoachId, clientId };
  }
  return null;
}
