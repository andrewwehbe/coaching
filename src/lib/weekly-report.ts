import 'server-only';

import { startOfWeek, formatISO } from 'date-fns';

import { db } from './supabase';
import { buildSuggestionsByClient, type Suggestion } from './suggestions';
import { pickTopPRsByClient } from './signals/progression';
import {
  buildWeeklyCoachingNote,
  type PRObservation,
  type AccessoryTweakObservation,
} from './signals/weekly-note';
import {
  getActiveClientContext,
  getContextDirective,
} from './signals/client-context';
import { fetchActiveContextsForClients } from './client-context-store';

export type ClientWeekRow = {
  clientId: string;
  name: string;
  daysDone: number;
  daysTarget: number;
  totalSets: number;
  videos: number;
  painExercises: number;
  stalledEscalations: number;
  prs: number;
  bodyWeight: { value: number; unit: string; deltaFromPrior: number | null } | null;
  checkedIn: boolean;
  suggestions: Suggestion[];
};

export type WeeklyReport = {
  weekStart: string;
  rows: ClientWeekRow[];
  totals: {
    activeClients: number;
    completionPct: number;
    totalSets: number;
    totalVideos: number;
    totalPain: number;
    totalPRs: number;
  };
};

/**
 * Builds the weekly report in a small, fixed number of round-trips no matter
 * how many clients there are. Was per-client loop with ~7 queries each
 * (17 clients = ~120 sequential round-trips, ~5s); now ~7 batched queries
 * total in parallel.
 */
