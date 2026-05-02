import Link from 'next/link';
import { notFound } from 'next/navigation';
import { format } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db, signMediaUrls } from '@/lib/supabase';
import { ResetWorkoutButton } from './reset-workout-button';

const VIDEO_BUCKET = 'workout-videos';

type Params = Promise<{ id: string }>;

export const dynamic = 'force-dynamic';

export default async function SessionDetailPage(props: { params: Params }) {
  await requireCoach();
  const { id } = await props.params;

  const supa = db();
  const { data: workout } = await supa
    .from('workouts')
    .select(
      'id, client_id, day_id, started_at, completed_at, week_start, is_deload, days(label), clients(name)'
    )
    .eq('id', id)
    .maybeSingle();
  if (!workout) notFound();

  const { data: logs } = await supa
    .from('exercise_logs')
    .select(
      'id, exercise_id, status, skip_reason, pain_reason, client_note, exercises(name, position, prescription_raw, coach_note)'
    )
    .eq('workout_id', id);

  const logIds = (logs ?? []).map((l) => l.id);
  const { data: sets } = logIds.length
    ? await supa
        .from('sets')
        .select(
          'id, exercise_log_id, set_number, weight, unit, reps, rir, cardio_minutes, notes, video_url'
        )
        .in('exercise_log_id', logIds)
        .order('set_number')
    : { data: [] as never };

  const videoPaths = (sets ?? []).map((s) => s.video_url).filter((p): p is string => !!p);
  const signed = videoPaths.length ? await signMediaUrls(VIDEO_BUCKET, videoPaths) : [];
  const signedByPath = new Map<string, string>();
  videoPaths.forEach((p, i) => {
    if (signed[i]) signedByPath.set(p, signed[i]!);
  });

  const setsByLog = new Map<
    string,
    Array<{
      id: string;
      set_number: number;
      weight: number | null;
      unit: string | null;
      reps: number | null;
      rir: number | null;
      cardio_minutes: number | null;
      notes: string | null;
      video_signed_url: string | null;
    }>
  >();
  for (const s of sets ?? []) {
    const arr = setsByLog.get(s.exercise_log_id) ?? [];
    arr.push({
      id: s.id,
      set_number: s.set_number,
      weight: s.weight === null ? null : Number(s.weight),
      unit: s.unit,
      reps: s.reps,
      rir: s.rir,
      cardio_minutes: s.cardio_minutes,
      notes: s.notes,
      video_signed_url: s.video_url ? signedByPath.get(s.video_url) ?? null : null,
    });
    setsByLog.set(s.exercise_log_id, arr);
  }

  const exercises = (logs ?? [])
    .map((l) => {
      const raw = l.exercises as unknown;
      const ex = (Array.isArray(raw) ? raw[0] : raw) as
        | { name?: string; position?: number; prescription_raw?: string; coach_note?: string }
        | null;
      return {
        id: l.id,
        name: ex?.name ?? '(unknown)',
        position: ex?.position ?? 0,
        prescription_raw: ex?.prescription_raw ?? null,
        coach_note: ex?.coach_note ?? null,
        status: l.status as string,
        skip_reason: l.skip_reason as string | null,
        pain_reason: l.pain_reason as string | null,
        client_note: l.client_note as string | null,
        sets: setsByLog.get(l.id) ?? [],
      };
    })
    .sort((a, b) => a.position - b.position);

  const clientRaw = workout.clients as unknown;
  const client = (Array.isArray(clientRaw) ? clientRaw[0] : clientRaw) as { name?: string } | null;
  const dayRaw = workout.days as unknown;
  const day = (Array.isArray(dayRaw) ? dayRaw[0] : dayRaw) as { label?: string } | null;

  const totalSets = exercises.reduce((n, e) => n + e.sets.length, 0);
  const totalVideos = exercises.reduce(
    (n, e) => n + e.sets.filter((s) => s.video_signed_url).length,
    0
  );

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <Link href="/coach/sessions" className="text-sm text-muted hover:text-text transition-colors">
        ← Sessions
      </Link>
      <header className="mt-2 mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {client?.name ?? 'Workout'}
          {day?.label && <span className="text-muted font-normal"> · {day.label}</span>}
        </h1>
        <p className="text-xs text-faint mt-1">
          {format(new Date(workout.started_at), 'EEEE MMM d, h:mma')}
          {workout.completed_at ? (
            <span className="ml-2 text-primary-hi">· completed</span>
          ) : (
            <span className="ml-2 text-warn">· in progress</span>
          )}
          {workout.is_deload && <span className="ml-2 text-accent">· deload</span>}
          <span className="ml-2">
            · {totalSets} sets, {totalVideos} video{totalVideos === 1 ? '' : 's'}
          </span>
        </p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <Link
            href={`/coach/clients/${workout.client_id}`}
            className="text-xs text-primary-hi hover:text-primary"
          >
            Open client →
          </Link>
          <ResetWorkoutButton workoutId={workout.id} />
        </div>
      </header>

      {exercises.length === 0 ? (
        <p className="text-sm text-muted">No exercises logged yet.</p>
      ) : (
        <ol className="space-y-4">
          {exercises.map((ex) => (
            <li key={ex.id} className="rounded-2xl border border-border bg-surface/60 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium">
                  <span className="text-faint mr-2 tabular-nums">{ex.position}.</span>
                  {ex.name}
                  {ex.status !== 'completed' && (
                    <span
                      className={`ml-2 text-xs ${
                        ex.status === 'pain' ? 'text-warn' : 'text-faint'
                      }`}
                    >
                      {ex.status}
                    </span>
                  )}
                </p>
                {ex.prescription_raw && (
                  <span className="text-xs text-faint font-mono shrink-0">
                    {ex.prescription_raw}
                  </span>
                )}
              </div>

              {(ex.pain_reason || ex.skip_reason || ex.client_note || ex.coach_note) && (
                <div className="mt-2 space-y-1 text-xs">
                  {ex.pain_reason && (
                    <p className="text-warn">⚠ Pain: {ex.pain_reason}</p>
                  )}
                  {ex.skip_reason && (
                    <p className="text-muted">Skipped: {ex.skip_reason}</p>
                  )}
                  {ex.client_note && (
                    <p className="text-muted">Client note: {ex.client_note}</p>
                  )}
                  {ex.coach_note && (
                    <p className="text-faint italic">Your note: {ex.coach_note}</p>
                  )}
                </div>
              )}

              {ex.sets.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm">
                  {ex.sets.map((s) => (
                    <li key={s.id} className="rounded-lg bg-bg/30 border border-border/60 p-3">
                      <div className="flex items-center justify-between gap-3 text-text">
                        <span>
                          <span className="text-faint mr-2">Set {s.set_number}</span>
                          {s.weight != null
                            ? `${s.weight}${(s.unit ?? '').toUpperCase()} × ${s.reps ?? '?'}`
                            : s.cardio_minutes != null
                              ? `${s.cardio_minutes} min`
                              : '—'}
                          {s.rir != null && (
                            <span className="text-faint"> @ {s.rir} RIR</span>
                          )}
                        </span>
                        {s.video_signed_url && (
                          <a
                            href={s.video_signed_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-primary-hi hover:text-primary shrink-0"
                          >
                            ▶ open
                          </a>
                        )}
                      </div>
                      {s.notes && (
                        <p className="mt-1.5 text-xs text-muted">{s.notes}</p>
                      )}
                      {s.video_signed_url && (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video
                          src={s.video_signed_url}
                          controls
                          preload="metadata"
                          playsInline
                          className="mt-2 max-h-80 w-full rounded-lg border border-border bg-black"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
