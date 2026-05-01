import Link from 'next/link';
import { notFound } from 'next/navigation';
import { format, formatDistanceToNow, startOfWeek, formatISO } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
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

  const [{ data: workouts }, { data: thisWeek }] = await Promise.all([
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
  ]);

  const currentWeekIsDeload = (thisWeek ?? []).some((w) => w.is_deload);

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <header className="mb-4">
        <Link href="/coach" className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Dashboard
        </Link>
        <div className="flex items-start justify-between mt-2 gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{client.name}</h1>
            <p className="text-xs text-neutral-500 mt-1">
              Joined {format(new Date(client.created_at), 'MMM d, yyyy')} ·{' '}
              {client.active ? 'active' : 'deactivated'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 px-2 py-1 rounded-full border border-neutral-800">
              {client.weekly_day_target}d/week
            </span>
            {client.photo_check_in_enabled && (
              <span className="text-xs text-neutral-400 px-2 py-1 rounded-full border border-neutral-800">
                photos
              </span>
            )}
            {client.body_weight_freq !== 'none' && (
              <span className="text-xs text-neutral-400 px-2 py-1 rounded-full border border-neutral-800">
                BW: {client.body_weight_freq}
              </span>
            )}
            {client.meal_plan_enabled && (
              <span className="text-xs text-neutral-400 px-2 py-1 rounded-full border border-neutral-800">
                meals
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="flex gap-2 mb-6">
        <Link
          href={`/coach/clients/${client.id}/log`}
          className="rounded-lg bg-emerald-700/80 hover:bg-emerald-700 px-4 py-2 text-sm font-medium"
        >
          Log on behalf
        </Link>
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

      <p className="mt-8 text-xs text-neutral-500">
        Last activity:{' '}
        {workouts && workouts.length > 0
          ? formatDistanceToNow(new Date(workouts[0].started_at), { addSuffix: true })
          : 'never'}
      </p>
    </main>
  );
}

