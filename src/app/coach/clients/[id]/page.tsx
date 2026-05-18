import Link from 'next/link';
import { notFound } from 'next/navigation';
import { format, formatDistanceToNow, startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db, signMediaUrls } from '@/lib/supabase';
import { computeProgramContext } from '@/lib/program-week';
import { loadEffortWindow } from '@/lib/effort-window';
import { loadRecommendation } from '@/lib/recommend-for-client';
import type { Recommendation, RecommenderInput } from '@/lib/recommender';
import { Chip, PageHeader } from '../../ui';
import { RecommendationActions } from './recommendation-actions';

const PHOTO_BUCKET = 'check-in-photos';
import { ClientActions } from './client-actions';
import { ProgramSection } from './program-section';
import { HistorySection } from './history-section';
import { SkipPainSection } from './skip-pain-section';

type Params = Promise<{ id: string }>;

const GOAL_LABEL = {
  hypertrophy: 'Hypertrophy',
  strength: 'Strength',
  fat_loss: 'Fat loss',
  general: 'General',
} as const;

const EQUIPMENT_LABEL = {
  full_gym: 'Full gym',
  home_gym: 'Home gym',
  dumbbells_only: 'DBs only',
  bodyweight: 'Bodyweight',
} as const;

export const dynamic = 'force-dynamic';

