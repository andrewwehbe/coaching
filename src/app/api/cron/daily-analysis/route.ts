/**
 * Daily plateau analysis cron.
 *
 * Required env: CRON_SECRET — request must include header `x-cron-secret`
 * matching this value, else 401. Vercel Cron is configured to send this
 * header (see vercel.json).
 *
 * For every active client, for every distinct exercise_name_key with
 * enough logged sessions, classifies via signals/plateau (the same
 * 8-stage classifier used by suggestions.ts and recommend-for-client.ts).
 * Upserts stalled_history (persisted snapshot for retrospective
 * analysis), fires an alert via the alert-mapping rules in
 * signals/plateau.decideStalledAlert, and opens a pending swap_proposals
 * row when stage === 'swap_candidate'.
 *
 * Stage 4.6: migrated off the retired plateau-wrapper exposures-based
 * counter onto the 8-stage classifier. fatigue_stall is structurally
 * impossible from this surface (rirDriftAcrossBlock is intentionally
 * null — the deload path is owned by Gate B / suggestions.ts).
 */
import { NextResponse } from 'next/server';
import { startOfWeek, formatISO } from 'date-fns';

import { db } from '@/lib/supabase';
import { sendPushToCoach, sendPushToClient } from '@/lib/push';
import { verifyCronSecret } from '@/lib/cron-auth';
import {
  REMINDER_DEDUP_HOURS,
  ADHERENCE_LOOKBACK_WEEKS,
  ANALYSIS_LOOKBACK_WEEKS,
  ANOMALY_DEDUP_DAYS,
} from '@/lib/config';
import { log } from '@/lib/log';
import {
  buildStalledHistoryRow,
  decideStalledAlert,
  type PlateauStage,
  type StalledAlertDecision,
  type StalledHistoryRow,
} from '@/lib/signals/plateau';
import {
  buildProgressionSeries,
  type SessionInput,
  type Unit,
} from '@/lib/signals/progression';
import {
  evaluateAnomalies,
  type DetectedAnomaly,
} from '@/lib/signals/anomaly';
import { computeAdherence } from '@/lib/signals/adherence';
import {
  getActiveClientContext,
  getContextDirective,
  type AnomalyType,
} from '@/lib/signals/client-context';
import { fetchActiveContextRow } from '@/lib/client-context-store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<NextResponse> {
  const unauth = verifyCronSecret(req);
  if (unauth) return unauth;

  const supa = db();

  const { data: clients, error: clientsErr } = await supa
    .from('clients')
    .select('id, name, weekly_day_target, body_weight_freq, photo_check_in_enabled, created_at')
    .eq('active', true);
  if (clientsErr) {
    return NextResponse.json({ error: clientsErr.message }, { status: 500 });
  }

  // Parallelize per-client work. Each client's analysis + reminders is
  // independent (no shared state), so wall-clock latency drops from O(N)
  // sequential to O(1) at the cost of more concurrent DB connections —
  // Supabase handles ~50 connections per project comfortably. With Promise.all
  // a single failure would short-circuit the rest, so we wrap each call.
  const summary = await Promise.all(
    (clients ?? []).map(async (client) => {
      try {
        const [result, reminders, anomalies] = await Promise.all([
          analyzeClient(client.id),
          runReminders({
            clientId: client.id,
            name: client.name,
            weeklyDayTarget: client.weekly_day_target,
            bodyWeightFreq: client.body_weight_freq,
            hasCheckIns:
              client.body_weight_freq !== 'none' ||
              client.photo_check_in_enabled === true,
          }),
          analyzeAnomalies({
            clientId: client.id,
            name: client.name,
            weeklyDayTarget: client.weekly_day_target,
            clientCreatedAt: client.created_at
              ? new Date(client.created_at)
              : null,
          }),
        ]);
        return {
          client_id: client.id,
          ...result,
          reminders_sent: reminders,
          anomalies_fired: anomalies,
        };
      } catch (err) {
        log.error('cron.daily.client_failed', err, { clientId: client.id });
        return {
          client_id: client.id,
          exercises_processed: 0,
          escalations: 0,
          swap_proposals_opened: 0,
          reminders_sent: 0,
          anomalies_fired: 0,
          error: true,
        };
      }
    }),
  );

  // Prune dead push subscriptions. Two flavors:
  //   - never delivered AND created >30d ago → stale install
  //   - last delivered >60d ago               → user uninstalled / wiped
  const pruned = await prunePushDevices();

  return NextResponse.json({ ok: true, clients: summary.length, pruned, summary });
}