export async function buildWeeklyReport(at: Date = new Date()): Promise<WeeklyReport> {
  const supa = db();
  const weekStart = startOfWeek(at, { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });
  const weekStartTs = new Date(weekStart).toISOString();

  const { data: clients } = await supa
    .from('clients')
    .select('id, name, weekly_day_target, created_at')
    .eq('active', true)
    .order('name');

  if (!clients || clients.length === 0) {
    return {
      weekStart: weekStartIso,
      rows: [],
      totals: {
        activeClients: 0,
        completionPct: 0,
        totalSets: 0,
        totalVideos: 0,
        totalPain: 0,
        totalPRs: 0,
      },
    };
  }

  const ids = clients.map((c) => c.id);

  const [
    { data: weekWorkouts },
    { data: prRows },
    { data: stalledRows },
    { data: thisWeekCheckIns },
    { data: priorCheckIns },
    { data: allTimeCompletedRows },
    persistedContextByClient,
    suggestionsByClient,
  ] = await Promise.all([
    supa
      .from('workouts')
      .select('id, client_id, completed_at')
      .in('client_id', ids)
      .eq('week_start', weekStartIso),
    supa
      .from('best_efforts')
      .select('client_id, exercise_name_key, best_weight, best_unit, best_reps')
      .in('client_id', ids)
      .gte('updated_at', weekStartTs)
      .not('source_set_id', 'is', null),
    supa
      .from('alerts')
      .select('client_id')
      .in('client_id', ids)
      .eq('type', 'stalled')
      .gte('created_at', weekStartTs),
    supa
      .from('check_ins')
      .select('client_id, date, body_weight, body_weight_unit')
      .in('client_id', ids)
      .gte('date', weekStartIso)
      .order('date', { ascending: false }),
    supa
      .from('check_ins')
      .select('client_id, body_weight, body_weight_unit, date')
      .in('client_id', ids)
      .lt('date', weekStartIso)
      .not('body_weight', 'is', null)
      .order('date', { ascending: false }),
    // Stage 6 Piece 3 — all-time completed-workout flag per client.
    // Powers the hasNoLogs input for the synthesized onboarding check
    // in the catch-all branch below. limit(1) per-client is the cheapest
    // shape; we just need "did this client EVER log a workout."
    supa
      .from('workouts')
      .select('client_id')
      .in('client_id', ids)
      .not('completed_at', 'is', null),
    fetchActiveContextsForClients(ids),
    buildSuggestionsByClient(ids, at),
  ]);

  const completedWorkoutIds = (weekWorkouts ?? [])
    .filter((w) => w.completed_at)
    .map((w) => w.id);

  const clientsWithAnyLog = new Set<string>(
    (allTimeCompletedRows ?? []).map((r) => r.client_id as string),
  );

  // exercise_logs + sets in parallel — sets needs log ids, so it's serial,
  // but a single batched query each.
  const { data: weekLogs } = completedWorkoutIds.length
    ? await supa
        .from('exercise_logs')
        .select('id, workout_id, pain_reason')
        .in('workout_id', completedWorkoutIds)
    : { data: [] as Array<{ id: string; workout_id: string; pain_reason: string | null }> };

  const logIds = (weekLogs ?? []).map((l) => l.id);
  const { data: weekSets } = logIds.length
    ? await supa
        .from('sets')
        .select('exercise_log_id, video_url')
        .in('exercise_log_id', logIds)
    : { data: [] as Array<{ exercise_log_id: string; video_url: string | null }> };

  // --- Group all the batched results by client_id ---
  const completedByClient = new Map<string, string[]>();
  for (const w of weekWorkouts ?? []) {
    if (!w.completed_at) continue;
    const arr = completedByClient.get(w.client_id) ?? [];
    arr.push(w.id);
    completedByClient.set(w.client_id, arr);
  }

  const workoutToClient = new Map<string, string>();
  for (const w of weekWorkouts ?? []) workoutToClient.set(w.id, w.client_id);

  const logToClient = new Map<string, string>();
  const painByClient = new Map<string, number>();
  for (const l of weekLogs ?? []) {
    const cid = workoutToClient.get(l.workout_id);
    if (!cid) continue;
    logToClient.set(l.id, cid);
    if (l.pain_reason) painByClient.set(cid, (painByClient.get(cid) ?? 0) + 1);
  }

  const setsByClient = new Map<string, number>();
  const videosByClient = new Map<string, number>();
  for (const s of weekSets ?? []) {
    const cid = logToClient.get(s.exercise_log_id);
    if (!cid) continue;
    setsByClient.set(cid, (setsByClient.get(cid) ?? 0) + 1);
    if (s.video_url) videosByClient.set(cid, (videosByClient.get(cid) ?? 0) + 1);
  }

  const prsByClient = new Map<string, number>();
  for (const r of prRows ?? []) {
    prsByClient.set(r.client_id, (prsByClient.get(r.client_id) ?? 0) + 1);
  }
  // Top PR per client by e1RM for the Stage-5 weekly-note tier-1
  // celebration — kg-normalized via the shared helper (the old inline
  // compare on raw weight mis-ranked mixed-unit PRs).
  const topPRByClient: Map<string, PRObservation> = pickTopPRsByClient(
    prRows ?? [],
  );

  const stalledByClient = new Map<string, number>();
  for (const r of stalledRows ?? [])
    stalledByClient.set(r.client_id, (stalledByClient.get(r.client_id) ?? 0) + 1);

  // First (most recent) check-in this week per client.
  const thisWeekCiByClient = new Map<
    string,
    { body_weight: number | null; body_weight_unit: string | null; date: string }
  >();
  for (const r of thisWeekCheckIns ?? []) {
    if (thisWeekCiByClient.has(r.client_id)) continue;
    thisWeekCiByClient.set(r.client_id, {
      body_weight: r.body_weight === null ? null : Number(r.body_weight),
      body_weight_unit: r.body_weight_unit,
      date: r.date,
    });
  }

  // First (most recent) PRIOR check-in with body weight per client.
  const priorCiByClient = new Map<
    string,
    { body_weight: number; body_weight_unit: string | null }
  >();
  for (const r of priorCheckIns ?? []) {
    if (priorCiByClient.has(r.client_id) || r.body_weight == null) continue;
    priorCiByClient.set(r.client_id, {
      body_weight: Number(r.body_weight),
      body_weight_unit: r.body_weight_unit,
    });
  }

  // Stage 5 wiring: gather untagged active exercises per client so the
  // weekly note's tier-4 (accessory tweak) can surface one. One batched
  // query — joins exercises → days → active programs and filters
  // muscle_group IS NULL.
  const untaggedByClient = new Map<string, AccessoryTweakObservation>();
  {
    const { data: untagged } = await supa
      .from('exercises')
      .select('name, days!inner(programs!inner(client_id, active))')
      .is('archived_at', null)
      .is('muscle_group', null);
    for (const row of untagged ?? []) {
      const dRaw = row.days as unknown;
      const d = (Array.isArray(dRaw) ? dRaw[0] : dRaw) as {
        programs?: { client_id?: string; active?: boolean } | null;
      } | null;
      const cid = d?.programs?.active === true ? d?.programs?.client_id : null;
      if (!cid || !ids.includes(cid)) continue;
      if (untaggedByClient.has(cid)) continue; // one per client is enough
      untaggedByClient.set(cid, { exerciseName: row.name });
    }
  }

  let totalSets = 0;
  let totalVideos = 0;
  let totalPain = 0;
  let totalPRs = 0;
  let totalDaysDone = 0;
  let totalTarget = 0;

  const rows: ClientWeekRow[] = clients.map((c) => {
    const daysDone = completedByClient.get(c.id)?.length ?? 0;
    const setCount = setsByClient.get(c.id) ?? 0;
    const videoCount = videosByClient.get(c.id) ?? 0;
    const painExercises = painByClient.get(c.id) ?? 0;
    const prs = prsByClient.get(c.id) ?? 0;
    const stalledEscalations = stalledByClient.get(c.id) ?? 0;
    const thisCi = thisWeekCiByClient.get(c.id);

    let bodyWeight: ClientWeekRow['bodyWeight'] = null;
    if (thisCi?.body_weight != null) {
      const prior = priorCiByClient.get(c.id);
      const sameUnit =
        !prior || (prior.body_weight_unit ?? 'kg') === (thisCi.body_weight_unit ?? 'kg');
      bodyWeight = {
        value: thisCi.body_weight,
        unit: thisCi.body_weight_unit ?? 'kg',
        deltaFromPrior:
          prior && sameUnit ? Number((thisCi.body_weight - prior.body_weight).toFixed(1)) : null,
      };
    }

    totalSets += setCount;
    totalVideos += videoCount;
    totalPain += painExercises;
    totalPRs += prs;
    totalDaysDone += daysDone;
    totalTarget += c.weekly_day_target;

    // Stage 5 v2: weekly notes are now emitted inside buildSuggestionsByClient
    // (where the per-exercise meanTopSetRir + program context for the
    // tier-2 effort-gap computation already live). This block runs as a
    // safety catch-all for the rare edge case where suggestions.ts
    // can't emit (e.g. client with no active program → if-block skipped
    // → empty suggestion list). Always-non-null property is preserved.
    const perClientSuggestions = suggestionsByClient.get(c.id) ?? [];
    if (perClientSuggestions.length === 0) {
      const adherenceRatio = c.weekly_day_target > 0
        ? Math.min(1, daysDone / c.weekly_day_target)
        : 0;
      // Stage 6 Piece 3 — context template flows into the catch-all so
      // a context-active client (ClientC onboarding, persisted health,
      // at_risk re-engagement, etc.) gets the tier-0 framing even when
      // suggestions.ts's structural block was suppressed by the
      // directive (which is the normal path for these clients).
      const createdAt = c.created_at ? new Date(c.created_at as string) : null;
      const activeContext = createdAt
        ? getActiveClientContext({
            at,
            persistedRow: persistedContextByClient.get(c.id) ?? null,
            clientCreatedAt: createdAt,
            hasNoLogs: !clientsWithAnyLog.has(c.id),
          })
        : null;
      const directive = activeContext
        ? getContextDirective(activeContext.reasonCode)
        : null;
      const note = buildWeeklyCoachingNote({
        clientId: c.id,
        clientName: c.name,
        contextTemplate: directive?.weeklyNoteTemplate ?? null,
        topPR: topPRByClient.get(c.id) ?? null,
        effortGap: null,
        primaryRirTarget: null,
        untaggedExercise: untaggedByClient.get(c.id) ?? null,
        adherenceRatio,
      });
      perClientSuggestions.push(note);
    }

    return {
      clientId: c.id,
      name: c.name,
      daysDone,
      daysTarget: c.weekly_day_target,
      totalSets: setCount,
      videos: videoCount,
      painExercises,
      stalledEscalations,
      prs,
      bodyWeight,
      checkedIn: thisCi != null,
      suggestions: perClientSuggestions,
    };
  });

  const completionPct =
    totalTarget === 0 ? 0 : Math.round((totalDaysDone / totalTarget) * 100);

  return {
    weekStart: weekStartIso,
    rows,
    totals: {
      activeClients: rows.length,
      completionPct,
      totalSets,
      totalVideos,
      totalPain,
      totalPRs,
    },
  };
}
