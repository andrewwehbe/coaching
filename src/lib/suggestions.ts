import 'server-only';

import { startOfWeek, formatISO, subWeeks, differenceInCalendarWeeks } from 'date-fns';

import { db } from './supabase';
import {
  buildExposureHistory,
  countConsecutiveStalled,
  type ExerciseLogRow,
  type Exposure,
} from './plateau';
import { matchCatalogForMany, type CatalogEntry } from './catalog';
import {
  SUGGEST_WATCH_MIN as WATCH_MIN,
  SUGGEST_ADJUST_MIN as ADJUST_MIN,
  SUGGEST_SWAP_MIN as SWAP_MIN,
  SUGGEST_SWAP_MIN_PROGRAM_WEEK as SWAP_MIN_PROGRAM_WEEK,
  ADHERENCE_LOOKBACK_WEEKS,
  ADHERENCE_MIN_DAYS,
} from './config';

/**
 * Per-client suggestions for the weekly report. Implements the staged
 * plateau rules from the spec (§5):
 *   - WATCH at ≥2 stalled exposures, ADJUST at ≥3, SWAP_CANDIDATE at ≥4
 *   - SWAP downgraded to ADJUST if currentWeek < 6 (too early)
 *   - WATCH/ADJUST/SWAP suppressed if adherence is low
 *     (<4 logged days across last 2 weeks)
 *   - PAIN findings always fire
 *   - Skipped-day finding when a previously-active day stops getting logs
 *
 * Plateau aggregation is by exercise NAME across all days (§10.7) — the
 * cue logic is day-scoped via name_key, but the analysis collates.
 *
 * Auto-apply support is currently:
 *   - 'add_set' for ADJUST: bumps prescribed_sets by 1 on the named
 *     exercise across every day where it appears
 *   - 'archive_day' for SKIPPED_DAY (≥2 weeks dormant): soft-deletes
 *     exercises in that day so the day stops appearing in /today
 * SWAP_CANDIDATE and PAIN suggestions are informational for now —
 * applying them needs the curated exercise list (coming separately).
 */

const PAIN_REGEX = /pain|hurt|injur|tweak|sharp|sore.*bad/i;

export type SuggestionApplyKind = 'add_set' | 'archive_day';

export type Suggestion = {
  id: string; // stable per-client + per-target so the UI can dedupe
  type: 'watch' | 'adjust' | 'swap_candidate' | 'pain' | 'adherence' | 'skipped_day';
  title: string;
  body: string;
  apply?:
    | { kind: 'add_set'; exerciseIds: string[]; targetName: string }
    | { kind: 'archive_day'; dayId: string; dayLabel: string }
    | {
        kind: 'swap_exercise';
        exerciseIds: string[];
        targetName: string;
        alternatives: { name: string; group_key: string }[];
      }
    | null;
};

export type ClientSuggestions = {
  clientId: string;
  suggestions: Suggestion[];
};

