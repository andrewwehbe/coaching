import 'server-only';

import { startOfWeek, formatISO, subWeeks } from 'date-fns';

import { db } from './supabase';

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

export async function buildWeeklyReport(at: Date = new Date()): Promise<WeeklyReport> {
  const supa = db();
  const weekStart = startOfWeek(at, { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });
  const priorWeekStart = subWeeks(weekStart, 1);
  const priorWeekIso = formatISO(priorWeekStart, { representation: 'date' });

  const { data: clients } = await supa
    .from('clients')
    .select('id, name, weekly_day_target')
    .eq('active', true)
    .order('name');

  const rows: ClientWeekRow[] = [];
  let totalSets = 0;
  let totalVideos = 0;
  let totalPain = 0;
  let totalPRs = 0;
  let totalDaysDone = 0;
  let totalTarget = 0;

  for (const c of clients ?? []) {
    const { data: workouts } = await supa
      .from('workouts')
      .select('id, started_at, completed_at, is_missed')
      .eq('client_id', c.id)
      .eq('week_start', weekStartIso);

    const completedWorkouts = (workouts ?? []).filter((w) => w.completed_at);
    const daysDone = completedWorkouts.length;
    const workoutIds = completedWorkouts.map((w) => w.id);

    const { data: logs } = workoutIds.length
      ? await supa
          .from('exercise_logs')
          .select('id, pain_reason, exercise_id, exercises(name_key)')
          .in('workout_id', workoutIds)
      : { data: [] as Array<{ id: string; pain_reason: string | null; exercise_id: string; exercises: unknown }> };

    const logIds = (logs ?? []).map((l) => l.id);
    const painExercises = (logs ?? []).filter((l) => l.pain_reason).length;

    const { data: sets } = logIds.length
      ? await supa
          .from('sets')
          .select('exercise_log_id, weight, reps, unit, video_url')
          .in('exercise_log_id', logIds)
      : { data: [] as Array<{ exercise_log_id: string; weight: number | string | null; reps: number | null; unit: string | null; video_url: string | null }> };

    const setCount = (sets ?? []).length;
    const videoCount = (sets ?? []).filter((s) => s.video_url).length;

    let prs = 0;
    if (logIds.length) {
      const logToNameKey = new Map<string, string>();
      for (const l of logs ?? []) {
        const raw = l.exercises as unknown;
        const ex = (Array.isArray(raw) ? raw[0] : raw) as { name_key?: string } | null;
        if (ex?.name_key) logToNameKey.set(l.id, ex.name_key);
      }
      const thisWeekBest = new Map<string, { weight: number; reps: number; unit: string }>();
      for (const s of sets ?? []) {
        const nk = logToNameKey.get(s.exercise_log_id);
        if (!nk || s.weight == null || s.reps == null) continue;
        const w = Number(s.weight);
        const here = { weight: w, reps: s.reps, unit: s.unit ?? '' };
        const cur = thisWeekBest.get(nk);
        if (
          !cur ||
          here.unit === cur.unit && (here.weight > cur.weight || (here.weight === cur.weight && here.reps > cur.reps))
        ) {
          thisWeekBest.set(nk, here);
        }
      }
      const nks = [...thisWeekBest.keys()];
      if (nks.length) {
        const earliestThisWeek = completedWorkouts
          .map((w) => w.started_at)
          .sort()[0];
        const { data: priorWorkouts } = await supa
          .from('workouts')
          .select('id')
          .eq('client_id', c.id)
          .lt('started_at', earliestThisWeek);
        const pwIds = (priorWorkouts ?? []).map((w) => w.id);
        if (pwIds.length) {
          const { data: priorLogs } = await supa
            .from('exercise_logs')
            .select('id, exercises!inner(name_key)')
            .in('workout_id', pwIds)
            .in('exercises.name_key', nks);
          const plToNk = new Map<string, string>();
          for (const l of priorLogs ?? []) {
            const raw = l.exercises as unknown;
            const ex = (Array.isArray(raw) ? raw[0] : raw) as { name_key?: string } | null;
            if (ex?.name_key) plToNk.set(l.id, ex.name_key);
          }
          const plIds = [...plToNk.keys()];
          if (plIds.length) {
            const { data: priorSets } = await supa
              .from('sets')
              .select('exercise_log_id, weight, reps, unit')
              .in('exercise_log_id', plIds)
              .not('weight', 'is', null)
              .not('reps', 'is', null);
            const priorBest = new Map<string, { weight: number; reps: number; unit: string }>();
            for (const s of priorSets ?? []) {
              const nk = plToNk.get(s.exercise_log_id);
              if (!nk || s.weight == null || s.reps == null) continue;
              const here = { weight: Number(s.weight), reps: s.reps, unit: s.unit ?? '' };
              const cur = priorBest.get(nk);
              if (
                !cur ||
                here.unit === cur.unit && (here.weight > cur.weight || (here.weight === cur.weight && here.reps > cur.reps))
              ) {
                priorBest.set(nk, here);
              }
            }
            for (const [nk, here] of thisWeekBest) {
              const prior = priorBest.get(nk);
              if (
                prior &&
                here.unit === prior.unit &&
                (here.weight > prior.weight || (here.weight === prior.weight && here.reps > prior.reps))
              ) {
                prs++;
              }
            }
          }
        }
      }
    }

    const { count: stalledCount } = await supa
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', c.id)
      .eq('type', 'stalled')
      .gte('created_at', new Date(weekStart).toISOString());

    const { data: thisCi } = await supa
      .from('check_ins')
      .select('date, body_weight, body_weight_unit')
      .eq('client_id', c.id)
      .gte('date', weekStartIso)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();

    let bodyWeight: ClientWeekRow['bodyWeight'] = null;
    if (thisCi?.body_weight != null) {
      const { data: priorCi } = await supa
        .from('check_ins')
        .select('body_weight, body_weight_unit')
        .eq('client_id', c.id)
        .lt('date', weekStartIso)
        .not('body_weight', 'is', null)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();
      const cur = Number(thisCi.body_weight);
      const prior = priorCi?.body_weight != null ? Number(priorCi.body_weight) : null;
      const sameUnit = !priorCi || (priorCi.body_weight_unit ?? 'kg') === (thisCi.body_weight_unit ?? 'kg');
      bodyWeight = {
        value: cur,
        unit: thisCi.body_weight_unit ?? 'kg',
        deltaFromPrior: prior != null && sameUnit ? Number((cur - prior).toFixed(1)) : null,
      };
    }

    const checkedIn = thisCi != null;

    rows.push({
      clientId: c.id,
      name: c.name,
      daysDone,
      daysTarget: c.weekly_day_target,
      totalSets: setCount,
      videos: videoCount,
      painExercises,
      stalledEscalations: stalledCount ?? 0,
      prs,
      bodyWeight,
      checkedIn,
    });

    totalSets += setCount;
    totalVideos += videoCount;
    totalPain += painExercises;
    totalPRs += prs;
    totalDaysDone += daysDone;
    totalTarget += c.weekly_day_target;
  }

  // Reference unused var to keep eslint happy if priorWeekIso ever gets used.
  void priorWeekIso;

  const completionPct = totalTarget === 0 ? 0 : Math.round((totalDaysDone / totalTarget) * 100);

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