async function prunePushDevices(): Promise<number> {
  const supa = db();
  const now = Date.now();
  const stale30dIso = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  const stale60dIso = new Date(now - 60 * 24 * 3600 * 1000).toISOString();

  const [{ count: neverDelivered }, { count: silenced }] = await Promise.all([
    supa
      .from('devices')
      .delete({ count: 'exact' })
      .is('last_pushed_ok_at', null)
      .lt('created_at', stale30dIso),
    supa
      .from('devices')
      .delete({ count: 'exact' })
      .lt('last_pushed_ok_at', stale60dIso),
  ]);

  const total = (neverDelivered ?? 0) + (silenced ?? 0);
  if (total > 0) {
    log.info('push.devices.pruned', {
      neverDelivered: neverDelivered ?? 0,
      silenced: silenced ?? 0,
    });
  }
  return total;
}

/**
 * Day-of-week reminders. Cron is expected to fire daily, so:
 * - Saturday: if client is behind on weekly_day_target → push to client + coach.
 * - Sunday:   if client has check-ins enabled and hasn't checked in this week → push to client.
 *
 * Idempotency: we suppress if an alert of the same type was created in the
 * last 20 hours. Cron runs once/day; the buffer absorbs manual re-triggers.
 */
async function runReminders(args: {
  clientId: string;
  name: string;
  weeklyDayTarget: number;
  bodyWeightFreq: string | null;
  hasCheckIns: boolean;
}): Promise<number> {
  const supa = db();
  const now = new Date();
  const dow = now.getDay(); // 0=Sun, 6=Sat
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });
  const sinceIso = new Date(Date.now() - REMINDER_DEDUP_HOURS * 3600 * 1000).toISOString();

  let sent = 0;

  // Daily body-weight reminder for clients with body_weight_freq = 'daily'.
  // Cron fires at 06:00 UTC = 09:00 Asia/Beirut. Skip if they already logged
  // weight today (by date), and suppress dup pushes via the 20h alert window.
  if (args.bodyWeightFreq === 'daily') {
    const today = formatISO(now, { representation: 'date' });
    const { data: todayWeight } = await supa
      .from('check_ins')
      .select('id')
      .eq('client_id', args.clientId)
      .eq('date', today)
      .not('body_weight', 'is', null)
      .limit(1);

    if (!todayWeight?.length) {
      const { data: existing } = await supa
        .from('alerts')
        .select('id')
        .eq('client_id', args.clientId)
        .eq('type', 'check_in_due')
        .gte('created_at', sinceIso)
        .limit(1);

      if (!existing?.length) {
        await supa.from('alerts').insert({
          client_id: args.clientId,
          type: 'check_in_due',
          message: `${args.name} hasn't logged body weight today.`,
        });
        void sendPushToClient(args.clientId, {
          title: 'Good morning',
          body: 'Quick body weight check-in?',
          url: '/check-in',
        }).catch(() => {});
        sent++;
      }
    }
  }

  if (dow === 6) {
    const { data: completed } = await supa
      .from('workouts')
      .select('id')
      .eq('client_id', args.clientId)
      .eq('week_start', weekStartIso)
      .not('completed_at', 'is', null);
    const done = completed?.length ?? 0;

    if (done < args.weeklyDayTarget) {
      const { data: existing } = await supa
        .from('alerts')
        .select('id')
        .eq('client_id', args.clientId)
        .eq('type', 'missed_workout')
        .gte('created_at', sinceIso)
        .limit(1);

      if (!existing?.length) {
        await supa.from('alerts').insert({
          client_id: args.clientId,
          type: 'missed_workout',
          message: `${args.name} is behind (${done}/${args.weeklyDayTarget} this week).`,
        });
        const remaining = args.weeklyDayTarget - done;
        void sendPushToClient(args.clientId, {
          title: "Don't lose the week",
          body: `${remaining} more workout${remaining === 1 ? '' : 's'} to hit your weekly goal.`,
          url: '/today',
        }).catch(() => {});
        void sendPushToCoach({
          title: 'Behind on workouts',
          body: `${args.name}: ${done}/${args.weeklyDayTarget} this week.`,
          url: `/coach`,
        }).catch(() => {});
        sent++;
      }
    }
  }

  if (dow === 0 && args.hasCheckIns) {
    const { data: ci } = await supa
      .from('check_ins')
      .select('id')
      .eq('client_id', args.clientId)
      .gte('date', weekStartIso)
      .limit(1);

    if (!ci?.length) {
      const { data: existing } = await supa
        .from('alerts')
        .select('id')
        .eq('client_id', args.clientId)
        .eq('type', 'check_in_due')
        .gte('created_at', sinceIso)
        .limit(1);

      if (!existing?.length) {
        await supa.from('alerts').insert({
          client_id: args.clientId,
          type: 'check_in_due',
          message: `${args.name} hasn't checked in this week.`,
        });
        void sendPushToClient(args.clientId, {
          title: 'Weekly check-in',
          body: 'Take a minute to log your weight + photos.',
          url: '/check-in',
        }).catch(() => {});
        sent++;
      }
    }
  }

  return sent;
}