export default async function ClientDetailPage(props: { params: Params }) {
  await requireCoach();
  const { id } = await props.params;

  const supa = db();
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });

  // 14-day skip/pain window — used to surface recent client friction so the
  // coach can spot patterns without drilling into individual workouts.
  const skipPainSinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Client + program + workouts + thisWeek + checkIns + flags + deloads are
  // all keyed off clientId only and can run in a single round-trip.
  const [
    { data: client },
    { data: program },
    { data: workouts },
    { data: thisWeek },
    { data: checkIns },
    { data: skipPain },
    { data: deloadWeeks },
  ] = await Promise.all([
    supa
      .from('clients')
      .select(
        'id, name, active, weekly_day_target, body_weight_freq, photo_check_in_enabled, meal_plan_enabled, log_mode, created_at, deactivated_at, training_age, primary_goal, equipment, exercise_blacklist',
      )
      .eq('id', id)
      .maybeSingle(),
    supa
      .from('programs')
      .select('id, source_filename, uploaded_at, training_start_at, last_edited_at')
      .eq('client_id', id)
      .eq('active', true)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from('workouts')
      .select('id, day_id, started_at, completed_at, week_start, is_deload, days(label)')
      .eq('client_id', id)
      .order('started_at', { ascending: false })
      .limit(40),
    supa
      .from('workouts')
      .select('id, is_deload')
      .eq('client_id', id)
      .eq('week_start', weekStartIso),
    supa
      .from('check_ins')
      .select('id, date, body_weight, body_weight_unit, notes, check_in_photos(id, label, storage_url)')
      .eq('client_id', id)
      .order('date', { ascending: false })
      .limit(8),
    supa
      .from('exercise_logs')
      .select(
        'id, status, skip_reason, pain_reason, pain_type, created_at, exercises!inner(name), workouts!inner(client_id, started_at)',
      )
      .eq('workouts.client_id', id)
      .gte('workouts.started_at', skipPainSinceIso)
      .or('status.eq.skipped,status.eq.pain,pain_reason.not.is.null')
      .order('created_at', { ascending: false })
      .limit(20),
    supa
      .from('client_deload_weeks')
      .select('week_start')
      .eq('client_id', id),
  ]);
  if (!client) notFound();

  const effort = await loadEffortWindow(id);
  const recResult = await loadRecommendation(id);

  // Recent recommendation decisions — audit trail surfaced under the card.
  const { data: recentDecisions } = await supa
    .from('recommendations')
    .select('id, created_at, rec_type, title, decision, decision_note')
    .eq('client_id', id)
    .order('created_at', { ascending: false })
    .limit(8);

  const { data: days } = program
    ? await supa
        .from('days')
        .select(
          'id, day_index, label, exercises(id, position, name, prescription_raw, coach_note, archived_at, muscle_group)',
        )
        .eq('program_id', program.id)
        .order('day_index')
    : { data: [] as never };

  const currentWeekIsDeload = (thisWeek ?? []).some((w) => w.is_deload);

  const programContext = computeProgramContext(
    program
      ? {
          trainingStartAt: program.training_start_at,
          uploadedAt: program.uploaded_at,
          lastEditedAt: program.last_edited_at,
          deloadWeekStarts: (deloadWeeks ?? []).map((d) => d.week_start),
        }
      : null,
  );

  // Sign photo paths so we can render private-bucket assets.
  const photoPaths: string[] = [];
  for (const c of checkIns ?? []) {
    const ph = (c.check_in_photos as Array<{ storage_url: string }>) ?? [];
    for (const p of ph) photoPaths.push(p.storage_url);
  }
  const signed = await signMediaUrls(PHOTO_BUCKET, photoPaths);
  const signedByPath = new Map<string, string | null>();
  photoPaths.forEach((p, i) => signedByPath.set(p, signed[i]));

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <PageHeader
        back={{ href: '/coach/clients', label: 'All clients' }}
        eyebrow={`Joined ${format(new Date(client.created_at), 'MMM d, yyyy')} · ${
          client.active ? 'Active' : 'Deactivated'
        }`}
        title={client.name}
        meta={
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <Chip className="border-border bg-surface/40 text-muted">
              <span className="font-mono tabular-nums normal-case tracking-normal">
                {client.weekly_day_target}
              </span>
              <span className="ml-1">d/week</span>
            </Chip>
            {client.photo_check_in_enabled && (
              <Chip className="border-border bg-surface/40 text-muted">Photos</Chip>
            )}
            {client.body_weight_freq !== 'none' && (
              <Chip className="border-border bg-surface/40 text-muted">
                BW: {client.body_weight_freq}
              </Chip>
            )}
            {client.meal_plan_enabled && (
              <Chip className="border-border bg-surface/40 text-muted">Meals</Chip>
            )}
            {client.log_mode === 'best' && (
              <Chip className="border-accent/40 bg-accent/8 text-accent">Best-set log</Chip>
            )}
            {client.log_mode === 'all' && (
              <Chip className="border-accent/40 bg-accent/8 text-accent">All-sets log</Chip>
            )}
            {client.training_age && (
              <Chip className="border-border bg-surface/40 text-muted capitalize">
                {client.training_age}
              </Chip>
            )}
            {client.primary_goal && (
              <Chip className="border-border bg-surface/40 text-muted">
                {GOAL_LABEL[client.primary_goal as keyof typeof GOAL_LABEL]}
              </Chip>
            )}
            {client.equipment && (
              <Chip className="border-border bg-surface/40 text-muted">
                {EQUIPMENT_LABEL[client.equipment as keyof typeof EQUIPMENT_LABEL]}
              </Chip>
            )}
            {Array.isArray(client.exercise_blacklist) &&
              client.exercise_blacklist.length > 0 && (
                <span title={(client.exercise_blacklist as string[]).join(', ')}>
                  <Chip className="border-danger/30 bg-danger/10 text-danger">
                    {client.exercise_blacklist.length} blacklisted
                  </Chip>
                </span>
              )}
          </div>
        }
      />

      <div className="flex flex-wrap gap-2 mb-6">
        <Link
          href={`/coach/clients/${client.id}/log`}
          prefetch={false}
          className="inline-flex items-center gap-2 rounded-sm border border-primary bg-primary/15 hover:bg-primary/25 text-primary-hi px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium transition-colors"
        >
          Log on behalf
        </Link>
        {program && (
          <Link
            href={`/coach/clients/${client.id}/program/edit`}
            prefetch={false}
            className="inline-flex items-center gap-2 rounded-sm border border-border-strong hover:border-primary/50 bg-surface/40 hover:bg-surface text-muted hover:text-text px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium transition-colors"
          >
            Edit program
          </Link>
        )}
        {program && (
          <Link
            href={`/coach/clients/${client.id}/baselines`}
            prefetch={false}
            className="inline-flex items-center gap-2 rounded-sm border border-border-strong hover:border-primary/50 bg-surface/40 hover:bg-surface text-muted hover:text-text px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium transition-colors"
            title="Import starting bests + set training start date for mid-mesocycle transitions"
          >
            Baselines
          </Link>
        )}
        <Link
          href={`/coach/clients/${client.id}/profile`}
          prefetch={false}
          className="inline-flex items-center gap-2 rounded-sm border border-border-strong hover:border-primary/50 bg-surface/40 hover:bg-surface text-muted hover:text-text px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium transition-colors"
          title="Training age, goal, equipment, exercise blacklist"
        >
          Profile
        </Link>
      </div>

      <ClientActions
        clientId={client.id}
        active={client.active}
        currentWeekIsDeload={currentWeekIsDeload}
        logMode={
          client.log_mode === 'best'
            ? 'best'
            : client.log_mode === 'all'
              ? 'all'
              : 'sets'
        }
      />

      {recResult && (
        <RecommendationCard
          clientId={client.id}
          rec={recResult.recommendation}
          signals={recResult.signals}
        />
      )}
      <RecentDecisionsSection rows={recentDecisions ?? []} />

      <EffortSection effort={effort} />

      {program && programContext.weekInProgram != null && (
        <section
          aria-label="Program context"
          className="mt-4 mb-2 rounded-md border border-border bg-surface/40 px-4 py-3"
        >
          <p className="text-[10px] uppercase tracking-[0.22em] text-faint mb-2">
            Program context
          </p>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <ContextStat
              label="Week"
              value={
                currentWeekIsDeload
                  ? `${programContext.weekInProgram} · deload`
                  : String(programContext.weekInProgram)
              }
              tone={currentWeekIsDeload ? 'accent' : 'default'}
            />
            <ContextStat
              label="Since last deload"
              value={
                programContext.weeksSinceLastDeload == null
                  ? 'never'
                  : programContext.weeksSinceLastDeload === 0
                    ? 'this week'
                    : `${programContext.weeksSinceLastDeload}w`
              }
            />
            <ContextStat
              label="Deloads this block"
              value={String(programContext.deloadCount)}
            />
            <ContextStat
              label="Program edited"
              value={
                programContext.weeksSinceUpload == null
                  ? '—'
                  : programContext.weeksSinceUpload === 0
                    ? 'this week'
                    : `${programContext.weeksSinceUpload}w ago`
              }
            />
          </dl>
        </section>
      )}

      <SkipPainSection rows={skipPain ?? []} />

      <ProgramSection
        days={
          (days ?? []).map((d) => ({
            id: d.id,
            day_index: d.day_index,
            label: d.label,
            exercises: (d.exercises ?? []).map((e) => ({
              id: e.id,
              position: e.position,
              name: e.name,
              prescription_raw: e.prescription_raw,
              coach_note: e.coach_note,
              archived_at: e.archived_at,
              muscle_group: e.muscle_group ?? null,
            })),
          }))
        }
        hasProgram={!!program}
      />

      {checkIns && checkIns.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-[0.18em] text-faint mb-3">Check-ins</h2>
          <ul className="space-y-2">
            {checkIns.map((c) => {
              const photos = (c.check_in_photos as Array<{
                id: string;
                label: string;
                storage_url: string;
              }>) ?? [];
              return (
                <li
                  key={c.id}
                  className="rounded-2xl border border-border bg-surface/60 px-4 py-3"
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-text">
                      {format(new Date(c.date + 'T00:00:00'), 'EEE, MMM d')}
                    </p>
                    <p className="text-sm tabular-nums text-muted">
                      {c.body_weight != null
                        ? `${c.body_weight}${(c.body_weight_unit ?? 'kg').toUpperCase()}`
                        : '—'}
                    </p>
                  </div>
                  {c.notes && <p className="text-xs text-muted mb-2">{c.notes}</p>}
                  {photos.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
                      {photos.map((p) => {
                        const url = signedByPath.get(p.storage_url) ?? null;
                        if (!url) return null;
                        return (
                          <a
                            key={p.id}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="block shrink-0 rounded-lg overflow-hidden border border-border"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt={p.label}
                              className="h-20 w-20 object-cover"
                              loading="lazy"
                            />
                          </a>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <HistorySection
        workouts={(workouts ?? []).map((w) => {
          const raw = w.days as unknown;
          const d = Array.isArray(raw) ? raw[0] : raw;
          return {
            id: w.id,
            day_id: w.day_id,
            started_at: w.started_at,
            completed_at: w.completed_at,
            week_start: w.week_start,
            is_deload: w.is_deload,
            days: d ? { label: (d as { label: string }).label } : null,
          };
        })}
      />

      <p className="mt-8 text-xs text-faint">
        Last activity:{' '}
        {workouts && workouts.length > 0
          ? formatDistanceToNow(new Date(workouts[0].started_at), { addSuffix: true })
          : 'never'}
      </p>
    </main>
  );
}

function RecommendationCard({
  clientId,
  rec,
  signals,
}: {
  clientId: string;
  rec: Recommendation;
  signals: RecommenderInput;
}) {
  const tone = TONE_FOR_TYPE[rec.type];
  return (
    <section
      aria-label="Recommendation"
      className={`mt-4 mb-2 rounded-md border px-4 py-4 ${tone.container}`}
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="text-[10px] uppercase tracking-[0.22em] text-faint">
          Recommendation
        </p>
        <p
          className={`text-[10px] uppercase tracking-[0.22em] font-semibold ${tone.badge}`}
        >
          {LABEL_FOR_TYPE[rec.type]}
        </p>
      </div>
      <h3 className={`font-display text-2xl tracking-tight ${tone.title}`}>
        {rec.title}
      </h3>
      <p className="mt-2 text-sm text-text leading-relaxed">{rec.body}</p>

      {rec.forcedSwaps.length > 0 && (
        <div className="mt-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.22em] text-danger mb-1">
            Forced swap{rec.forcedSwaps.length === 1 ? '' : 's'} · pain
          </p>
          <ul className="text-sm text-danger space-y-0.5">
            {rec.forcedSwaps.map((s) => (
              <li key={s.exerciseId}>{s.exerciseName}</li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-3 group">
        <summary className="cursor-pointer text-[10px] uppercase tracking-[0.18em] text-faint hover:text-text">
          Why this fired
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-muted list-disc pl-4">
          {rec.rationale.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </details>

      {rec.dataGaps.length > 0 && (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.18em] text-faint hover:text-text">
            Data gaps ({rec.dataGaps.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-faint list-disc pl-4">
            {rec.dataGaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-3 text-[10px] text-faint italic">
        Practitioner heuristic, not RCT-derived. Override freely.
      </p>

      <RecommendationActions clientId={clientId} rec={rec} signals={signals} />
    </section>
  );
}

type RecentDecisionRow = {
  id: string;
  created_at: string;
  rec_type: string;
  title: string;
  decision: string;
  decision_note: string | null;
};

function RecentDecisionsSection({ rows }: { rows: RecentDecisionRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Recent recommendation decisions"
      className="mt-4 mb-2 rounded-md border border-border bg-surface/40 px-4 py-3"
    >
      <p className="text-[10px] uppercase tracking-[0.22em] text-faint mb-2">
        Recent decisions
      </p>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-baseline gap-3 text-xs border-b border-border last:border-b-0 pb-2 last:pb-0"
          >
            <span
              className="font-mono tabular-nums text-faint shrink-0"
              title={row.created_at}
            >
              {new Date(row.created_at).toISOString().slice(0, 10)}
            </span>
            <span
              className={
                'text-[10px] uppercase tracking-[0.18em] shrink-0 ' +
                DECISION_TONE[row.decision as keyof typeof DECISION_TONE]
              }
            >
              {row.decision}
            </span>
            <span className="text-text truncate">{row.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const DECISION_TONE = {
  applied: 'text-primary-hi',
  acknowledged: 'text-muted',
  snoozed: 'text-warn',
  dismissed: 'text-faint',
} as const;

const LABEL_FOR_TYPE: Record<Recommendation['type'], string> = {
  hold: 'Hold',
  refer_adherence: 'Adherence',
  trigger_deload: 'Deload',
  refer_recovery: 'Recovery',
  phase_transition: 'Phase',
  exercise_reorder: 'Reorder',
  rotate_day: 'Rotate day',
  volume_adjust: 'Volume',
  intensity_adjust: 'Intensity',
  single_exercise_swap: 'Swap',
  refer_technique_or_loading: 'Technique',
  split_rotation: 'Split',
};

const TONE_FOR_TYPE: Record<
  Recommendation['type'],
  { container: string; title: string; badge: string }
> = {
  hold: {
    container: 'border-border bg-surface/40',
    title: 'text-text',
    badge: 'text-muted',
  },
  refer_adherence: {
    container: 'border-warn/40 bg-warn/10',
    title: 'text-warn',
    badge: 'text-warn',
  },
  refer_recovery: {
    container: 'border-warn/40 bg-warn/10',
    title: 'text-warn',
    badge: 'text-warn',
  },
  trigger_deload: {
    container: 'border-accent/40 bg-accent/10',
    title: 'text-accent',
    badge: 'text-accent',
  },
  phase_transition: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  exercise_reorder: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  rotate_day: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  volume_adjust: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  intensity_adjust: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  single_exercise_swap: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  refer_technique_or_loading: {
    container: 'border-warn/40 bg-warn/10',
    title: 'text-warn',
    badge: 'text-warn',
  },
  split_rotation: {
    container: 'border-border bg-surface/40',
    title: 'text-text',
    badge: 'text-muted',
  },
};

function EffortSection({
  effort,
}: {
  effort: {
    windowDays: number;
    avgSessionRpe: number | null;
    sessionRpeSampleCount: number;
    avgSetRir: number | null;
    setRirSampleCount: number;
    rirDrift: number | null;
    rirDriftExerciseCount: number;
  };
}) {
  // Hide entirely when no signal — avoids dead UI for clients who haven't
  // started capturing RIR/sRPE yet.
  if (
    effort.avgSessionRpe == null &&
    effort.avgSetRir == null &&
    effort.rirDrift == null
  )
    return null;

  const driftTone =
    effort.rirDrift != null && effort.rirDrift >= 1
      ? 'warn'
      : effort.rirDrift != null && effort.rirDrift <= -1
        ? 'positive'
        : 'default';
  const driftHint =
    effort.rirDrift == null
      ? null
      : effort.rirDrift >= 1
        ? 'fatigue'
        : effort.rirDrift <= -1
          ? 'easier'
          : 'flat';

  return (
    <section
      aria-label="Effort window"
      className="mt-4 mb-2 rounded-md border border-border bg-surface/40 px-4 py-3"
    >
      <p className="text-[10px] uppercase tracking-[0.22em] text-faint mb-2">
        Effort · last {effort.windowDays} days
      </p>
      <dl className="grid grid-cols-3 gap-3 text-xs">
        <EffortStat
          label="Session RPE"
          value={effort.avgSessionRpe != null ? effort.avgSessionRpe.toFixed(1) : '—'}
          sub={`${effort.sessionRpeSampleCount} session${effort.sessionRpeSampleCount === 1 ? '' : 's'}`}
        />
        <EffortStat
          label="Set RIR"
          value={effort.avgSetRir != null ? effort.avgSetRir.toFixed(1) : '—'}
          sub={`${effort.setRirSampleCount} set${effort.setRirSampleCount === 1 ? '' : 's'}`}
        />
        <EffortStat
          label="RIR drift"
          value={
            effort.rirDrift != null
              ? (effort.rirDrift > 0 ? '+' : '') + effort.rirDrift.toFixed(1)
              : '—'
          }
          sub={
            driftHint
              ? `${driftHint} · ${effort.rirDriftExerciseCount}ex`
              : `${effort.rirDriftExerciseCount}ex`
          }
          tone={driftTone}
        />
      </dl>
    </section>
  );
}

function EffortStat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'default' | 'warn' | 'positive';
}) {
  const valueTone =
    tone === 'warn'
      ? 'text-warn'
      : tone === 'positive'
        ? 'text-primary-hi'
        : 'text-text';
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono tabular-nums text-sm ${valueTone}`}>
        {value}
        <span className="ml-2 text-[10px] uppercase tracking-[0.18em] text-faint">
          {sub}
        </span>
      </dd>
    </div>
  );
}

function ContextStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'accent';
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-faint">{label}</dt>
      <dd
        className={
          'mt-0.5 font-mono tabular-nums text-sm ' +
          (tone === 'accent' ? 'text-accent' : 'text-text')
        }
      >
        {value}
      </dd>
    </div>
  );
}
