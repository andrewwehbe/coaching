import Link from 'next/link';
import { notFound } from 'next/navigation';
import { format, formatDistanceToNow, startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db, signMediaUrls } from '@/lib/supabase';
import { Chip, PageHeader } from '../../ui';

const PHOTO_BUCKET = 'check-in-photos';
import { ClientActions } from './client-actions';
import { ProgramSection } from './program-section';
import { HistorySection } from './history-section';
import { SkipPainSection } from './skip-pain-section';

type Params = Promise<{ id: string }>;

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

  // Client + program + workouts + thisWeek + checkIns + flags are all keyed
  // off clientId only and can run in a single round-trip.
  const [
    { data: client },
    { data: program },
    { data: workouts },
    { data: thisWeek },
    { data: checkIns },
    { data: skipPain },
  ] = await Promise.all([
    supa
      .from('clients')
      .select(
        'id, name, active, weekly_day_target, body_weight_freq, photo_check_in_enabled, meal_plan_enabled, log_mode, created_at, deactivated_at',
      )
      .eq('id', id)
      .maybeSingle(),
    supa
      .from('programs')
      .select('id, source_filename, uploaded_at')
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
        'id, status, skip_reason, pain_reason, created_at, exercises!inner(name), workouts!inner(client_id, started_at)',
      )
      .eq('workouts.client_id', id)
      .gte('workouts.started_at', skipPainSinceIso)
      .or('status.eq.skipped,status.eq.pain,pain_reason.not.is.null')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  if (!client) notFound();

  const { data: days } = program
    ? await supa
        .from('days')
        .select('id, day_index, label, exercises(id, position, name, prescription_raw, coach_note, archived_at)')
        .eq('program_id', program.id)
        .order('day_index')
    : { data: [] as never };

  const currentWeekIsDeload = (thisWeek ?? []).some((w) => w.is_deload);

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
      </div>

      <ClientActions
        clientId={client.id}
        active={client.active}
        currentWeekIsDeload={currentWeekIsDeload}
        logMode={client.log_mode === 'best' ? 'best' : 'sets'}
      />

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

