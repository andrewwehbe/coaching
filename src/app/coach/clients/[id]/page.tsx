import Link from 'next/link';
import { notFound } from 'next/navigation';
import { format, formatDistanceToNow, startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db, signMediaUrls } from '@/lib/supabase';

const PHOTO_BUCKET = 'check-in-photos';
import { ClientActions } from './client-actions';
import { ProgramSection } from './program-section';
import { HistorySection } from './history-section';

type Params = Promise<{ id: string }>;

export const dynamic = 'force-dynamic';

export default async function ClientDetailPage(props: { params: Params }) {
  await requireCoach();
  const { id } = await props.params;

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select(
      'id, name, active, weekly_day_target, body_weight_freq, photo_check_in_enabled, meal_plan_enabled, created_at, deactivated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (!client) notFound();

  const { data: program } = await supa
    .from('programs')
    .select('id, source_filename, uploaded_at')
    .eq('client_id', id)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: days } = program
    ? await supa
        .from('days')
        .select('id, day_index, label, exercises(id, position, name, prescription_raw, coach_note, archived_at)')
        .eq('program_id', program.id)
        .order('day_index')
    : { data: [] as never };

  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });

  const [{ data: workouts }, { data: thisWeek }, { data: checkIns }] = await Promise.all([
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
  ]);

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
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <header className="mb-4">
        <Link href="/coach" className="text-sm text-muted hover:text-text transition-colors">
          ← Dashboard
        </Link>
        <div className="flex items-start justify-between mt-2 gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
            <p className="text-xs text-faint mt-1">
              Joined {format(new Date(client.created_at), 'MMM d, yyyy')} ·{' '}
              {client.active ? 'active' : 'deactivated'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className="text-xs text-muted px-2 py-1 rounded-full border border-border">
              {client.weekly_day_target}d/week
            </span>
            {client.photo_check_in_enabled && (
              <span className="text-xs text-muted px-2 py-1 rounded-full border border-border">
                photos
              </span>
            )}
            {client.body_weight_freq !== 'none' && (
              <span className="text-xs text-muted px-2 py-1 rounded-full border border-border">
                BW: {client.body_weight_freq}
              </span>
            )}
            {client.meal_plan_enabled && (
              <span className="text-xs text-muted px-2 py-1 rounded-full border border-border">
                meals
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-2 mb-6">
        <Link
          href={`/coach/clients/${client.id}/log`}
          className="rounded-xl bg-primary hover:bg-primary-hi text-bg px-4 py-2 text-sm font-semibold transition-colors shadow-[0_8px_24px_-10px_rgba(34,197,94,0.6)]"
        >
          Log on behalf
        </Link>
        {program && (
          <Link
            href={`/coach/clients/${client.id}/program/edit`}
            className="rounded-xl border border-border bg-surface/60 hover:bg-surface px-4 py-2 text-sm font-medium transition-colors"
          >
            Edit program
          </Link>
        )}
      </div>

      <ClientActions
        clientId={client.id}
        active={client.active}
        currentWeekIsDeload={currentWeekIsDeload}
      />

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

