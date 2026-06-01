import 'server-only';

import { db } from './supabase';
import { buildSuggestionsByClient, type Suggestion } from './suggestions';

export type ExerciseStatus =
  | 'good'
  | 'watch'
  | 'adjust'
  | 'swap_candidate'
  | 'pain';

export type ExerciseWithStatus = {
  id: string;
  name: string;
  prescribedSets: number | null;
  prescriptionRaw: string | null;
  isCardio: boolean;
  status: ExerciseStatus;
  suggestion: Suggestion | null;
};

export type DayWithExercises = {
  id: string;
  dayIndex: number;
  label: string;
  skippedSuggestion: Suggestion | null;
  exercises: ExerciseWithStatus[];
};

export type ClientIssues = {
  client: { id: string; name: string; weeklyDayTarget: number };
  daysDoneThisWeek: number;
  days: DayWithExercises[];
  allSuggestions: Suggestion[];
  hasActionableIssues: boolean;
  issueCount: number;
  applyAllCount: number;
};

type ProgramInput = {
  id: string;
  days: Array<{
    id: string;
    day_index: number;
    label: string;
    exercises: Array<{
      id: string;
      name: string;
      name_key: string;
      prescribed_sets: number | null;
      prescription_raw: string | null;
      is_cardio: boolean;
      archived_at: string | null;
      position: number;
    }>;
  }>;
};

// Per-suggestion-type ExerciseStatus mapping. null means the
// suggestion is NOT per-exercise — it attaches to a day, the program,
// or the week, so it shouldn't flip an exercise's status pill.
const TYPE_TO_STATUS: Record<Suggestion['type'], ExerciseStatus | null> = {
  watch: 'watch',
  adjust: 'adjust',
  swap_candidate: 'swap_candidate',
  pain: 'pain',
  adherence: null,
  skipped_day: null,
  // Stage 4-6 additions — all program/week scope, not per-exercise.
  // The fallback at the usage site (?? 'good') makes this defensive,
  // but a null mapping documents intent: these don't change exercise
  // status pills.
  deload: null,
  load_progression: null,
  high_rir_stall: null,
  weekly_note: null,
};

/**
 * Pure: map every active exercise in a program to its current status + the
 * suggestion (if any) that drives it. skipped_day suggestions attach at
 * day level, not to any exercise. Exported for unit tests.
 */
export function attachStatusToProgram(
  program: ProgramInput,
  suggestions: Suggestion[],
): DayWithExercises[] {
  // Index suggestions by exerciseId (from apply.exerciseIds) and by dayId
  // (for skipped_day).
  const suggestionByExerciseId = new Map<string, Suggestion>();
  const skippedByDayId = new Map<string, Suggestion>();
  for (const s of suggestions) {
    if (s.type === 'skipped_day' && s.apply?.kind === 'archive_day') {
      skippedByDayId.set(s.apply.dayId, s);
      continue;
    }
    if (s.apply && (s.apply.kind === 'add_set' || s.apply.kind === 'swap_exercise')) {
      for (const eid of s.apply.exerciseIds) {
        suggestionByExerciseId.set(eid, s);
      }
    } else if (s.type === 'watch') {
      // Watch suggestions have no apply, but their id encodes the name_key —
      // we infer the exerciseIds via the program below in a second pass.
      // Skipped here; handled in the day loop using name match.
    }
  }

  return program.days
    .slice()
    .sort((a, b) => a.day_index - b.day_index)
    .map((d) => {
      const activeExercises = d.exercises
        .filter((e) => e.archived_at == null)
        .sort((a, b) => a.position - b.position)
        .map((e): ExerciseWithStatus => {
          const sug = suggestionByExerciseId.get(e.id) ?? findWatchByName(suggestions, e.name);
          const status = sug ? TYPE_TO_STATUS[sug.type] ?? 'good' : 'good';
          return {
            id: e.id,
            name: e.name,
            prescribedSets: e.prescribed_sets,
            prescriptionRaw: e.prescription_raw,
            isCardio: e.is_cardio,
            status,
            suggestion: sug ?? null,
          };
        });

      return {
        id: d.id,
        dayIndex: d.day_index,
        label: d.label,
        skippedSuggestion: skippedByDayId.get(d.id) ?? null,
        exercises: activeExercises,
      };
    });
}

function findWatchByName(suggestions: Suggestion[], name: string): Suggestion | null {
  const target = name.trim().toLowerCase();
  for (const s of suggestions) {
    if (s.type !== 'watch') continue;
    // watch id format: `watch:${cid}:${nameKey}` where nameKey is the
    // lowercased display name (see lib/suggestions.ts).
    const parts = s.id.split(':');
    const nameKey = parts.slice(2).join(':');
    if (nameKey === target) return s;
  }
  return null;
}

/**
 * Orchestrator: pulls the client + active program + suggestions and returns
 * the full Issues view. Returns null when the client doesn't exist.
 */
export async function buildClientIssues(
  clientId: string,
  at: Date = new Date(),
): Promise<ClientIssues | null> {
  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, name, weekly_day_target')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return null;

  const [
    { data: programs },
    { data: weekWorkouts },
    suggestionsByClient,
  ] = await Promise.all([
    supa
      .from('programs')
      .select(
        'id, days(id, day_index, label, exercises(id, name, name_key, prescribed_sets, prescription_raw, is_cardio, archived_at, position))',
      )
      .eq('client_id', clientId)
      .eq('active', true)
      .maybeSingle(),
    supa
      .from('workouts')
      .select('id')
      .eq('client_id', clientId)
      .eq('week_start', isoMonday(at))
      .not('completed_at', 'is', null),
    buildSuggestionsByClient([clientId], at),
  ]);

  const suggestions = suggestionsByClient.get(clientId) ?? [];
  const days = programs
    ? attachStatusToProgram(programs as unknown as ProgramInput, suggestions)
    : [];

  const issueCount = suggestions.filter(
    (s) =>
      s.type === 'adjust' ||
      s.type === 'swap_candidate' ||
      s.type === 'pain' ||
      s.type === 'skipped_day',
  ).length;

  const applyAllCount = suggestions.filter(
    (s) => s.apply?.kind === 'add_set' || s.apply?.kind === 'archive_day',
  ).length;

  return {
    client: {
      id: client.id,
      name: client.name,
      weeklyDayTarget: client.weekly_day_target,
    },
    daysDoneThisWeek: weekWorkouts?.length ?? 0,
    days,
    allSuggestions: suggestions,
    hasActionableIssues: issueCount > 0,
    issueCount,
    applyAllCount,
  };
}

function isoMonday(at: Date): string {
  const d = new Date(at);
  const day = d.getDay();
  const diff = (day + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
