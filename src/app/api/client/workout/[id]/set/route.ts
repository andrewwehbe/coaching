import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { SESSION_COOKIE } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { prDeltaMessage, type BestSnapshot } from '@/lib/best-effort';
import { log as logger } from '@/lib/log';

const Body = z.object({
  exerciseId: z.string().uuid(),
  setNumber: z.number().int().min(1).max(20),
  // Bounds mirror the sets_weight_sane DB check (0035) so fat-fingers get
  // a friendly 400 instead of a DB error. Negatives are legitimate — the
  // logger's ± toggle covers counterweighted machines.
  weight: z.number().min(-500).max(1500).nullable().optional(),
  unit: z.enum(['kg', 'lb']).nullable().optional(),
  reps: z.number().int().min(1).max(200).nullable().optional(),
  rir: z.number().int().min(0).max(10).nullable().optional(),
  cardioMinutes: z.number().int().min(1).max(180).nullable().optional(),
  // Bucket-relative storage path returned by /api/client/upload-url.
  // Stored as-is in sets.video_url (legacy column name) and signed at read time.
  videoPath: z.string().min(1).max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

type Params = Promise<{ id: string }>;

/**
 * Hot path: called for every set a client logs (~every 90s mid-workout).
 * The entire write — session auth, ownership guard, exercise verify,
 * log + set upserts, best-effort/PR update — runs inside the log_set
 * Postgres function (0037): one DB round trip, one transaction. The PR
 * delta message is built here from the returned prev snapshot so the
 * tested pure helper stays the single source of truth.
 */
export async function POST(req: Request, props: { params: Params }) {
  const { id } = await props.params;

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    logger.warn('set.invalid_payload', {
      workoutId: id,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json({ error: 'Invalid set payload' }, { status: 400 });
  }

  const supa = db();
  const { data, error } = await supa.rpc('log_set', {
    p_token: token,
    p_workout_id: id,
    p_exercise_id: parsed.data.exerciseId,
    p_set_number: parsed.data.setNumber,
    p_weight: parsed.data.weight ?? null,
    p_unit: parsed.data.unit ?? null,
    p_reps: parsed.data.reps ?? null,
    p_rir: parsed.data.rir ?? null,
    p_cardio_minutes: parsed.data.cardioMinutes ?? null,
    p_video_path: parsed.data.videoPath ?? null,
    p_notes: parsed.data.notes ?? null,
  });

  if (error) {
    logger.error('set.rpc_failed', error, { workoutId: id });
    return NextResponse.json({ error: 'Failed to save set' }, { status: 500 });
  }

  const result = data as {
    error?: 'unauthorized' | 'exercise_mismatch' | 'invalid_video_path';
    ok?: true;
    set_id?: string;
    log_id?: string;
    pr?: { prev: { weight: number; unit: string | null; reps: number } | null } | null;
  };

  if (result?.error === 'unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (result?.error === 'exercise_mismatch') {
    return NextResponse.json(
      { error: 'Exercise not in this workout' },
      { status: 400 },
    );
  }
  if (result?.error === 'invalid_video_path') {
    logger.warn('set.video_path_rejected', { workoutId: id });
    return NextResponse.json({ error: 'Invalid video path' }, { status: 400 });
  }
  if (!result?.ok) {
    return NextResponse.json({ error: 'Failed to save set' }, { status: 500 });
  }

  let prMessage: string | null = null;
  if (result.pr && parsed.data.weight != null && parsed.data.reps != null) {
    const prev: BestSnapshot | null = result.pr.prev
      ? {
          weight: Number(result.pr.prev.weight),
          unit: result.pr.prev.unit,
          reps: result.pr.prev.reps,
        }
      : null;
    prMessage = prDeltaMessage(prev, {
      weight: parsed.data.weight,
      unit: parsed.data.unit ?? null,
      reps: parsed.data.reps,
    });
  }

  return NextResponse.json({
    ok: true,
    setId: result.set_id,
    logId: result.log_id,
    pr: prMessage ? { message: prMessage } : null,
  });
}