export async function buildSuggestionsByClient(
  clientIds: string[],
  at: Date = new Date(),
): Promise<Map<string, Suggestion[]>> {
  const result = new Map<string, Suggestion[]>();
  if (clientIds.length === 0) return result;

  const supa = db();

  const thisWeekStart = startOfWeek(at, { weekStartsOn: 1 });
  const lastWeekStart = subWeeks(thisWeekStart, 1);
  const thisWeekIso = formatISO(thisWeekStart, { representation: 'date' });
  const lastWeekIso = formatISO(lastWeekStart, { representation: 'date' });

  // Fetch active programs + days + exercises for each client.
  // Also fetch historical_exposures so we can prepend pre-app data
  // (parsed from coach's sheets via scripts/import-history.ts) ahead of
  // in-app workouts for the plateau analysis.
  const [{ data: programs }, { data: historical }] = await Promise.all([
    supa
      .from('programs')
      .select('id, client_id, uploaded_at, training_start_at, days(id, day_index, label, exercises(id, name, name_key, prescribed_sets, archived_at))')
      .in('client_id', clientIds)
      .eq('active', true),
    supa
      .from('historical_exposures')
      .select('client_id, exercise_name_key, week_index, weight, unit, reps')
      .in('client_id', clientIds)
      .order('week_index', { ascending: true }),
  ]);

  type ExRow = { id: string; name: string; name_key: string; prescribed_sets: number | null; archived_at: string | null };
  type DayRow = { id: string; day_index: number; label: string; exercises: ExRow[] };
  type ProgRow = { id: string; client_id: string; uploaded_at: string; training_start_at: string | null; days: DayRow[] };

  const programByClient = new Map<string, ProgRow>();
  for (const p of (programs ?? []) as unknown as ProgRow[]) {
    programByClient.set(p.client_id, p);
  }

  // Fetch every completed workout for these clients (id + when + day_id).
  const { data: workouts } = await supa
    .from('workouts')
    .select('id, client_id, day_id, started_at, completed_at, week_start')
    .in('client_id', clientIds)
    .not('completed_at', 'is', null)
    .order('started_at', { ascending: true });

  const completedWorkoutsByClient = new Map<
    string,
    { id: string; day_id: string; started_at: string; week_start: string }[]
  >();
  for (const w of workouts ?? []) {
    const arr = completedWorkoutsByClient.get(w.client_id) ?? [];
    arr.push({ id: w.id, day_id: w.day_id, started_at: w.started_at, week_start: w.week_start });
    completedWorkoutsByClient.set(w.client_id, arr);
  }

  const allWorkoutIds = (workouts ?? []).map((w) => w.id);

  // Fetch exercise_logs (with name + sets) for ALL completed workouts in one batch.
  const { data: logs } = allWorkoutIds.length
    ? await supa
        .from('exercise_logs')
        .select('id, workout_id, exercise_id, pain_reason, client_note, exercises(name, name_key)')
        .in('workout_id', allWorkoutIds)
    : { data: [] as Array<{ id: string; workout_id: string; exercise_id: string; pain_reason: string | null; client_note: string | null; exercises: unknown }> };

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select('exercise_log_id, weight, reps')
        .in('exercise_log_id', logIds)
    : { data: [] as Array<{ exercise_log_id: string; weight: number | string | null; reps: number | null }> };

  const setsByLog = new Map<string, { weight: number | null; reps: number | null }[]>();
  for (const s of sets ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      weight: s.weight === null ? null : Number(s.weight),
      reps: s.reps === null ? null : s.reps,
    });
    setsByLog.set(s.exercise_log_id, arr);
  }

  const workoutToClient = new Map<string, string>();
  for (const w of workouts ?? []) workoutToClient.set(w.id, w.client_id);

  for (const cid of clientIds) result.set(cid, []);

  // ---- PAIN findings (this week's logs only) ----
  const thisWeekStartTs = new Date(thisWeekStart).toISOString();
  // Track pain suggestions by (clientId, exerciseName) so we attach
  // exerciseIds / catalog alternatives in the final enrichment pass.
  const painPending: Array<{ clientId: string; exName: string; suggestionIndex: number }> = [];

  for (const l of logs ?? []) {
    const cid = workoutToClient.get(l.workout_id);
    if (!cid) continue;
    const ws = completedWorkoutsByClient.get(cid)?.find((w) => w.id === l.workout_id);
    if (!ws || new Date(ws.started_at).toISOString() < thisWeekStartTs) continue;
    const note = l.client_note ?? '';
    const reason = l.pain_reason ?? '';
    const flagged = !!l.pain_reason || PAIN_REGEX.test(note);
    if (!flagged) continue;
    const exRaw = l.exercises as unknown;
    const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as { name?: string } | null;
    const exName = ex?.name ?? 'an exercise';
    const snippet = (reason || note).trim().slice(0, 80);
    const arr = result.get(cid)!;
    arr.push({
      id: `pain:${l.id}`,
      type: 'pain',
      title: `Pain on ${exName}`,
      body: snippet
        ? `"${snippet}". Swap to a different angle/length variant — prefer unilateral or machine. Drop load 20% on first session back.`
        : 'Pain flagged this session. Swap to a different angle/length variant; drop load 20% on first session back.',
      apply: null,
    });
    painPending.push({ clientId: cid, exName, suggestionIndex: arr.length - 1 });
  }

  // ---- For each client: adherence, plateau, skipped-day ----
  for (const cid of clientIds) {
    const out = result.get(cid)!;
    const prog = programByClient.get(cid);
    const completed = completedWorkoutsByClient.get(cid) ?? [];

    // Adherence: count completed-workout days across the last 2 calendar weeks.
    const since = new Date(thisWeekStart);
    since.setDate(since.getDate() - 7 * ADHERENCE_LOOKBACK_WEEKS);
    const recent = completed.filter((w) => new Date(w.started_at) >= since);
    const recentDays = new Set(recent.map((w) => w.started_at.slice(0, 10)));
    const adherenceDays = recentDays.size;
    const adherenceLow = adherenceDays < ADHERENCE_MIN_DAYS;
    if (adherenceLow) {
      out.push({
        id: `adherence:${cid}`,
        type: 'adherence',
        title: 'Low adherence',
        body: `Only ${adherenceDays} day(s) logged across the last ${ADHERENCE_LOOKBACK_WEEKS} weeks. Adherence issue, not a program issue. Consider a lower-frequency split. Plateau analysis suppressed for this client this week.`,
        apply: null,
      });
    }

    // Plateau: aggregate by exercise NAME across all days for this client.
    // Use training_start_at when the coach has set it (client transitioned
    // mid-mesocycle from elsewhere), else fall back to uploaded_at.
    const programAnchor = prog
      ? new Date(prog.training_start_at ?? prog.uploaded_at)
      : null;
    const programWeekNumber = programAnchor
      ? Math.max(1, differenceInCalendarWeeks(at, programAnchor, { weekStartsOn: 1 }) + 1)
      : 1;

    if (!adherenceLow && prog) {
      // Build per-name exercise log history.
      const nameToLogs = new Map<string, ExerciseLogRow[]>();
      const nameToExerciseIds = new Map<string, Set<string>>();
      const nameKeyByLower = new Map<string, string>(); // lowercased display → app name_key

      const logsForClient = (logs ?? []).filter((l) => workoutToClient.get(l.workout_id) === cid);

      for (const l of logsForClient) {
        const exRaw = l.exercises as unknown;
        const ex = (Array.isArray(exRaw) ? exRaw[0] : exRaw) as { name?: string } | null;
        if (!ex?.name) continue;
        const nameKey = ex.name.trim().toLowerCase();
        const ws = completed.find((w) => w.id === l.workout_id);
        if (!ws) continue;
        const arr = nameToLogs.get(nameKey) ?? [];
        arr.push({
          workoutId: l.workout_id,
          workoutStartedAt: ws.started_at,
          sets: setsByLog.get(l.id) ?? [],
        });
        nameToLogs.set(nameKey, arr);
      }

      // Map name → exercise.id list (only un-archived, only on this program).
      const displayNameByLowercase = new Map<string, string>();
      for (const d of prog.days ?? []) {
        for (const e of d.exercises ?? []) {
          if (e.archived_at) continue;
          const k = e.name.trim().toLowerCase();
          displayNameByLowercase.set(k, e.name);
          nameKeyByLower.set(k, e.name_key);
          const set = nameToExerciseIds.get(k) ?? new Set<string>();
          set.add(e.id);
          nameToExerciseIds.set(k, set);
        }
      }

      // Historical exposures for this client, grouped by lowercased display
      // name (via the exercise's name_key on the program).
      const histByName = new Map<string, Exposure[]>();
      const histForClient = (historical ?? []).filter((h) => h.client_id === cid);
      // Reverse-map: name_key → lowercased name for this client's program
      const lowerByNameKey = new Map<string, string>();
      for (const [low, nk] of nameKeyByLower) lowerByNameKey.set(nk, low);
      const anchor = prog.training_start_at
        ? new Date(prog.training_start_at)
        : new Date(prog.uploaded_at);
      for (const h of histForClient) {
        const low = lowerByNameKey.get(h.exercise_name_key);
        if (!low) continue;
        // Synthesize an Exposure that sorts BEFORE the in-app workouts.
        // workoutStartedAt = training_start_at + (week_index - 1) * 7 days.
        const ts = new Date(anchor.getTime() + (h.week_index - 1) * 7 * 24 * 60 * 60 * 1000);
        const weight = Number(h.weight);
        const arr = histByName.get(low) ?? [];
        arr.push({
          weight,
          reps: h.reps,
          workoutId: `hist:${h.exercise_name_key}:${h.week_index}`,
          workoutStartedAt: ts.toISOString(),
        });
        histByName.set(low, arr);
      }

      // Walk every exercise that has either historical OR in-app data.
      const allNames = new Set<string>([
        ...nameToLogs.keys(),
        ...histByName.keys(),
      ]);

      for (const nameKey of allNames) {
        const exerciseIdSet = nameToExerciseIds.get(nameKey);
        if (!exerciseIdSet || exerciseIdSet.size === 0) continue; // exercise no longer in active program
        const logsArr = nameToLogs.get(nameKey) ?? [];
        const appHistory = buildExposureHistory(logsArr);
        const histExposures = histByName.get(nameKey) ?? [];
        // Combine: historical first (oldest), then app (already sorted asc).
        const history = [...histExposures, ...appHistory];
        if (history.length < WATCH_MIN) continue; // need at least 2 exposures
        const stalled = countConsecutiveStalled(history);
        if (stalled < WATCH_MIN) continue;

        let stage: 'watch' | 'adjust' | 'swap_candidate' =
          stalled >= SWAP_MIN ? 'swap_candidate' : stalled >= ADJUST_MIN ? 'adjust' : 'watch';

        // Phase/week downgrade — without a phase column we only apply the
        // early-program guard. Add the phase rule once the column exists.
        if (stage === 'swap_candidate' && programWeekNumber < SWAP_MIN_PROGRAM_WEEK) {
          stage = 'adjust';
        }

        const last = history[history.length - 1];
        const first = history[Math.max(0, history.length - stalled)];
        const displayName = displayNameByLowercase.get(nameKey) ?? nameKey;
        const exerciseIds = [...exerciseIdSet];

        if (stage === 'watch') {
          out.push({
            id: `watch:${cid}:${nameKey}`,
            type: 'watch',
            title: `${displayName} — watching`,
            body: `${stalled} consecutive non-improving exposures (${first.weight}×${first.reps} → ${last.weight}×${last.reps}). Don't change yet — audit RIR accuracy first, then weekly volume.`,
            apply: null,
          });
        } else if (stage === 'adjust') {
          out.push({
            id: `adjust:${cid}:${nameKey}`,
            type: 'adjust',
            title: `${displayName} — adjust volume`,
            body: `${stalled} consecutive non-improving exposures (${first.weight}×${first.reps} → ${last.weight}×${last.reps}). Keep the exercise. Highest-leverage fix is +1 set/week (ACSM 2026 — volume is the primary hypertrophy lever; Camargo 2025 found no clear saturation). Audit RIR accuracy and execution alongside.`,
            apply: { kind: 'add_set', exerciseIds, targetName: displayName },
          });
        } else {
          out.push({
            id: `swap:${cid}:${nameKey}`,
            type: 'swap_candidate',
            title: `${displayName} — swap candidate`,
            body: `${stalled} consecutive non-improving exposures despite a sufficient observation window. Consider rotating to a non-redundant variation — ONLY after RIR audit, volume increase, execution audit, rest, and recovery have been addressed (Valério 2026: variation isn't superior when volume + effort are sufficient). Hold the new exercise ≥4 weeks.`,
            apply: {
              kind: 'swap_exercise',
              exerciseIds,
              targetName: displayName,
              alternatives: [], // filled in below
            },
          });
        }
      }
    }

    // Skipped-day finding: a day that had logs in the prior 2 weeks but
    // none in the current week. If skipped 2+ weeks running → propose drop.
    if (prog) {
      const dayLogStreak = new Map<string, { thisWeek: number; lastWeek: number; twoBack: number }>();
      for (const w of completed) {
        const ts = new Date(w.started_at).getTime();
        const thisWk = ts >= thisWeekStart.getTime();
        const lastWk = !thisWk && ts >= lastWeekStart.getTime();
        const twoWkBack = !thisWk && !lastWk && ts >= subWeeks(thisWeekStart, 2).getTime();
        if (!thisWk && !lastWk && !twoWkBack) continue;
        const cur = dayLogStreak.get(w.day_id) ?? { thisWeek: 0, lastWeek: 0, twoBack: 0 };
        if (thisWk) cur.thisWeek++;
        else if (lastWk) cur.lastWeek++;
        else cur.twoBack++;
        dayLogStreak.set(w.day_id, cur);
      }

      const dayById = new Map<string, DayRow>();
      for (const d of prog.days ?? []) dayById.set(d.id, d);

      for (const [dayId, c] of dayLogStreak) {
        const day = dayById.get(dayId);
        if (!day) continue;
        if (c.thisWeek > 0) continue; // not skipped
        if (c.lastWeek === 0 && c.twoBack === 0) continue; // not "active" recently
        if (c.lastWeek === 0 && c.twoBack > 0) {
          // Skipped 2 weeks in a row → propose drop.
          out.push({
            id: `skipped:${cid}:${dayId}`,
            type: 'skipped_day',
            title: `${day.label} — skipped 2+ weeks`,
            body: `No logs in the current week or last week. If they're not coming back to it, drop the day from the split rather than leaving it dormant.`,
            apply: { kind: 'archive_day', dayId, dayLabel: day.label },
          });
        } else {
          // Skipped just this week — informational
          out.push({
            id: `skipped:${cid}:${dayId}`,
            type: 'skipped_day',
            title: `${day.label} — skipped this week`,
            body: `Logged in prior weeks but not yet this week. If one-off, ignore. If skipped 2+ weeks in a row, drop it.`,
            apply: null,
          });
        }
      }
    }
  }

  // ---- Final enrichment pass: attach catalog alternatives + PAIN targets ----
  // 1) Resolve PAIN exerciseIds (every active exercise on the client's
  //    program with the same name as the painful one).
  for (const p of painPending) {
    const prog = programByClient.get(p.clientId);
    if (!prog) continue;
    const matchKey = p.exName.trim().toLowerCase();
    const ids: string[] = [];
    for (const d of prog.days ?? []) {
      for (const e of d.exercises ?? []) {
        if (e.archived_at) continue;
        if (e.name.trim().toLowerCase() === matchKey) ids.push(e.id);
      }
    }
    if (ids.length === 0) continue;
    const arr = result.get(p.clientId)!;
    arr[p.suggestionIndex] = {
      ...arr[p.suggestionIndex],
      apply: {
        kind: 'swap_exercise',
        exerciseIds: ids,
        targetName: p.exName,
        alternatives: [], // filled in next step
      },
    };
  }

  // 2) Batch-match every targetName against the catalog and attach
  //    alternatives for swap_candidate + pain suggestions.
  const namesToMatch = new Set<string>();
  for (const sugs of result.values()) {
    for (const s of sugs) {
      if (s.apply && s.apply.kind === 'swap_exercise') namesToMatch.add(s.apply.targetName);
    }
  }
  if (namesToMatch.size > 0) {
    const matches = await matchCatalogForMany([...namesToMatch]);
    for (const sugs of result.values()) {
      for (const s of sugs) {
        if (!s.apply || s.apply.kind !== 'swap_exercise') continue;
        const m = matches.get(s.apply.targetName);
        if (!m || m.alternatives.length === 0) {
          // No catalog match → drop apply so the UI doesn't render an empty picker.
          s.apply = null;
          continue;
        }
        s.apply.alternatives = m.alternatives.map((c: CatalogEntry) => ({
          name: c.name,
          group_key: c.group_key,
        }));
      }
    }
  } else {
    // No swap_exercise applies — nothing to enrich.
  }

  return result;
}
