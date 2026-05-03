'use client';

import { useState } from 'react';
import { format } from 'date-fns';

type Workout = {
  id: string;
  day_id: string;
  started_at: string;
  completed_at: string | null;
  week_start: string;
  is_deload: boolean;
  days: { label: string } | null;
};

export function HistorySection({ workouts }: { workouts: Workout[] }) {
  if (workouts.length === 0) {
    return (
      <section className="mb-6">
        <h2 className="text-sm uppercase tracking-wide text-faint mb-2">History</h2>
        <p className="rounded-xl border border-border bg-surface/60 px-4 py-3 text-sm text-muted">
          No workouts yet.
        </p>
      </section>
    );
  }

  // Group by week_start, descending.
  const byWeek = new Map<string, Workout[]>();
  for (const w of workouts) {
    const key = w.week_start;
    const list = byWeek.get(key) ?? [];
    list.push(w);
    byWeek.set(key, list);
  }
  const weeks = Array.from(byWeek.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));

  return (
    <section className="mb-6">
      <h2 className="text-sm uppercase tracking-wide text-faint mb-2">History</h2>
      <div className="space-y-3">
        {weeks.map(([week, ws]) => (
          <div key={week} className="rounded-xl border border-border bg-surface/60 p-3">
            <p className="text-xs text-faint mb-2">
              Week of {format(new Date(week), 'MMM d, yyyy')}
              {ws.some((w) => w.is_deload) && (
                <span className="ml-2 text-warn">· deload</span>
              )}
            </p>
            <ul className="space-y-1.5">
              {ws.map((w) => (
                <WorkoutRow key={w.id} workout={w} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkoutRow({ workout }: { workout: Workout }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [details, setDetails] = useState<DetailExercise[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!open && !details && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/coach/workouts/${workout.id}`);
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? 'Failed to load');
        } else {
          setDetails(body.exercises);
        }
      } catch {
        setError('Network error');
      } finally {
        setLoading(false);
      }
    }
    setOpen((o) => !o);
  }

  return (
    <li>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between text-left text-sm py-1 text-text hover:text-primary-hi transition-colors"
      >
        <span>
          {workout.days?.label ?? 'Workout'}
          {!workout.completed_at && (
            <span className="ml-2 text-warn text-xs">in progress</span>
          )}
        </span>
        <span className="text-xs text-faint">
          {format(new Date(workout.started_at), 'EEE MMM d, h:mma')} · {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div className="mt-2 mb-3 pl-3 border-l border-border text-sm">
          {loading && <p className="text-faint text-xs">Loading…</p>}
          {error && <p className="text-danger text-xs">{error}</p>}
          {details && details.length === 0 && (
            <p className="text-faint text-xs">No logged sets.</p>
          )}
          {details &&
            details.map((ex) => (
              <div key={ex.exercise_log_id} className="py-1.5">
                <p className="font-medium">
                  {ex.name}
                  {ex.status !== 'completed' && (
                    <span className="ml-2 text-xs text-warn">{ex.status}</span>
                  )}
                </p>
                {ex.sets.length > 0 && (
                  <ul className="text-xs text-muted mt-1 space-y-1.5">
                    {ex.sets.map((s) => (
                      <li key={s.set_number}>
                        <div>
                          <span className="text-faint">Set {s.set_number}:</span>{' '}
                          {s.weight != null ? `${s.weight}${s.unit ?? ''} × ${s.reps ?? '?'}` : '—'}
                          {s.rir != null && <span className="text-faint"> @ {s.rir} RIR</span>}
                          {s.cardio_minutes != null && ` · ${s.cardio_minutes} min`}
                          {s.notes && ` · ${s.notes}`}
                          {s.video_signed_url && (
                            <a
                              href={s.video_signed_url}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-2 inline-flex items-center gap-1 text-primary-hi hover:text-primary"
                            >
                              ▶ video
                            </a>
                          )}
                        </div>
                        {s.video_signed_url && (
                          // eslint-disable-next-line jsx-a11y/media-has-caption
                          <video
                            src={s.video_signed_url}
                            controls
                            preload="metadata"
                            playsInline
                            className="mt-1 max-h-72 w-full max-w-sm rounded-lg border border-border bg-black"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {(ex.client_note || ex.skip_reason || ex.pain_reason) && (
                  <p className="text-xs text-faint mt-1">
                    {ex.pain_reason ?? ex.skip_reason ?? ex.client_note}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}
    </li>
  );
}

type DetailSet = {
  set_number: number;
  weight: number | null;
  unit: string | null;
  reps: number | null;
  rir: number | null;
  cardio_minutes: number | null;
  notes: string | null;
  video_signed_url: string | null;
};

type DetailExercise = {
  exercise_log_id: string;
  name: string;
  status: string;
  client_note: string | null;
  skip_reason: string | null;
  pain_reason: string | null;
  sets: DetailSet[];
};
