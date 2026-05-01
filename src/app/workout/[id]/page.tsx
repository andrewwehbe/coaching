import { notFound, redirect } from 'next/navigation';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { buildCue, type Best, type Prescription } from '@/lib/cue';
import { WorkoutSession, type ExerciseState } from './workout-session';

type LoggedSetRow = {
  set_number: number;
  weight: number | null;
  unit: 'kg' | 'lb' | null;
  reps: number | null;
  rir: number | null;
  cardio_minutes: number | null;
  video_url: string | null;
  notes: string | null;
};

type Params = Promise<{ id: string }>;

export default async function WorkoutPage(props: { params: Params }) {
  const { id } = await props.params;
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'client') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const supa = db();

  const { data: workout } = await supa
    .from('workouts')
    .select('id, day_id, completed_at, client_id')
    .eq('id', id)
    .maybeSingle();

  if (!workout || workout.client_id !== user.id) notFound();

  const { data: day } = await supa
    .from('days')
    .select('id, label')
    .eq('id', workout.day_id)
    .single();

  const { data: exercises } = await supa
    .from('exercises')
    .select(
      'id, position, name, name_key, prescription_raw, prescribed_sets, rep_min, rep_max, coach_note, is_cardio, cardio_type'
    )
    .eq('day_id', workout.day_id)
    .is('archived_at', null)
    .order('position');

  const { data: logs } = await supa
    .from('exercise_logs')
    .select('id, exercise_id, status, sets(set_number, weight, unit, reps, rir, cardio_minutes, video_url, notes)')
    .eq('workout_id', workout.id);

  // Best efforts for each exercise's name_key.
  const nameKeys = Array.from(new Set((exercises ?? []).map((e) => e.name_key)));
  const bests = nameKeys.length
    ? (
        await supa
          .from('best_efforts')
          .select('exercise_name_key, best_weight, best_unit, best_reps')
          .eq('client_id', user.id)
          .in('exercise_name_key', nameKeys)
      ).data ?? []
    : [];
  const bestByKey = new Map(bests.map((b) => [b.exercise_name_key, b]));

  const states: ExerciseState[] = (exercises ?? []).map((ex) => {
    const log = (logs ?? []).find((l) => l.exercise_id === ex.id) ?? null;
    const best = bestByKey.get(ex.name_key) ?? null;
    const bestEffort: Best | null = best
      ? { weight: best.best_weight, unit: best.best_unit, reps: best.best_reps }
      : null;
    const rx: Prescription = {
      setsPrescribed: ex.prescribed_sets,
      repMin: ex.rep_min,
      repMax: ex.rep_max,
    };
    return {
      id: ex.id,
      name: ex.name,
      position: ex.position,
      prescriptionRaw: ex.prescription_raw,
      prescribedSets: ex.prescribed_sets,
      repMin: ex.rep_min,
      repMax: ex.rep_max,
      coachNote: ex.coach_note,
      isCardio: ex.is_cardio,
      cardioType: ex.cardio_type,
      cue: buildCue(bestEffort, rx),
      logStatus: log?.status ?? null,
      sets: ((log?.sets as LoggedSetRow[] | undefined) ?? []).map((s) => ({
        setNumber: s.set_number,
        weight: s.weight,
        unit: s.unit,
        reps: s.reps,
        rir: s.rir,
        cardioMinutes: s.cardio_minutes,
        videoUrl: s.video_url,
        notes: s.notes,
      })),
    };
  });

  return (
    <WorkoutSession
      workoutId={workout.id}
      dayLabel={day?.label ?? 'Workout'}
      completed={!!workout.completed_at}
      exercises={states}
    />
  );
}
