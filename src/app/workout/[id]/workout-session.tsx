'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { Cue } from '@/lib/cue';
import { CueDisplay } from './cue-display';
import { RestTimer } from '@/components/rest-timer';
import { OfflineBanner } from '@/components/offline-banner';
import { enqueueAndSend, flushQueue, pendingCount } from '@/lib/offline-queue';

export type LoggedSet = {
  setNumber: number;
  weight: number | null;
  unit: 'kg' | 'lb' | null;
  reps: number | null;
  rir: number | null;
  cardioMinutes: number | null;
  videoUrl: string | null;
  notes: string | null;
};

export type ExerciseState = {
  id: string;
  name: string;
  position: number;
  prescriptionRaw: string | null;
  prescribedSets: number | null;
  repMin: number | null;
  repMax: number | null;
  coachNote: string | null;
  isCardio: boolean;
  cardioType: 'treadmill' | 'elliptical' | 'stairmaster' | null;
  cue: Cue;
  logStatus: 'completed' | 'skipped' | 'pain' | null;
  sets: LoggedSet[];
};

type ModalState =
  | { kind: 'none' }
  | { kind: 'skip'; exerciseId: string; name: string }
  | { kind: 'pain'; exerciseId: string; name: string };

export function WorkoutSession({
  workoutId,
  dayLabel,
  completed,
  exercises,
}: {
  workoutId: string;
  dayLabel: string;
  completed: boolean;
  exercises: ExerciseState[];
}) {
  const router = useRouter();

  const [state, setState] = useState(exercises);
  const [doneNow, setDoneNow] = useState(completed);
  const [resting, setResting] = useState(false);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    let cancelled = false;
    async function refresh() {
      const c = await pendingCount();
      if (!cancelled) setPending(c);
    }
    async function flush() {
      const sent = await flushQueue();
      if (sent > 0) router.refresh();
      await refresh();
    }
    refresh();
    flush();
    const onOnline = () => {
      setOnline(true);
      void flush();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const interval = window.setInterval(() => {
      void refresh();
    }, 4000);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(interval);
    };
  }, [router]);

  // Track the visible exercise as state so the client can jump around with
  // Prev/Next. Starts at the first incomplete one. After they log a final
  // set / skip / pain / "done", we auto-advance via advanceFrom().
  const [currentIdx, setCurrentIdx] = useState(() => {
    // The set route flips status to 'completed' on the very first set, so on
    // a refresh mid-exercise the server-side status alone isn't enough to
    // tell "done" from "still has sets left". Treat a 'completed' strength
    // exercise with sets.length < prescribedSets as still active.
    const i = exercises.findIndex((e) => {
      if (e.logStatus == null) return true;
      if (
        e.logStatus === 'completed' &&
        !e.isCardio &&
        e.prescribedSets != null &&
        e.sets.length < e.prescribedSets
      ) {
        return true;
      }
      return false;
    });
    return i >= 0 ? i : 0;
  });
  const current = state[currentIdx] ?? null;
  const completedCount = state.filter((e) => e.logStatus != null).length;
  const allDone = state.length > 0 && completedCount === state.length;

  function advanceFrom(updated: ExerciseState[], fromIdx: number): number {
    for (let i = fromIdx + 1; i < updated.length; i++) {
      if (updated[i].logStatus == null) return i;
    }
    for (let i = 0; i < fromIdx; i++) {
      if (updated[i].logStatus == null) return i;
    }
    return fromIdx;
  }

  // Set form state per exercise.
  const [weight, setWeight] = useState('');
  const [unit, setUnit] = useState<'kg' | 'lb'>('kg');
  const [reps, setReps] = useState('');
  const [rir, setRir] = useState('');
  const [notes, setNotes] = useState('');
  const [cardioMin, setCardioMin] = useState('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoProgress, setVideoProgress] = useState(0);

  function resetForm() {
    setWeight('');
    setReps('');
    setRir('');
    setNotes('');
    setCardioMin('');
    setVideoUrl(null);
    setVideoError(null);
  }

  const setNumber = (current?.sets.length ?? 0) + 1;
  const isLastPrescribed =
    current?.prescribedSets != null && setNumber >= current.prescribedSets;

  async function submitSet() {
    if (!current) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        exerciseId: current.id,
        setNumber,
      };
      if (current.isCardio) {
        body.cardioMinutes = cardioMin ? Number(cardioMin) : null;
      } else {
        // Normalize comma decimal separator (Arabic/European keyboards) to dot
        // so Number() doesn't return NaN.
        body.weight = weight ? Number(weight.replace(',', '.')) : null;
        body.unit = unit;
        body.reps = reps ? Number(reps) : null;
        body.rir = rir ? Number(rir) : null;
      }
      if (notes) body.notes = notes;
      // videoUrl actually holds the bucket-relative storage path; server expects videoPath.
      if (videoUrl) body.videoPath = videoUrl;

      const res = await enqueueAndSend(`/api/client/workout/${workoutId}/set`, body);
      if (!res.ok && res.status !== 202) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? 'Failed to save set');
        return;
      }

      // Update local state.
      setState((prev) => {
        const next = prev.map((e) =>
          e.id === current.id
            ? {
                ...e,
                sets: [
                  ...e.sets,
                  {
                    setNumber,
                    weight: body.weight as number | null,
                    unit: (body.unit as 'kg' | 'lb' | undefined) ?? null,
                    reps: body.reps as number | null,
                    rir: body.rir as number | null,
                    cardioMinutes: body.cardioMinutes as number | null,
                    videoUrl: (body.videoUrl as string | null) ?? null,
                    notes: (body.notes as string | null) ?? null,
                  },
                ],
                logStatus: (isLastPrescribed ? 'completed' : null) as ExerciseState['logStatus'],
              }
            : e
        );
        if (isLastPrescribed) setCurrentIdx((idx) => advanceFrom(next, idx));
        return next;
      });

      resetForm();

      if (isLastPrescribed) {
        // Move to next exercise; no rest needed.
        setResting(false);
      } else {
        setResting(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function addExtraSet() {
    if (!current) return;
    // Just clear "isLastPrescribed" by allowing another submit cycle.
    // We do this by NOT marking the exercise complete and letting the user
    // submit another set above the prescribed count.
    // Resetting form is enough.
    resetForm();
  }

  async function moveToNextExercise() {
    if (!current) return;
    // Manual "I'm done with this exercise" — same effect as auto-advance.
    setState((prev) => {
      const next = prev.map((e) =>
        e.id === current.id ? { ...e, logStatus: 'completed' as const } : e
      );
      setCurrentIdx((idx) => advanceFrom(next, idx));
      return next;
    });
    resetForm();
  }

  async function submitSkip(reason: string) {
    if (modal.kind !== 'skip') return;
    setSubmitting(true);
    try {
      const res = await enqueueAndSend(`/api/client/workout/${workoutId}/skip`, {
        exerciseId: modal.exerciseId,
        reason,
      });
      if (!res.ok && res.status !== 202) {
        alert('Failed to skip');
        return;
      }
      setState((prev) => {
        const next = prev.map((e) =>
          e.id === modal.exerciseId ? { ...e, logStatus: 'skipped' as const } : e
        );
        setCurrentIdx((idx) => advanceFrom(next, idx));
        return next;
      });
      setModal({ kind: 'none' });
      resetForm();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPain(reason: string) {
    if (modal.kind !== 'pain') return;
    setSubmitting(true);
    try {
      const res = await enqueueAndSend(`/api/client/workout/${workoutId}/pain`, {
        exerciseId: modal.exerciseId,
        reason,
      });
      if (!res.ok && res.status !== 202) {
        alert('Failed to send pain report');
        return;
      }
      setState((prev) => {
        const next = prev.map((e) =>
          e.id === modal.exerciseId ? { ...e, logStatus: 'pain' as const } : e
        );
        setCurrentIdx((idx) => advanceFrom(next, idx));
        return next;
      });
      setModal({ kind: 'none' });
      resetForm();
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadVideo(file: File) {
    setVideoBusy(true);
    setVideoError(null);
    setVideoProgress(0);
    try {
      if (file.size > 25 * 1024 * 1024) {
        setVideoError('Max 25 MB.');
        return;
      }
      const presign = await fetch('/api/client/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          contentType: file.type || 'video/mp4',
        }),
      });
      if (!presign.ok) {
        const e = await presign.json().catch(() => ({}));
        setVideoError(e.error ?? 'Upload prep failed');
        return;
      }
      const { uploadUrl, path } = await presign.json();

      // XHR instead of fetch so we can show real upload progress — without
      // it, slow phone uploads look indistinguishable from a hung request.
      const ok = await new Promise<boolean>((resolveP) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('content-type', file.type || 'video/mp4');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setVideoProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => resolveP(xhr.status >= 200 && xhr.status < 300);
        xhr.onerror = () => resolveP(false);
        xhr.ontimeout = () => resolveP(false);
        xhr.timeout = 5 * 60 * 1000; // 5 minutes hard cap
        xhr.send(file);
      });

      if (!ok) {
        setVideoError('Upload failed. Check signal and try again.');
        return;
      }
      setVideoUrl(path);
    } finally {
      setVideoBusy(false);
    }
  }

  async function completeWorkout() {
    setSubmitting(true);
    try {
      const res = await enqueueAndSend(`/api/client/workout/${workoutId}/done`, {});
      if (!res.ok && res.status !== 202) {
        alert('Failed to complete workout');
        return;
      }
      setDoneNow(true);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelWorkout() {
    if (!confirm('Cancel this workout? Nothing will be saved.')) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/client/workout/${workoutId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error ?? 'Could not cancel');
        return;
      }
      router.push('/today');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }
  const noSetsLogged = state.every((e) => e.sets.length === 0);

  if (doneNow || allDone) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-6">
        <div className="h-20 w-20 rounded-full bg-primary/15 ring-1 ring-primary/40 flex items-center justify-center shadow-[0_0_60px_-10px_rgba(34,197,94,0.7)]">
          <svg className="h-10 w-10 text-primary-hi" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Workout done.</h1>
        <p className="text-muted">
          {completedCount} of {state.length} exercises logged.
        </p>
        {!doneNow && (
          <button
            onClick={completeWorkout}
            disabled={submitting}
            className="h-14 px-8 rounded-2xl bg-primary hover:bg-primary-hi text-bg font-semibold disabled:opacity-50 transition-colors shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
          >
            Finish & save
          </button>
        )}
        <Link href="/today" className="text-primary-hi hover:text-primary text-sm transition-colors">
          Back to today
        </Link>
      </main>
    );
  }

  if (!current) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
        <h1 className="text-2xl font-semibold">No exercises today.</h1>
        <Link href="/today" className="text-primary-hi hover:text-primary transition-colors">
          Back to today
        </Link>
      </main>
    );
  }

  const isFirstSetOverall = state.every((e) => e.sets.length === 0);

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="flex items-center justify-between mb-3 text-sm">
        <Link href="/today" className="text-muted hover:text-text transition-colors">
          ← {dayLabel}
        </Link>
        <span className="font-medium text-faint tabular-nums">
          {completedCount} / {state.length}
        </span>
      </header>

      <nav className="flex items-center justify-between gap-2 mb-4">
        <button
          type="button"
          onClick={() => {
            setCurrentIdx((i) => Math.max(0, i - 1));
            resetForm();
          }}
          disabled={currentIdx === 0}
          className="flex-1 h-10 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ← Prev
        </button>
        <span className="text-xs text-faint tabular-nums px-2">
          {currentIdx + 1} of {state.length}
        </span>
        <button
          type="button"
          onClick={() => {
            setCurrentIdx((i) => Math.min(state.length - 1, i + 1));
            resetForm();
          }}
          disabled={currentIdx >= state.length - 1}
          className="flex-1 h-10 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </nav>

      <OfflineBanner online={online} pending={pending} />

      {/* Progress bar */}
      <div className="mb-6 h-1 w-full rounded-full bg-surface-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${state.length ? (completedCount / state.length) * 100 : 0}%` }}
        />
      </div>

      {current.coachNote && (
        <div className="mb-5 rounded-2xl border border-accent/30 bg-accent/8 px-4 py-3 text-sm">
          <p className="text-xs uppercase tracking-wide text-accent mb-1 font-medium">From your coach</p>
          <p className="text-text">{current.coachNote}</p>
        </div>
      )}

      <p className="text-xs uppercase tracking-[0.18em] text-faint mb-1.5">
        Exercise {current.position}
        {current.logStatus === 'completed' && (
          <span className="ml-2 text-primary-hi normal-case tracking-normal">· done</span>
        )}
        {current.logStatus === 'skipped' && (
          <span className="ml-2 text-muted normal-case tracking-normal">· skipped</span>
        )}
        {current.logStatus === 'pain' && (
          <span className="ml-2 text-warn normal-case tracking-normal">· pain reported</span>
        )}
      </p>
      <h1 className="text-3xl font-bold leading-tight tracking-tight mb-2">{current.name}</h1>
      <p className="text-sm text-muted mb-5">{current.prescriptionRaw ?? '—'}</p>

      <CueDisplay cue={current.cue} />

      {isFirstSetOverall && (
        <div className="mt-5 rounded-2xl border border-warn/35 bg-warn/10 p-4 text-sm text-warn">
          <strong className="font-semibold">Warmup first.</strong> Do at least one
          warmup set with light weight and ensure form is perfect before logging
          working sets.
        </div>
      )}

      <section className="mt-6 space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            Set {setNumber}
            {current.prescribedSets ? (
              <span className="text-faint text-sm font-normal ml-1.5">
                of {current.prescribedSets}
              </span>
            ) : null}
          </h2>
          {current.sets.length > 0 && (
            <p className="text-xs text-muted">
              Last:{' '}
              <span className="text-text font-medium tabular-nums">
                {summarizeSet(current.sets[current.sets.length - 1], current.isCardio)}
              </span>
            </p>
          )}
        </div>

        {current.isCardio ? (
          <CardioFields
            cardioType={current.cardioType}
            minutes={cardioMin}
            setMinutes={setCardioMin}
          />
        ) : (
          <StrengthFields
            weight={weight}
            setWeight={setWeight}
            unit={unit}
            setUnit={setUnit}
            reps={reps}
            setReps={setReps}
            rir={rir}
            setRir={setRir}
          />
        )}

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          rows={2}
          className="w-full px-3 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-sm transition-shadow placeholder:text-faint"
        />

        <VideoUpload
          videoUrl={videoUrl}
          busy={videoBusy}
          progress={videoProgress}
          error={videoError}
          onPick={uploadVideo}
          onClear={() => setVideoUrl(null)}
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setModal({ kind: 'pain', exerciseId: current.id, name: current.name })}
            className="flex-1 h-11 rounded-xl border border-danger/40 text-danger text-sm font-medium hover:bg-danger/10 transition-colors"
          >
            Report pain
          </button>
          <button
            type="button"
            onClick={() => setModal({ kind: 'skip', exerciseId: current.id, name: current.name })}
            className="flex-1 h-11 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors"
          >
            Skip exercise
          </button>
        </div>

        <button
          type="button"
          onClick={submitSet}
          disabled={submitting || isFormEmpty(current.isCardio, weight, reps, cardioMin)}
          className="w-full h-14 rounded-2xl bg-primary hover:bg-primary-hi active:bg-primary-press text-bg text-base font-semibold disabled:opacity-40 disabled:shadow-none transition-all shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
        >
          {isLastPrescribed ? 'Log final set' : `Log set ${setNumber}`}
        </button>

        {isLastPrescribed && (
          <button
            type="button"
            onClick={addExtraSet}
            className="w-full text-center text-sm text-muted hover:text-text transition-colors"
          >
            Add an extra set
          </button>
        )}

        {current.sets.length > 0 && !isLastPrescribed && (
          <button
            type="button"
            onClick={moveToNextExercise}
            className="w-full text-center text-sm text-muted hover:text-text transition-colors"
          >
            Done with this exercise
          </button>
        )}

        <div className="pt-3 mt-3 border-t border-border flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={cancelWorkout}
            disabled={submitting}
            className="text-xs text-faint hover:text-warn transition-colors"
          >
            Cancel workout
          </button>
          {!noSetsLogged && (
            <button
              type="button"
              onClick={completeWorkout}
              disabled={submitting}
              className="text-xs text-primary-hi hover:text-primary transition-colors"
            >
              End workout
            </button>
          )}
        </div>
      </section>

      {resting && <RestTimer onDone={() => setResting(false)} />}

      {modal.kind === 'skip' && (
        <ReasonModal
          title={`Skip ${modal.name}?`}
          submitLabel="Skip exercise"
          onCancel={() => setModal({ kind: 'none' })}
          onSubmit={submitSkip}
          submitting={submitting}
        />
      )}
      {modal.kind === 'pain' && (
        <ReasonModal
          title={`Report pain on ${modal.name}`}
          subtitle="Your coach will be notified immediately."
          submitLabel="Send to coach"
          tone="danger"
          onCancel={() => setModal({ kind: 'none' })}
          onSubmit={submitPain}
          submitting={submitting}
        />
      )}
    </main>
  );
}