async function analyzeClient(clientId: string) {
  const supa = db();

  // Bounded to the shared analysis lookback (same window suggestions.ts
  // uses). The plateau classifier only reads recent weekly exposures;
  // unbounded, this cron re-scanned every client's lifetime history
  // nightly and its runtime grew without limit.
  const lookbackStart = new Date(
    Date.now() - ANALYSIS_LOOKBACK_WEEKS * 7 * 24 * 60 * 60_000,
  ).toISOString();
  const { data: workouts } = await supa
    .from('workouts')
    .select('id,started_at')
    .eq('client_id', clientId)
    .gte('started_at', lookbackStart);

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

  // Stage 4.6: fetch unit + rir so the SessionMetric series carries
  // them through. unit feeds buildProgressionSeries's kg normalisation
  // (clients sometimes mix kg/lb on the same lift); rir feeds the
  // high_rir_stall branch of classifyExercisePlateau, which routes
  // the new 'effort_gap' alert type added in migration 0025.
  const { data: setsRows } = await supa
    .from('sets')
    .select('exercise_log_id,weight,reps,rir,unit')
    .in('exercise_log_id', logIds);

  const setsByLog = new Map<
    string,
    {
      weight: number | null;
      reps: number | null;
      rir: number | null;
      unit: Unit;
    }[]
  >();
  for (const s of setsRows ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      weight: s.weight === null ? null : Number(s.weight),
      reps: s.reps === null ? null : Number(s.reps),
      rir: s.rir,
      unit: s.unit as Unit,
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

  // Build per-name_key SessionInput[] for the new classifier path.
  const sessionsByNameKey = new Map<string, SessionInput[]>();
  for (const l of logsList) {
    const key = nameKeyByExId.get(l.exercise_id);
    const w = workoutById.get(l.workout_id);
    if (!key || !w) continue;
    const sets = setsByLog.get(l.id) ?? [];
    if (sets.length === 0) continue;
    const arr = sessionsByNameKey.get(key) ?? [];
    arr.push({
      workoutId: l.workout_id,
      workoutStartedAt: w.started_at,
      sets,
    });
    sessionsByNameKey.set(key, arr);
  }

  const { data: priorRows } = await supa
    .from('stalled_history')
    .select('exercise_name_key,plateau_stage')
    .eq('client_id', clientId);
  const priorStage = new Map<string, PlateauStage>(
    (priorRows ?? []).map((r) => [
      r.exercise_name_key,
      r.plateau_stage as PlateauStage,
    ])
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

  const now = new Date();
  const upserts: StalledHistoryRow[] = [];
  const alertInserts: (StalledAlertDecision & { client_id: string })[] = [];
  const swapInserts: {
    client_id: string;
    exercise_id: string;
    reason: string;
  }[] = [];

  let exercisesProcessed = 0;
  let escalations = 0;

  for (const [nameKey, sessionInputs] of sessionsByNameKey.entries()) {
    // Build the same SessionMetric series that the live classifier in
    // suggestions.ts and recommend-for-client.ts consumes. Single source
    // of truth — Stage 4.6's whole point.
    const series = buildProgressionSeries({
      historical: [],
      logged: sessionInputs,
    });

    exercisesProcessed++;
    const row = buildStalledHistoryRow({
      clientId,
      exerciseNameKey: nameKey,
      series,
      at: now,
    });
    upserts.push(row);

    const decision = decideStalledAlert({
      previousStage: priorStage.get(nameKey) ?? null,
      currentStage: row.plateau_stage,
      exerciseNameKey: nameKey,
      weeksStalled: row.weeks_stalled,
    });
    if (decision) {
      escalations++;
      alertInserts.push({ client_id: clientId, ...decision });
    }

    if (row.plateau_stage === 'swap_candidate') {
      for (const ex of activeExercises) {
        if (ex.name_key !== nameKey) continue;
        swapInserts.push({
          client_id: clientId,
          exercise_id: ex.id,
          reason: `Plateau-stage swap_candidate (${row.weeks_stalled} wk stalled).`,
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
    for (const a of alertInserts) {
      void sendPushToCoach({
        title: 'Stalled exercise',
        body: a.message,
        url: '/coach',
      }).catch(() => {});
    }
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

/**
 * Stage 6 Piece 3 Surface 1 — anomaly evaluation for one client.
 *
 * Fetches the inputs evaluateAnomalies needs (recent workouts, per-
 * exercise series, prior + current adherence, active context, recently-
 * alerted types) and writes one alerts row + one coach push per fired
 * anomaly. Detector + suppression + dedup logic all live in
 * signals/anomaly — this function is wiring only.
 *
 * Window strategy: 90d back covers ANOMALY_QUIET_DAYS (10) + ANOMALY_
 * RETURN_GAP_DAYS (7) + 2-week adherence lookback with substantial pre-
 * gap headroom for the performance_cliff e1RM comparison.
 */
async function analyzeAnomalies(args: {
  clientId: string;
  name: string;
  weeklyDayTarget: number;
  clientCreatedAt: Date | null;
}): Promise<number> {
  if (!args.clientCreatedAt) return 0;
  const supa = db();
  const now = new Date();
  const ninetyDaysAgoIso = new Date(
    now.getTime() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const dedupSinceIso = new Date(
    now.getTime() - ANOMALY_DEDUP_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [
    { data: recentWorkouts },
    { data: programRow },
    persistedContext,
    { data: recentAlertRows },
  ] = await Promise.all([
    supa
      .from('workouts')
      .select('id, day_id, started_at')
      .eq('client_id', args.clientId)
      .not('completed_at', 'is', null)
      .gte('started_at', ninetyDaysAgoIso)
      .order('started_at', { ascending: true }),
    supa
      .from('programs')
      .select('id, days(id, day_index, label)')
      .eq('client_id', args.clientId)
      .eq('active', true)
      .maybeSingle(),
    fetchActiveContextRow(args.clientId),
    supa
      .from('alerts')
      .select('type')
      .eq('client_id', args.clientId)
      .gte('created_at', dedupSinceIso)
      .in('type', [
        'adherence_drop',
        'returned_after_gap',
        'performance_cliff',
        'went_quiet',
      ]),
  ]);

  const completedWorkouts = (recentWorkouts ?? []).map((w) => ({
    started_at: w.started_at as string,
  }));

  // hasNoLogs is an ALL-TIME signal. We restricted the recentWorkouts
  // query to 90d for performance; for the synthesized-onboarding
  // decision we want "did this client ever log anything." When the 90d
  // window is empty, we still need to check older history.
  let hasNoLogs = completedWorkouts.length === 0;
  if (hasNoLogs) {
    const { data: anyOlder } = await supa
      .from('workouts')
      .select('id')
      .eq('client_id', args.clientId)
      .not('completed_at', 'is', null)
      .limit(1);
    hasNoLogs = !anyOlder || anyOlder.length === 0;
  }

  const activeContext = getActiveClientContext({
    at: now,
    persistedRow: persistedContext,
    clientCreatedAt: args.clientCreatedAt,
    hasNoLogs,
  });
  const contextDirective = activeContext
    ? getContextDirective(activeContext.reasonCode)
    : null;

  const scheduledDays = (programRow?.days ?? []).map((d) => ({
    id: d.id as string,
    day_index: d.day_index as number,
    label: d.label as string,
  }));

  const currentAdherence = computeAdherence({
    completedWorkouts: completedWorkouts.map((w) => ({
      day_id: '', // day_id not needed for ratio math; computeAdherence
      // only uses it for missingDayLabels. The cron's anomaly path only
      // reads .ratio, so leaving empty is correct.
      started_at: w.started_at,
    })),
    scheduledDays,
    weeklyDayTarget: args.weeklyDayTarget,
    at: now,
  });
  const priorAt = new Date(
    startOfWeek(now, { weekStartsOn: 1 }).getTime() -
      ADHERENCE_LOOKBACK_WEEKS * 7 * 24 * 60 * 60 * 1000,
  );
  const priorAdherence = computeAdherence({
    completedWorkouts: completedWorkouts.map((w) => ({
      day_id: '',
      started_at: w.started_at,
    })),
    scheduledDays,
    weeklyDayTarget: args.weeklyDayTarget,
    at: priorAt,
  });

  // Build perExerciseSeries within the 90d window.
  const workoutIds = (recentWorkouts ?? []).map((w) => w.id as string);
  const perExerciseSeries = new Map<string, ReturnType<typeof buildProgressionSeries>>();
  if (workoutIds.length > 0) {
    const { data: logsRecent } = await supa
      .from('exercise_logs')
      .select('id, workout_id, exercise_id')
      .in('workout_id', workoutIds);
    const logRows = logsRecent ?? [];
    const logIds = logRows.map((l) => l.id as string);
    if (logIds.length > 0) {
      const { data: setsRecent } = await supa
        .from('sets')
        .select('exercise_log_id, weight, reps, rir, unit')
        .in('exercise_log_id', logIds);
      const setsByLog = new Map<
        string,
        { weight: number | null; reps: number | null; rir: number | null; unit: Unit }[]
      >();
      for (const s of setsRecent ?? []) {
        const arr = setsByLog.get(s.exercise_log_id as string) ?? [];
        arr.push({
          weight: s.weight === null ? null : Number(s.weight),
          reps: s.reps === null ? null : Number(s.reps),
          rir: s.rir,
          unit: s.unit as Unit,
        });
        setsByLog.set(s.exercise_log_id as string, arr);
      }
      const workoutStartedAt = new Map<string, string>(
        (recentWorkouts ?? []).map((w) => [w.id as string, w.started_at as string]),
      );
      const sessionsByExercise = new Map<string, SessionInput[]>();
      for (const l of logRows) {
        const startedAt = workoutStartedAt.get(l.workout_id as string);
        if (!startedAt) continue;
        const sets = setsByLog.get(l.id as string) ?? [];
        if (sets.length === 0) continue;
        const arr = sessionsByExercise.get(l.exercise_id as string) ?? [];
        arr.push({
          workoutId: l.workout_id as string,
          workoutStartedAt: startedAt,
          sets,
        });
        sessionsByExercise.set(l.exercise_id as string, arr);
      }
      for (const [exId, inputs] of sessionsByExercise) {
        perExerciseSeries.set(
          exId,
          buildProgressionSeries({ historical: [], logged: inputs }),
        );
      }
    }
  }

  const recentlyAlertedTypes = new Set<AnomalyType>(
    (recentAlertRows ?? [])
      .map((r) => r.type as AnomalyType)
      .filter((t): t is AnomalyType =>
        t === 'adherence_drop' ||
        t === 'returned_after_gap' ||
        t === 'performance_cliff' ||
        t === 'went_quiet',
      ),
  );

  const detected = evaluateAnomalies({
    at: now,
    clientId: args.clientId,
    completedWorkouts,
    perExerciseSeries,
    priorAdherence,
    currentAdherence,
    activeContext,
    contextDirective,
    recentlyAlertedTypes,
  });

  if (detected.length === 0) return 0;

  const inserts = detected.map((d) => ({
    client_id: args.clientId,
    type: d.type,
    message: formatAnomalyMessage(args.name, d),
    data: d.detail as unknown as Record<string, unknown>,
  }));
  await supa.from('alerts').insert(inserts);
  for (const d of detected) {
    void sendPushToCoach({
      title: formatAnomalyTitle(d.type),
      body: formatAnomalyMessage(args.name, d),
      url: '/coach',
    }).catch(() => {});
  }
  return detected.length;
}

function formatAnomalyTitle(type: AnomalyType): string {
  switch (type) {
    case 'adherence_drop':
      return 'Adherence dropped';
    case 'returned_after_gap':
      return 'Returned after gap';
    case 'performance_cliff':
      return 'Performance cliff';
    case 'went_quiet':
      return 'Went quiet';
  }
}

function formatAnomalyMessage(name: string, anomaly: DetectedAnomaly): string {
  switch (anomaly.detail.type) {
    case 'adherence_drop': {
      const prior = Math.round(anomaly.detail.priorRatio * 100);
      const current = Math.round(anomaly.detail.currentRatio * 100);
      return `${name}: adherence dropped from ${prior}% → ${current}%.`;
    }
    case 'returned_after_gap':
      return `${name} returned after ${anomaly.detail.gapDays}d off.`;
    case 'performance_cliff':
      return `${name}: ${anomaly.detail.regressingExerciseCount} lifts regressed beyond MDC after a ${anomaly.detail.gapDays}d gap.`;
    case 'went_quiet':
      return `${name} hasn't trained in ${anomaly.detail.quietDays} days.`;
  }
}
