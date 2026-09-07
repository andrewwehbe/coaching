import 'server-only';

import { db } from './supabase';

/**
 * One row in a client's program history.
 *
 * "Started" prefers training_start_at over uploaded_at: a program uploaded
 * mid-mesocycle (see 0014) began before it entered the app, and the history
 * should show when they actually started training it, not when it was typed
 * in. "Ended" is the start of the next program — a block ends when the one
 * replacing it begins, which is more honest than the last logged workout
 * (clients skip the final week).
 */
export type ProgramHistoryEntry = {
  id: string;
  sourceFilename: string | null;
  isCurrent: boolean;
  startedAt: string;
  /** Null while current. */
  endedAt: string | null;
  /** Whole weeks, rounded down; running total for the current block. */
  durationWeeks: number;
  /** Day labels in order — the split at a glance. */
  dayLabels: string[];
  exerciseCount: number;
  workoutCount: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function listProgramHistory(
  clientId: string,
  now: Date = new Date(),
): Promise<ProgramHistoryEntry[]> {
  const supa = db();

  const { data: programs } = await supa
    .from('programs')
    .select('id, source_filename, active, uploaded_at, training_start_at')
    .eq('client_id', clientId)
    .order('uploaded_at', { ascending: false });

  if (!programs || programs.length === 0) return [];

  const ids = programs.map((p) => p.id);

  const [{ data: days }, { data: workouts }] = await Promise.all([
    supa
      .from('days')
      .select('id, program_id, day_index, label, exercises(id, archived_at)')
      .in('program_id', ids)
      .order('day_index'),
    // Counting client-side rather than one head-count per program: a client
    // with a dozen blocks would otherwise be a dozen round trips.
    supa
      .from('workouts')
      .select('id, day_id, days!inner(program_id)')
      .eq('client_id', clientId),
  ]);

  const labelsByProgram = new Map<string, string[]>();
  const liveExercisesByProgram = new Map<string, number>();
  for (const d of days ?? []) {
    const labels = labelsByProgram.get(d.program_id) ?? [];
    labels.push(d.label);
    labelsByProgram.set(d.program_id, labels);

    const live = (d.exercises ?? []).filter(
      (e: { archived_at: string | null }) => e.archived_at == null,
    ).length;
    liveExercisesByProgram.set(
      d.program_id,
      (liveExercisesByProgram.get(d.program_id) ?? 0) + live,
    );
  }

  const workoutsByProgram = new Map<string, number>();
  for (const w of workouts ?? []) {
    const raw = w.days as unknown;
    const d = (Array.isArray(raw) ? raw[0] : raw) as { program_id: string } | null;
    if (!d?.program_id) continue;
    workoutsByProgram.set(d.program_id, (workoutsByProgram.get(d.program_id) ?? 0) + 1);
  }

  // Newest first. Each program ends where the previous (newer) one started.
  const startOf = (p: (typeof programs)[number]) => p.training_start_at ?? p.uploaded_at;

  return programs.map((p, i) => {
    const startedAt = startOf(p);
    const newer = i > 0 ? programs[i - 1] : null;
    const endedAt = newer ? startOf(newer) : null;

    const endMs = endedAt ? new Date(endedAt).getTime() : now.getTime();
    const spanMs = Math.max(0, endMs - new Date(startedAt).getTime());

    return {
      id: p.id,
      sourceFilename: p.source_filename,
      isCurrent: p.active,
      startedAt,
      endedAt: p.active ? null : endedAt,
      durationWeeks: Math.floor(spanMs / WEEK_MS),
      dayLabels: labelsByProgram.get(p.id) ?? [],
      exerciseCount: liveExercisesByProgram.get(p.id) ?? 0,
      workoutCount: workoutsByProgram.get(p.id) ?? 0,
    };
  });
}

/** Full plan for one program — used by the expanded history row. */
export async function getProgramPlan(programId: string) {
  const supa = db();
  const { data: days } = await supa
    .from('days')
    .select(
      'id, day_index, label, exercises(id, position, name, prescription_raw, coach_note, muscle_group, superset_group, archived_at)',
    )
    .eq('program_id', programId)
    .order('day_index');

  return (days ?? []).map((d) => ({
    id: d.id,
    dayIndex: d.day_index,
    label: d.label,
    exercises: (d.exercises ?? [])
      .filter((e: { archived_at: string | null }) => e.archived_at == null)
      .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
      .map(
        (e: {
          id: string;
          position: number;
          name: string;
          prescription_raw: string | null;
          coach_note: string | null;
          muscle_group: string | null;
          superset_group: number | null;
        }) => ({
          id: e.id,
          position: e.position,
          name: e.name,
          prescriptionRaw: e.prescription_raw,
          coachNote: e.coach_note,
          muscleGroup: e.muscle_group,
          supersetGroup: e.superset_group,
        }),
      ),
  }));
}