function isFormEmpty(
  isCardio: boolean,
  weight: string,
  reps: string,
  cardioMin: string
): boolean {
  if (isCardio) return !cardioMin;
  return !weight || !reps;
}

function summarizeSet(s: LoggedSet, isCardio: boolean): string {
  if (isCardio) {
    return `${s.cardioMinutes ?? '?'} min`;
  }
  const w = s.weight != null ? `${s.weight}${(s.unit ?? 'kg').toUpperCase()}` : '?';
  return `${w} × ${s.reps ?? '?'}`;
}

function StrengthFields({
  weight,
  setWeight,
  unit,
  setUnit,
  reps,
  setReps,
  rir,
  setRir,
}: {
  weight: string;
  setWeight: (v: string) => void;
  unit: 'kg' | 'lb';
  setUnit: (u: 'kg' | 'lb') => void;
  reps: string;
  setReps: (v: string) => void;
  rir: string;
  setRir: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-xs text-faint mb-1">Weight</label>
          <input
            type="text"
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="w-full h-12 px-3 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow"
          />
        </div>
        <div className="w-20">
          <label className="block text-xs text-faint mb-1">Unit</label>
          <div className="grid grid-cols-2 gap-1 h-12 p-1 rounded-xl bg-surface border border-border">
            {(['kg', 'lb'] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`text-sm font-medium rounded-lg transition-colors ${
                  unit === u
                    ? 'bg-primary/15 text-primary-hi ring-1 ring-primary/40'
                    : 'text-muted hover:text-text'
                }`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-xs text-faint mb-1">Reps</label>
          <input
            type="number"
            inputMode="numeric"
            value={reps}
            onChange={(e) => setReps(e.target.value)}
            className="w-full h-12 px-3 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-faint mb-1">RIR (optional)</label>
          <input
            type="number"
            inputMode="numeric"
            value={rir}
            onChange={(e) => setRir(e.target.value)}
            className="w-full h-12 px-3 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow"
          />
        </div>
      </div>
    </div>
  );
}

function CardioFields({
  cardioType,
  minutes,
  setMinutes,
}: {
  cardioType: 'treadmill' | 'elliptical' | 'stairmaster' | null;
  minutes: string;
  setMinutes: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-faint mb-1">
        Minutes {cardioType ? `(${cardioType})` : ''}
      </label>
      <input
        type="number"
        inputMode="numeric"
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        className="w-full h-12 px-3 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow"
      />
    </div>
  );
}

function VideoUpload({
  videoUrl,
  busy,
  progress,
  error,
  onPick,
  onClear,
}: {
  videoUrl: string | null;
  busy: boolean;
  progress: number;
  error: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  if (videoUrl) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-primary/30 bg-primary/8 px-3 py-2.5 text-sm">
        <span className="text-primary-hi font-medium">📹 Video attached</span>
        <button
          type="button"
          onClick={onClear}
          className="text-muted hover:text-text transition-colors"
        >
          Remove
        </button>
      </div>
    );
  }
  if (busy) {
    return (
      <div className="rounded-xl border border-primary/40 bg-primary/8 px-3 py-3 text-sm">
        <div className="flex items-center justify-between text-primary-hi mb-2">
          <span>Uploading video…</span>
          <span className="tabular-nums">{progress}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          Phone uploads can take up to a minute. Don&apos;t close the app.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong px-3 py-3 text-sm text-muted cursor-pointer transition-colors hover:border-primary/50 hover:text-text">
        <span>📹 Add video (optional, ≤ 25 MB)</span>
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
          }}
        />
      </label>
      {error && <p className="text-xs text-danger px-1">{error}</p>}
    </div>
  );
}

function ReasonModal({
  title,
  subtitle,
  submitLabel,
  tone = 'neutral',
  onCancel,
  onSubmit,
  submitting,
}: {
  title: string;
  subtitle?: string;
  submitLabel: string;
  tone?: 'neutral' | 'danger';
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <div className="fixed inset-0 z-50 bg-bg/85 backdrop-blur flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-sm bg-surface rounded-2xl border border-border p-5 space-y-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]">
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Reason"
          autoFocus
          rows={3}
          className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-sm transition-shadow placeholder:text-faint"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 h-11 rounded-xl border border-border text-sm font-medium text-text hover:bg-surface-2 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!text.trim() || submitting}
            onClick={() => onSubmit(text.trim())}
            className={`flex-1 h-11 rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors ${
              tone === 'danger'
                ? 'bg-danger hover:bg-danger/90 text-bg'
                : 'bg-primary hover:bg-primary-hi text-bg'
            }`}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
