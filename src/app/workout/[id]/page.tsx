import { notFound, redirect } from 'next/navigation';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { buildCue, type Best, type Prescription } from '@/lib/cue';
import { loadBlockBests } from '@/lib/block-best';
import { WorkoutSession, type ExerciseState } from './workout-session';
import { WorkoutSessionAll, type ExerciseStateAll } from './workout-session-all';

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

  const [{ data: workout }, { data: clientPrefs }] = await Promise.all([
    supa
      .from('workouts')
      .select('id, day_id, completed_at, client_id, is_deload')
      .eq('id', id)
      .maybeSingle(),
    supa
      .from('clients')
      .select('log_mode')
      .eq('id', user.id)
      .maybeSingle(),
  ]);

  if (!workout || workout.client_id !== user.id) notFound();
  // Completed workouts have a canonical URL: the summary screen.
  if (workout.completed_at) redirect(`/workout/${id}/summary`);
  const logMode: 'sets' | 'best' | 'all' =
    clientPrefs?.log_mode === 'best'
      ? 'best'
      : clientPrefs?.log_mode === 'all'
        ? 'all'
        : 'sets';

  // day, exercises, logs are all keyed off workout.day_id / workout.id and
  // independent of each other — parallel fetch.
  const [{ data: day }, { data: exercises }, { data: logs }] = await Promise.all([
    supa.from('days').select('id, label, program_id').eq('id', workout.day_id).single(),
    supa
      .from('exercises')
      .select(
        'id, position, name, name_key, prescription_raw, prescribed_sets, rep_min, rep_max, coach_note, is_cardio, cardio_type'
      )
      .eq('day_id', workout.day_id)
      .is('archived_at', null)
      .order('position'),
    supa
      .from('exercise_logs')
      .select('id, exercise_id, status, sets(set_number, weight, unit, reps, rir, cardio_minutes, video_url, notes)')
      .eq('workout_id', workout.id),
  ]);

  // Best efforts and self-notes both depend on exercises' name_keys, so these
  // must follow. Keying notes by name_key (not exercise id) is what lets a
  // client's note to self persist across programs and re-appear next time.
  const nameKeys = Array.from(new Set((exercises ?? []).map((e) => e.name_key)));
  const [bests, selfNotes] = nameKeys.length
    ? await Promise.all([
        supa
          .from('best_efforts')
          .select('exercise_name_key, best_weight, best_unit, best_reps')
          .eq('client_id', user.id)
          .in('exercise_name_key', nameKeys)
          .then((r) => r.data ?? []),
        supa
          .from('exercise_self_notes')
          .select('exercise_name_key, note')
          .eq('client_id', user.id)
          .in('exercise_name_key', nameKeys)
          .then((r) => r.data ?? []),
      ])
    : [[], []];
  const bestByKey = new Map(bests.map((b) => [b.exercise_name_key, b]));
  const selfNoteByKey = new Map(
    selfNotes.map((n) => [n.exercise_name_key, n.note as string])
  );

  // Cue anchors to the best set logged in the CURRENT block (active program),
  // not the all-time best_efforts — so a stale peak or an old block doesn't
  // become a permanent target. Falls back to all-time best when the block has
  // no data yet (the opening "just log your weight" sessions).
  const blockBestByKey = await loadBlockBests(
    supa,
    user.id,
    day?.program_id ?? null,
    nameKeys
  );

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
      selfNote: selfNoteByKey.get(ex.name_key) ?? null,
      isCardio: ex.is_cardio,
      cardioType: ex.cardio_type,
      cue: buildCue(blockBestByKey.get(ex.name_key) ?? bestEffort, rx),
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

  if (logMode === 'all') {
    // Fetch prior-session sets. We anchor on the most recent COMPLETED workout
    // for this same day_id (not just any workout where the exercise appeared) —
    // that matches what the client trained last time on this day and avoids
    // mixing in stray sets from a different split.
    const { data: priorWorkout } = await supa
      .from('workouts')
      .select('id')
      .eq('client_id', user.id)
      .eq('day_id', workout.day_id)
      .not('completed_at', 'is', null)
      .neq('id', workout.id)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    type PriorLog = {
      exercise_id: string;
      exercises: { name_key: string } | { name_key: string }[];
      sets: LoggedSetRow[];
    };
    const priorByNameKey = new Map<string, LoggedSetRow[]>();
    const priorByExerciseId = new Map<string, LoggedSetRow[]>();
    if (priorWorkout) {
      const { data: priorLogs } = (await supa
        .from('exercise_logs')
        .select(`
          exercise_id,
          exercises:exercises!inner(name_key),
          sets(set_number, weight, unit, reps, rir, cardio_minutes, video_url, notes)
        `)
        .eq('workout_id', priorWorkout.id)
        .eq('status', 'completed')) as { data: PriorLog[] | null };
      for (const l of priorLogs ?? []) {
        const nameKey = Array.isArray(l.exercises) ? l.exercises[0]?.name_key : l.exercises?.name_key;
        const sets = (l.sets ?? []).slice().sort((a, b) => a.set_number - b.set_number);
        if (nameKey) priorByNameKey.set(nameKey, sets);
        priorByExerciseId.set(l.exercise_id, sets);
      }
    }

    const allStates: ExerciseStateAll[] = (exercises ?? []).map((ex) => {
      const log = (logs ?? []).find((l) => l.exercise_id === ex.id) ?? null;
      const priorRaw =
        priorByExerciseId.get(ex.id) ?? priorByNameKey.get(ex.name_key) ?? [];
      const prior = priorRaw.map((s) => ({
        setNumber: s.set_number,
        weight: s.weight,
        unit: s.unit,
        reps: s.reps,
        rir: s.rir,
        cardioMinutes: s.cardio_minutes,
        videoUrl: s.video_url,
        notes: s.notes,
      }));
      return {
        id: ex.id,
        name: ex.name,
        position: ex.position,
        prescriptionRaw: ex.prescription_raw,
        prescribedSets: ex.prescribed_sets,
        repMin: ex.rep_min,
        repMax: ex.rep_max,
        coachNote: ex.coach_note,
        selfNote: selfNoteByKey.get(ex.name_key) ?? null,
        isCardio: ex.is_cardio,
        cardioType: ex.cardio_type,
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
        priorSets: prior,
      };
    });

    return (
      <WorkoutSessionAll
        workoutId={workout.id}
        dayLabel={day?.label ?? 'Workout'}
        completed={!!workout.completed_at}
        isDeload={!!workout.is_deload}
        exercises={allStates}
      />
    );
  }

  return (
    <WorkoutSession
      workoutId={workout.id}
      dayLabel={day?.label ?? 'Workout'}
      completed={!!workout.completed_at}
      isDeload={!!workout.is_deload}
      logMode={logMode}
      exercises={states}
    />
  );
}
