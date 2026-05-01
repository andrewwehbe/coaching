/**
 * Daily plateau analysis cron.
 *
 * Required env: CRON_SECRET — request must include header `x-cron-secret`
 * matching this value, else 401. Vercel Cron is configured to send this
 * header (see vercel.json).
 *
 * For every active client, for every distinct exercise_name_key with at
 * least 4 logged exposures, computes consecutive_stalled and stage,
 * upserts stalled_history, fires an alert on escalation, and opens a
 * pending swap_proposals row when stage hits swap_candidate.
 */
import { NextResponse } from 'next/server';

import { db } from '@/lib/supabase';
import {
  buildExposureHistory,
  countConsecutiveStalled,
  isEscalation,
  stageFor,
  type ExerciseLogRow,
  type Stage,
} from '@/lib/plateau';

export const dynamic = 'force-dynamic';

type StalledRow = {
  client_id: string;
  exercise_name_key: string;
  consecutive_stalled: number;
  stage: Stage;
};

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 }
    );
  }
  if (req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supa = db();

  const { data: clients, error: clientsErr } = await supa
    .from('clients')
    .select('id')
    .eq('active', true);
  if (clientsErr) {
    return NextResponse.json({ error: clientsErr.message }, { status: 500 });
  }

  const summary: {
    client_id: string;
    exercises_processed: number;
    escalations: number;
    swap_proposals_opened: number;
  }[] = [];

  for (const client of clients ?? []) {
    const result = await analyzeClient(client.id);
    summary.push({ client_id: client.id, ...result });
  }

  return NextResponse.json({ ok: true, clients: summary.length, summary });
}

