import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { buildCue, type Best, type Prescription } from '@/lib/cue';
import { CueDisplay } from './cue-display';

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
    .select('id, exercise_id, status')
    .eq('workout_id', workout.id);
  const loggedIds = new Set((logs ?? []).map((l) => l.exercise_id));

  // Find first un-logged exercise. If all logged, show summary.
  const next = (exercises ?? []).find((e) => !loggedIds.has(e.id));

  if (!next) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
        <h1 className="text-2xl font-semibold">Workout done.</h1>
        <p className="text-neutral-400">Set entry + completion lands in M2.</p>
        <Link href="/today" className="text-emerald-400 underline">Back to today</Link>
      </main>
    );
  }

  // Best effort across all this client's exercises with the same name_key.
  const { data: best } = await supa
    .from('best_efforts')
    .select('best_weight, best_unit, best_reps')
    .eq('client_id', user.id)
    .eq('exercise_name_key', next.name_key)
    .maybeSingle();

  const bestEffort: Best | null = best
    ? { weight: best.best_weight, unit: best.best_unit, reps: best.best_reps }
    : null;

  const rx: Prescription = {
    setsPrescribed: next.prescribed_sets,
    repMin: next.rep_min,
    repMax: next.rep_max,
  };
  const cue = buildCue(bestEffort, rx);

  const completed = (logs ?? []).length;
  const total = (exercises ?? []).length;

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="flex items-center justify-between mb-4 text-sm text-neutral-400">
        <Link href="/today" className="hover:text-neutral-200">← {day?.label ?? 'Workout'}</Link>
        <span>
          {completed} / {total}
        </span>
      </header>

      <div className="flex-1 flex flex-col">
        {next.coach_note && (
          <div className="mb-4 rounded-xl border border-blue-700/40 bg-blue-950/30 px-4 py-3 text-sm text-blue-100">
            <p className="text-xs uppercase tracking-wide text-blue-300 mb-1">From your coach</p>
            <p>{next.coach_note}</p>
          </div>
        )}

        <p className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
          Exercise {next.position}
        </p>
        <h1 className="text-3xl font-bold leading-tight mb-2">{next.name}</h1>
        <p className="text-sm text-neutral-400 mb-6">
          {next.prescription_raw ?? '—'}
        </p>

        <CueDisplay cue={cue} />

        <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-sm text-neutral-300">
          <strong className="text-neutral-100">Warmup first.</strong> Do at least one
          warmup set with light weight and ensure form is perfect before logging
          working sets.
        </div>

        <div className="mt-auto pt-8">
          <button
            disabled
            className="w-full h-14 rounded-xl bg-neutral-800 text-neutral-500 font-semibold cursor-not-allowed"
          >
            Begin Set 1 (M2)
          </button>
          <p className="mt-3 text-center text-xs text-neutral-500">
            Set entry, rest timer, video upload, skip & pain reporting all land in M2.
          </p>
        </div>
      </div>
    </main>
  );
}
