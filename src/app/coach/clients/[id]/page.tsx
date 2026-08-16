import Link from 'next/link';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { format, formatDistanceToNow, startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db, signMediaUrls } from '@/lib/supabase';
import { computeProgramContext } from '@/lib/program-week';
import { Chip, PageHeader } from '../../ui';
import { AnalysisSection, AnalysisSkeleton } from './analysis-section';

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

/** Anchor tabs — ids must match the section wrappers below. */
const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'program', label: 'Program' },
  { id: 'check-ins', label: 'Check-ins' },
  { id: 'history', label: 'History' },
] as const;

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
  // all keyed off clientId only and can run in a single round-trip. The
  // heavy analysis (effort window + recommender) streams separately behind
  // <Suspense> — see AnalysisSection.
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

  // Sign photo paths so we can render private-bucket assets.
  const photoPaths: string[] = [];
  for (const c of checkIns ?? []) {
    const ph = (c.check_in_photos as Array<{ storage_url: string }>) ?? [];
    for (const p of ph) photoPaths.push(p.storage_url);
  }

  const [{ data: days }, signed] = await Promise.all([
    program
      ? supa
          .from('days')
          .select(
            'id, day_index, label, exercises(id, position, name, prescription_raw, coach_note, archived_at, muscle_group)',
          )
          .eq('program_id', program.id)
          .order('day_index')
      : Promise.resolve({ data: [] as never }),
    signMediaUrls(PHOTO_BUCKET, photoPaths),
  ]);

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

      {/* Section jump bar — sticks just below the coach header (whose
          height is ~80px; the blur ground makes small drift invisible).
          This page is a long single column; the coach was scrolling
          blind to reach history. */}
      <nav
        aria-label="Page sections"
        className="sticky top-[80px] z-20 -mx-5 sm:-mx-8 px-5 sm:px-8 mb-4 bg-bg/85 backdrop-blur-xl border-b border-border"
      >
        <div className="flex gap-1 overflow-x-auto no-scrollbar py-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="shrink-0 px-3 py-1.5 rounded-[var(--r-flat)] text-[10px] uppercase tracking-[0.18em] font-medium text-muted hover:text-text hover:bg-surface transition-colors"
            >
              {s.label}
            </a>
          ))}
        </div>
      </nav>

      <div id="overview" className="scroll-mt-32">
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

        {/* Effort + recommendation stream in when the engine finishes;
            the rest of the page is already interactive. */}
        <Suspense fallback={<AnalysisSkeleton />}>
          <AnalysisSection clientId={client.id} />
        </Suspense>

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
      </div>

      <div id="program" className="scroll-mt-32">
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
      </div>

      <section id="check-ins" className="mt-8 scroll-mt-32">
        <h2 className="text-xs uppercase tracking-[0.18em] text-faint mb-3">Check-ins</h2>
        {checkIns && checkIns.length > 0 ? (
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
                  className="rounded-[var(--r-card)] border border-border bg-surface/60 px-4 py-3"
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
        ) : (
          <p className="text-sm text-muted">No check-ins yet.</p>
        )}
      </section>

      <div id="history" className="scroll-mt-32">
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
      </div>

      <p className="mt-8 text-xs text-faint">
        Last activity:{' '}
        {workouts && workouts.length > 0
          ? formatDistanceToNow(new Date(workouts[0].started_at), { addSuffix: true })
          : 'never'}
      </p>
    </main>
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
