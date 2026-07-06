import { notFound, redirect } from 'next/navigation';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { ExerciseHistoryClient, type HistorySession, type CurrentBest } from './history-client';

export const dynamic = 'force-dynamic';

type SetRow = {
  id: string;
  set_number: number;
  weight: number | null;
  unit: 'kg' | 'lb' | null;
  reps: number | null;
  rir: number | null;
  cardio_minutes: number | null;
};

type Search = Promise<{ ex?: string }>;

export default async function ExerciseHistoryPage(props: { searchParams: Search }) {
  const { ex } = await props.searchParams;
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'client') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const nameKey = (ex ?? '').trim();
  if (!nameKey) notFound();

  const supa = db();

  // Programs for this client → their days → the exercise rows that share this
  // movement key. Everything is scoped to the caller so history can't leak.
  const { data: progs } = await supa
    .from('programs')
    .select('id, active, uploaded_at, training_start_at')
    .eq('client_id', user.id);
  const programs = progs ?? [];
  if (programs.length === 0) notFound();

  const active = programs.find((p) => p.active) ?? null;
  const blockStartRaw = active?.training_start_at ?? active?.uploaded_at ?? null;
  const blockStart = blockStartRaw ? String(blockStartRaw).slice(0, 10) : null;

  const { data: days } = await supa
    .from('days')
    .select('id')
    .in('program_id', programs.map((p) => p.id));
  const dayIds = (days ?? []).map((d) => d.id as string);
  if (dayIds.length === 0) notFound();

  const { data: exs } = await supa
    .from('exercises')
    .select('id, name')
    .in('day_id', dayIds)
    .eq('name_key', nameKey);
  const exercises = exs ?? [];
  if (exercises.length === 0) notFound();
  const exIds = exercises.map((e) => e.id as string);
  // Display name: most recent program wins ties; any is fine — pick the first.
  const exerciseName = (exercises[0].name as string) ?? 'Exercise';

  // All this client's logs for those exercise rows, with their sets.
  const { data: logs } = await supa
    .from('exercise_logs')
    .select(
      'id, workout_id, sets(id, set_number, weight, unit, reps, rir, cardio_minutes)',
    )
    .in('exercise_id', exIds);
  const logRows = logs ?? [];
  const workoutIds = Array.from(new Set(logRows.map((l) => l.workout_id as string)));

  const [{ data: wkts }, { data: bestRow }] = await Promise.all([
    workoutIds.length
      ? supa
          .from('workouts')
          .select('id, started_at, week_start, is_deload')
          .eq('client_id', user.id)
          .in('id', workoutIds)
      : Promise.resolve({ data: [] as { id: string; started_at: string; week_start: string; is_deload: boolean }[] }),
    supa
      .from('best_efforts')
      .select('best_weight, best_unit, best_reps, source_set_id')
      .eq('client_id', user.id)
      .eq('exercise_name_key', nameKey)
      .maybeSingle(),
  ]);
  const workoutById = new Map(
    (wkts ?? []).map((w) => [w.id as string, w]),
  );

  // Build one entry per workout (session), newest first.
  const sessions: HistorySession[] = [];
  for (const log of logRows) {
    const w = workoutById.get(log.workout_id as string);
    if (!w) continue; // not this client's workout (defensive)
    const rawSets = ((log.sets as SetRow[] | undefined) ?? [])
      .filter((s) => s.weight != null && s.reps != null)
      .sort((a, b) => a.set_number - b.set_number);
    if (rawSets.length === 0) continue;
    const dateStr = String(w.started_at).slice(0, 10);
    sessions.push({
      workoutId: w.id as string,
      date: dateStr,
      isDeload: Boolean(w.is_deload),
      inCurrentBlock: blockStart ? dateStr >= blockStart : false,
      sets: rawSets.map((s) => ({
        setId: s.id,
        weight: Number(s.weight),
        unit: s.unit ?? 'kg',
        reps: s.reps as number,
        rir: s.rir,
      })),
    });
  }
  sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const currentBest: CurrentBest | null =
    bestRow && bestRow.best_weight != null
      ? {
          weight: Number(bestRow.best_weight),
          unit: (bestRow.best_unit as string | null) ?? 'kg',
          reps: (bestRow.best_reps as number | null) ?? null,
          sourceSetId: (bestRow.source_set_id as string | null) ?? null,
        }
      : null;

  return (
    <ExerciseHistoryClient
      exerciseName={exerciseName}
      sessions={sessions}
      currentBest={currentBest}
    />
  );
}
