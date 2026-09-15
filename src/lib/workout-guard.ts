import 'server-only';

import { readSession, type SessionUser } from './auth';
import { db } from './supabase';

export type OpenWorkout = {
  id: string;
  clientId: string;
  dayId: string;
  startedAt: string;
  completedAt: string | null;
  isDeload: boolean;
};

export type WorkoutClient = Extract<SessionUser, { type: 'client' }>;

export type WorkoutContext = {
  /**
   * The client the workout belongs to. For a client session this is the
   * session user. For a coach logging a PT client's session it is the PT
   * client, synthesized from the clients row, so every write stays keyed on
   * the right client id (sets, best_efforts, self notes).
   */
  user: WorkoutClient;
  /** Who is actually driving the screen. Alerts to the coach are skipped
   *  when the coach is the actor. */
  actor: 'client' | 'coach';
  workout: OpenWorkout;
};

/** Where the workout chrome's "back" links go for this actor. */
export function workoutHomeFor(ctx: Pick<WorkoutContext, 'actor' | 'user'>): {
  href: string;
  label: string;
} {
  return ctx.actor === 'coach'
    ? { href: `/coach/clients/${ctx.user.id}`, label: ctx.user.name }
    : { href: '/today', label: 'Today' };
}

type WorkoutRow = {
  id: string;
  client_id: string;
  day_id: string;
  started_at: string;
  completed_at: string | null;
  is_deload: boolean;
};

function toOpenWorkout(w: WorkoutRow): OpenWorkout {
  return {
    id: w.id,
    clientId: w.client_id,
    dayId: w.day_id,
    startedAt: w.started_at,
    completedAt: w.completed_at,
    isDeload: w.is_deload,
  };
}

/**
 * Resolves the workout and the identity allowed to act on it.
 *
 * - Client session: the workout must belong to that client (unchanged).
 * - Coach session: the workout must belong to an ACTIVE client of
 *   client_type 'pt'. PT clients have no login, so the coach runs their
 *   logger from the coach session. Online clients are never reachable this
 *   way.
 *
 * Returns null on any failure (route handlers map that to 401/404).
 */
export async function loadClientWorkout(
  workoutId: string
): Promise<WorkoutContext | null> {
  const user = await readSession();
  if (!user) return null;

  const supa = db();
  const { data: w } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, is_deload')
    .eq('id', workoutId)
    .maybeSingle();
  if (!w) return null;

  if (user.type === 'client') {
    if (!user.active || w.client_id !== user.id) return null;
    return { user, actor: 'client', workout: toOpenWorkout(w) };
  }

  // Coach path.
  const { data: c } = await supa
    .from('clients')
    .select('id, name, greeting_name, active, client_type')
    .eq('id', w.client_id)
    .maybeSingle();
  if (!c || !c.active || c.client_type !== 'pt') return null;

  return {
    user: {
      type: 'client',
      id: c.id,
      name: c.name,
      greetingName: c.greeting_name ?? c.name,
      active: c.active,
    },
    actor: 'coach',
    workout: toOpenWorkout(w),
  };
}

/**
 * Same as loadClientWorkout but additionally requires the workout to be
 * un-completed. Used for write endpoints (set, skip, pain).
 */
export async function loadOpenClientWorkout(
  workoutId: string
): Promise<WorkoutContext | null> {
  const ctx = await loadClientWorkout(workoutId);
  if (!ctx) return null;
  if (ctx.workout.completedAt) return null;
  return ctx;
}