async function analyzeClient(clientId: string) {
  const supa = db();

  const { data: workouts } = await supa
    .from('workouts')
    .select('id,started_at')
    .eq('client_id', clientId);

  const workoutIds = (workouts ?? []).map((w) => w.id);
  if (workoutIds.length === 0) {
    return { exercises_processed: 0, escalations: 0, swap_proposals_opened: 0 };
  }
  const workoutById = new Map<string, { id: string; started_at: string }>(
    (workouts ?? []).map((w) => [w.id, w])
  );

  const { data: logs } = await supa
    .from('exercise_logs')
    .select('id,workout_id,exercise_id')
    .in('workout_id', workoutIds);

  const logsList = logs ?? [];
  const logIds = logsList.map((l) => l.id);
  const exerciseIds = Array.from(new Set(logsList.map((l) => l.exercise_id)));

  if (logIds.length === 0 || exerciseIds.length === 0) {
    return { exercises_processed: 0, escalations: 0, swap_proposals_opened: 0 };
  }

  const { data: setsRows } = await supa
    .from('sets')
    .select('exercise_log_id,weight,reps')
    .in('exercise_log_id', logIds);

  const setsByLog = new Map<
    string,
    { weight: number | null; reps: number | null }[]
  >();
  for (const s of setsRows ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      weight: s.weight === null ? null : Number(s.weight),
      reps: s.reps === null ? null : Number(s.reps),
    });
    setsByLog.set(s.exercise_log_id, arr);
  }

  const { data: exercises } = await supa
    .from('exercises')
    .select('id,name_key')
    .in('id', exerciseIds);

  const nameKeyByExId = new Map<string, string>(
    (exercises ?? []).map((e) => [e.id, e.name_key])
  );

  const logsByNameKey = new Map<string, ExerciseLogRow[]>();
  for (const l of logsList) {
    const key = nameKeyByExId.get(l.exercise_id);
    const w = workoutById.get(l.workout_id);
    if (!key || !w) continue;
    const sets = setsByLog.get(l.id) ?? [];
    if (sets.length === 0) continue;
    const arr = logsByNameKey.get(key) ?? [];
    arr.push({
      workoutId: l.workout_id,
      workoutStartedAt: w.started_at,
      sets,
    });
    logsByNameKey.set(key, arr);
  }

  const { data: priorRows } = await supa
    .from('stalled_history')
    .select('exercise_name_key,stage')
    .eq('client_id', clientId);
  const priorStage = new Map<string, Stage>(
    (priorRows ?? []).map((r) => [r.exercise_name_key, r.stage as Stage])
  );

  const { data: activeProgram } = await supa
    .from('programs')
    .select('id')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let activeExercises: { id: string; name_key: string }[] = [];
  if (activeProgram) {
    const { data: days } = await supa
      .from('days')
      .select('id')
      .eq('program_id', activeProgram.id);
    const dayIds = (days ?? []).map((d) => d.id);
    if (dayIds.length > 0) {
      const { data: rows } = await supa
        .from('exercises')
        .select('id,name_key,archived_at')
        .in('day_id', dayIds);
      activeExercises = (rows ?? [])
        .filter((r) => !r.archived_at)
        .map((r) => ({ id: r.id, name_key: r.name_key }));
    }
  }

  const upserts: (StalledRow & {
    weekly_exposures: unknown;
    computed_at: string;
  })[] = [];
  const alertInserts: {
    client_id: string;
    type: 'stalled';
    message: string;
    data: unknown;
  }[] = [];
  const swapInserts: {
    client_id: string;
    exercise_id: string;
    reason: string;
  }[] = [];

  let exercisesProcessed = 0;
  let escalations = 0;

  for (const [nameKey, logs] of logsByNameKey.entries()) {
    const history = buildExposureHistory(logs);
    if (history.length < 4) continue;

    exercisesProcessed++;
    const consecutiveStalled = countConsecutiveStalled(history);
    const stage = stageFor(consecutiveStalled);
    const prev = priorStage.get(nameKey) ?? 'none';

    upserts.push({
      client_id: clientId,
      exercise_name_key: nameKey,
      consecutive_stalled: consecutiveStalled,
      stage,
      weekly_exposures: history.map((h) => ({
        weight: h.weight,
        reps: h.reps,
        workout_id: h.workoutId,
        started_at: h.workoutStartedAt,
      })),
      computed_at: new Date().toISOString(),
    });

    if (stage !== 'none' && (prev === 'none' || isEscalation(prev, stage))) {
      escalations++;
      alertInserts.push({
        client_id: clientId,
        type: 'stalled',
        message: `${nameKey} entered ${stage} (${consecutiveStalled} stalled exposures).`,
        data: {
          exercise_name_key: nameKey,
          consecutive_stalled: consecutiveStalled,
          stage,
          previous_stage: prev,
        },
      });
    }

    if (stage === 'swap_candidate') {
      for (const ex of activeExercises) {
        if (ex.name_key !== nameKey) continue;
        swapInserts.push({
          client_id: clientId,
          exercise_id: ex.id,
          reason: `Stalled ${consecutiveStalled} consecutive exposures.`,
        });
      }
    }
  }

  if (upserts.length > 0) {
    await supa
      .from('stalled_history')
      .upsert(upserts, { onConflict: 'client_id,exercise_name_key' });
  }
  if (alertInserts.length > 0) {
    await supa.from('alerts').insert(alertInserts);
  }

  let proposalsOpened = 0;
  if (swapInserts.length > 0) {
    const exIds = Array.from(new Set(swapInserts.map((s) => s.exercise_id)));
    const { data: existing } = await supa
      .from('swap_proposals')
      .select('exercise_id')
      .eq('client_id', clientId)
      .eq('status', 'pending')
      .in('exercise_id', exIds);
    const existingSet = new Set((existing ?? []).map((e) => e.exercise_id));
    const toInsert = swapInserts.filter((s) => !existingSet.has(s.exercise_id));
    if (toInsert.length > 0) {
      await supa.from('swap_proposals').insert(toInsert);
      proposalsOpened = toInsert.length;
    }
  }

  return {
    exercises_processed: exercisesProcessed,
    escalations,
    swap_proposals_opened: proposalsOpened,
  };
}
