import { NextResponse } from 'next/server';

import { requireCoachApi } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';

type Params = Promise<{ id: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const guard = await requireCoachApi();
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const supa = db();
  const { data: workout } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, week_start, is_deload')
    .eq('id', id)
    .maybeSingle();
  if (!workout) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: logs } = await supa
    .from('exercise_logs')
    .select(
      'id, exercise_id, status, skip_reason, pain_reason, client_note, exercises(name, position)',
    )
    .eq('workout_id', id);

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('id, exercise_log_id, set_number, weight, unit, reps, rir, cardio_minutes, notes')
        .in('exercise_log_id', logIds)
        .order('set_number')
    : { data: [] as never };

  const setsByLog = new Map<string, typeof sets>();
  for (const s of sets ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push(s);
    setsByLog.set(s.exercise_log_id, arr);
  }

  const exercises = (logs ?? [])
    .map((l) => {
      const raw = l.exercises as unknown;
      const ex = (Array.isArray(raw) ? raw[0] : raw) as
        | { name?: string; position?: number }
        | null;
      return {
        exercise_log_id: l.id,
        exercise_id: l.exercise_id,
        name: ex?.name ?? '(unknown)',
        position: ex?.position ?? 0,
        status: l.status,
        skip_reason: l.skip_reason,
        pain_reason: l.pain_reason,
        client_note: l.client_note,
        sets: setsByLog.get(l.id) ?? [],
      };
    })
    .sort((a, b) => a.position - b.position);

  return NextResponse.json({ workout, exercises });
}
