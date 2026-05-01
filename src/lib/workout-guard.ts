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

export type WorkoutContext = {
  user: Extract<SessionUser, { type: 'client' }>;
  workout: OpenWorkout;
};

/**
 * Loads the current client session, verifies the workout exists and
 * belongs to them, and returns both. Returns null on any failure
 * (route handlers should map that to 401/404).
 */
export async function loadClientWorkout(
  workoutId: string
): Promise<WorkoutContext | null> {
  const user = await readSession();
  if (!user || user.type !== 'client' || !user.active) return null;

  const supa = db();
  const { data: w } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, is_deload')
    .eq('id', workoutId)
    .maybeSingle();

  if (!w || w.client_id !== user.id) return null;

  return {
    user,
    workout: {
      id: w.id,
      clientId: w.client_id,
      dayId: w.day_id,
      startedAt: w.started_at,
      completedAt: w.completed_at,
      isDeload: w.is_deload,
    },
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
