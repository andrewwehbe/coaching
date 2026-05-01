'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import type { Cue } from '@/lib/cue';
import { CueDisplay } from './cue-display';
import { RestTimer } from '@/components/rest-timer';

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

  const currentIdx = useMemo(() => {
    return state.findIndex((e) => e.logStatus == null);
  }, [state]);
  const current = currentIdx >= 0 ? state[currentIdx] : null;
  const completedCount = state.filter((e) => e.logStatus != null).length;

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
        body.weight = weight ? Number(weight) : null;
        body.unit = unit;
        body.reps = reps ? Number(reps) : null;
        body.rir = rir ? Number(rir) : null;
      }
      if (notes) body.notes = notes;
      if (videoUrl) body.videoUrl = videoUrl;

      const res = await fetch(`/api/client/workout/${workoutId}/set`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? 'Failed to save set');
        return;
      }

      // Update local state.
      setState((prev) =>
        prev.map((e) =>
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
                logStatus: isLastPrescribed ? 'completed' : null,
              }
            : e
        )
      );

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
    setState((prev) =>
      prev.map((e) =>
        e.id === current.id ? { ...e, logStatus: 'completed' } : e
      )
    );
    resetForm();
  }

  async function submitSkip(reason: string) {
    if (modal.kind !== 'skip') return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/client/workout/${workoutId}/skip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exerciseId: modal.exerciseId, reason }),
      });
      if (!res.ok) {
        alert('Failed to skip');
        return;
      }
      setState((prev) =>
        prev.map((e) =>
          e.id === modal.exerciseId ? { ...e, logStatus: 'skipped' } : e
        )
      );
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
      const res = await fetch(`/api/client/workout/${workoutId}/pain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exerciseId: modal.exerciseId, reason }),
      });
      if (!res.ok) {
        alert('Failed to send pain report');
        return;
      }
      setState((prev) =>
        prev.map((e) =>
          e.id === modal.exerciseId ? { ...e, logStatus: 'pain' } : e
        )
      );
      setModal({ kind: 'none' });
      resetForm();
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadVideo(file: File) {
    setVideoBusy(true);
    setVideoError(null);
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
      const { uploadUrl, publicUrl } = await presign.json();
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'video/mp4' },
        body: file,
      });
      if (!put.ok) {
        setVideoError('Upload failed');
        return;
      }
      setVideoUrl(publicUrl);
    } finally {
      setVideoBusy(false);
    }
  }

  async function completeWorkout() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/client/workout/${workoutId}/done`, {
        method: 'POST',
      });
      if (!res.ok) {
        alert('Failed to complete workout');
        return;
      }
      setDoneNow(true);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (doneNow || (!current && completedCount > 0)) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-6">
        <h1 className="text-3xl font-bold">Workout done.</h1>
        <p className="text-neutral-400">
          {completedCount} of {state.length} exercises logged.
        </p>
        {!doneNow && (
          <button
            onClick={completeWorkout}
            disabled={submitting}
            className="h-14 px-8 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-50"
          >
            Finish & save
          </button>
        )}
        <Link href="/today" className="text-emerald-400 underline">
          Back to today
        </Link>
      </main>
    );
  }

  if (!current) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
        <h1 className="text-2xl font-semibold">No exercises today.</h1>
        <Link href="/today" className="text-emerald-400 underline">
          Back to today
        </Link>
      </main>
    );
  }

  const isFirstSetOverall = state.every((e) => e.sets.length === 0);

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="flex items-center justify-between mb-4 text-sm text-neutral-400">
        <Link href="/today" className="hover:text-neutral-200">
          ← {dayLabel}
        </Link>
        <span>
          {completedCount} / {state.length}
        </span>
      </header>

      {current.coachNote && (
        <div className="mb-4 rounded-xl border border-blue-700/40 bg-blue-950/30 px-4 py-3 text-sm text-blue-100">
          <p className="text-xs uppercase tracking-wide text-blue-300 mb-1">From your coach</p>
          <p>{current.coachNote}</p>
        </div>
      )}

      <p className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
        Exercise {current.position}
      </p>
      <h1 className="text-3xl font-bold leading-tight mb-2">{current.name}</h1>
      <p className="text-sm text-neutral-400 mb-5">{current.prescriptionRaw ?? '—'}</p>

      <CueDisplay cue={current.cue} />

      {isFirstSetOverall && (
        <div className="mt-5 rounded-xl border border-amber-700/40 bg-amber-950/30 p-4 text-sm text-amber-100">
          <strong className="text-amber-50">Warmup first.</strong> Do at least one
          warmup set with light weight and ensure form is perfect before logging
          working sets.
        </div>
      )}

      <section className="mt-6 space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            Set {setNumber}
            {current.prescribedSets ? (
              <span className="text-neutral-500 text-sm font-normal ml-1.5">
                of {current.prescribedSets}
              </span>
            ) : null}
          </h2>
          {current.sets.length > 0 && (
            <p className="text-xs text-neutral-500">
              Last:{' '}
              {summarizeSet(current.sets[current.sets.length - 1], current.isCardio)}
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
          className="w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 focus:outline-none focus:border-neutral-600 text-sm"
        />

        <VideoUpload
          videoUrl={videoUrl}
          busy={videoBusy}
          error={videoError}
          onPick={uploadVideo}
          onClear={() => setVideoUrl(null)}
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setModal({ kind: 'pain', exerciseId: current.id, name: current.name })}
            className="flex-1 h-11 rounded-lg border border-red-700/40 text-red-300 text-sm font-medium hover:bg-red-950/40"
          >
            Report pain
          </button>
          <button
            type="button"
            onClick={() => setModal({ kind: 'skip', exerciseId: current.id, name: current.name })}
            className="flex-1 h-11 rounded-lg border border-neutral-700 text-neutral-300 text-sm font-medium hover:bg-neutral-900"
          >
            Skip exercise
          </button>
        </div>

        <button
          type="button"
          onClick={submitSet}
          disabled={submitting || isFormEmpty(current.isCardio, weight, reps, cardioMin)}
          className="w-full h-14 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-base font-semibold disabled:opacity-50 transition-colors"
        >
          {isLastPrescribed ? 'Log final set' : `Log set ${setNumber}`}
        </button>

        {isLastPrescribed && (
          <button
            type="button"
            onClick={addExtraSet}
            className="w-full text-center text-sm text-neutral-400 hover:text-neutral-200"
          >
            Add an extra set
          </button>
        )}

        {current.sets.length > 0 && !isLastPrescribed && (
          <button
            type="button"
            onClick={moveToNextExercise}
            className="w-full text-center text-sm text-neutral-400 hover:text-neutral-200"
          >
            Done with this exercise
          </button>
        )}
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
          <label className="block text-xs text-neutral-500 mb-1">Weight</label>
          <input
            type="number"
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="w-full h-12 px-3 rounded-lg bg-neutral-900 border border-neutral-800 focus:outline-none focus:border-neutral-600 text-lg"
          />
        </div>
        <div className="w-20">
          <label className="block text-xs text-neutral-500 mb-1">Unit</label>
          <div className="grid grid-cols-2 gap-1 h-12">
            {(['kg', 'lb'] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`text-sm font-medium rounded-md ${
                  unit === u
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'border border-neutral-800 text-neutral-400'
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
          <label className="block text-xs text-neutral-500 mb-1">Reps</label>
          <input
            type="number"
            inputMode="numeric"
            value={reps}
            onChange={(e) => setReps(e.target.value)}
            className="w-full h-12 px-3 rounded-lg bg-neutral-900 border border-neutral-800 focus:outline-none focus:border-neutral-600 text-lg"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-neutral-500 mb-1">RIR (optional)</label>
          <input
            type="number"
            inputMode="numeric"
            value={rir}
            onChange={(e) => setRir(e.target.value)}
            className="w-full h-12 px-3 rounded-lg bg-neutral-900 border border-neutral-800 focus:outline-none focus:border-neutral-600 text-lg"
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
      <label className="block text-xs text-neutral-500 mb-1">
        Minutes {cardioType ? `(${cardioType})` : ''}
      </label>
      <input
        type="number"
        inputMode="numeric"
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        className="w-full h-12 px-3 rounded-lg bg-neutral-900 border border-neutral-800 focus:outline-none focus:border-neutral-600 text-lg"
      />
    </div>
  );
}

function VideoUpload({
  videoUrl,
  busy,
  error,
  onPick,
  onClear,
}: {
  videoUrl: string | null;
  busy: boolean;
  error: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  if (videoUrl) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm">
        <span className="text-neutral-300">📹 Video attached</span>
        <button
          type="button"
          onClick={onClear}
          className="text-neutral-500 hover:text-neutral-300"
        >
          Remove
        </button>
      </div>
    );
  }
  return (
    <label
      className={`flex items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-700 px-3 py-3 text-sm cursor-pointer ${
        busy ? 'opacity-50 pointer-events-none' : 'hover:border-neutral-500'
      }`}
    >
      <span>{busy ? 'Uploading…' : '📹 Add video (optional, ≤ 25 MB)'}</span>
      <input
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
        }}
      />
      {error && <p className="text-xs text-red-400 ml-2">{error}</p>}
    </label>
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
    <div className="fixed inset-0 z-50 bg-neutral-950/80 backdrop-blur flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-sm bg-neutral-900 rounded-2xl border border-neutral-800 p-5 space-y-4">
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle && <p className="text-sm text-neutral-400">{subtitle}</p>}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Reason"
          autoFocus
          rows={3}
          className="w-full px-3 py-2 rounded-lg bg-neutral-950 border border-neutral-800 focus:outline-none focus:border-neutral-600 text-sm"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 h-11 rounded-lg border border-neutral-700 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!text.trim() || submitting}
            onClick={() => onSubmit(text.trim())}
            className={`flex-1 h-11 rounded-lg text-sm font-medium text-white disabled:opacity-50 ${
              tone === 'danger'
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-emerald-600 hover:bg-emerald-500'
            }`}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
