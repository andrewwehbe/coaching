import Link from 'next/link';
import { format } from 'date-fns';
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { getWorkoutDetail, type SetDetail } from '@/lib/client-history';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string; weekStart: string; workoutId: string }>;

export default async function WorkoutDetailPage(props: { params: Params }) {
  await requireCoach();
  const { clientId, weekStart, workoutId } = await props.params;

  const supa = db();
  const [detail, { data: client }] = await Promise.all([
    getWorkoutDetail(clientId, weekStart, workoutId),
    supa.from('clients').select('id, name').eq('id', clientId).maybeSingle(),
  ]);
  if (!detail || !client) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <Link
        href={`/coach/status/${clientId}/history/${weekStart}`}
        prefetch={false}
        className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
      >
        ← {client.name} · week of {format(new Date(weekStart), 'MMM d')}
      </Link>
      <h1 className="mt-4 font-display text-3xl sm:text-4xl tracking-tight">
        {detail.workout.dayLabel}
      </h1>
      <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
        {format(new Date(detail.workout.startedAt), 'EEE h:mma').toLowerCase()}
        {detail.workout.completedAt && (
          <>
            {' '}
            <span className="mx-1 text-border-strong">·</span> done{' '}
            {format(new Date(detail.workout.completedAt), 'h:mma').toLowerCase()}
          </>
        )}
      </p>

      {detail.exercises.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No exercises logged.
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          {detail.exercises.map((e) => (
            <section key={e.exerciseId}>
              <h2 className="font-medium text-text">{e.name}</h2>
              <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                {e.prescribedSets ?? '—'} set{e.prescribedSets === 1 ? '' : 's'}
                {e.prescriptionRaw && (
                  <span className="text-faint/80"> · {e.prescriptionRaw}</span>
                )}
              </p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-faint">
                    <th className="py-1 pr-3 font-normal">Set</th>
                    <th className="py-1 pr-3 font-normal">Weight</th>
                    <th className="py-1 pr-3 font-normal">Reps</th>
                    <th className="py-1 pr-3 font-normal">RIR</th>
                    <th className="py-1 pr-3 font-normal">Video</th>
                    <th className="py-1 pr-3 font-normal">PR</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {e.sets.map((s) => (
                    <SetRow key={s.setNumber} s={s} />
                  ))}
                </tbody>
              </table>
              {e.painReason && (
                <p className="mt-2 text-xs text-danger">Pain: {e.painReason}</p>
              )}
              {e.clientNote && (
                <p className="mt-1 text-xs text-muted">Note: {e.clientNote}</p>
              )}
              {e.sets.some((s) => s.notes) && (
                <ul className="mt-1 text-xs text-muted space-y-0.5">
                  {e.sets
                    .filter((s) => s.notes)
                    .map((s) => (
                      <li key={`note-${s.setNumber}`}>
                        Set {s.setNumber}: {s.notes}
                      </li>
                    ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function SetRow({ s }: { s: SetDetail }) {
  return (
    <tr className="border-t border-border">
      <td className="py-1.5 pr-3 text-muted">{s.setNumber}</td>
      <td className="py-1.5 pr-3">
        {s.weight == null ? '—' : `${s.weight} ${(s.unit ?? 'kg').toUpperCase()}`}
      </td>
      <td className="py-1.5 pr-3">{s.reps ?? '—'}</td>
      <td className="py-1.5 pr-3 text-muted">{s.rir ?? '—'}</td>
      <td className="py-1.5 pr-3">
        {s.videoUrl ? (
          <a
            href={s.videoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary-hi hover:underline"
          >
            ▶
          </a>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="py-1.5 pr-3">
        {s.isPR ? <span className="text-primary-hi">✓</span> : <span className="text-faint">—</span>}
      </td>
    </tr>
  );
}
