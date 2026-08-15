'use client';

import { useRef, useState } from 'react';

import type { Cue } from '@/lib/cue';
import { CueDisplay } from './cue-display';
import { SelfNoteCard } from './self-note-card';
import { RestTimer } from '@/components/rest-timer';
import { enqueueAndSend } from '@/lib/offline-queue';
import { MAX_VIDEO_BYTES } from '@/lib/config';
import { toggleWeightSign } from '@/lib/weight';
import { PrOverlay } from './pr-overlay';
import {
  advanceFrom,
  CoachNoteCard,
  DeloadCard,
  DoneScreen,
  ExerciseHeading,
  NoExercisesScreen,
  PainModal,
  ReasonModal,
  SessionChrome,
  summarizeSet,
  useOfflineSync,
  useWorkoutLifecycle,
  type LoggedSet,
  type ModalState,
  type ExerciseCore,
} from './shared';

export type { LoggedSet };

export type ExerciseState = ExerciseCore & {
  cue: Cue;
};

export function WorkoutSession({
  workoutId,
  dayLabel,
  completed,
  isDeload,
  logMode,
  exercises,
}: {
  workoutId: string;
  dayLabel: string;
  completed: boolean;
  isDeload?: boolean;
  /**
   * 'sets' = log every set (default). 'best' = one entry per exercise,
   * treated as the session's best set; submitting marks the exercise
   * complete and advances. Set by clients.log_mode.
   */
  logMode?: 'sets' | 'best';
  exercises: ExerciseState[];
}) {
  const bestMode = logMode === 'best';

  const [state, setState] = useState(exercises);
  const [resting, setResting] = useState(false);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [prMessage, setPrMessage] = useState<string | null>(null);
  const { online, pending } = useOfflineSync();

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

  const {
    submitting,
    doneNow,
    submitSkip,
    submitPain,
    completeWorkout,
    cancelWorkout,
  } = useWorkoutLifecycle({
    workoutId,
    completed,
    modal,
    setModal,
    setState,
    setCurrentIdx,
    onAdvanced: resetForm,
  });

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

  // When non-null, the form is editing an existing set (by set_number) on
  // the current exercise instead of appending a new one. The submit
  // re-uses the upsert on (exercise_log_id, set_number) so the row is
  // replaced server-side.
  const [editingSetNumber, setEditingSetNumber] = useState<number | null>(null);

  // The submit is optimistic (no network wait), so the button never
  // disables long enough to absorb an accidental double-tap. Debounce here.
  const lastSubmitAtRef = useRef(0);

  function resetForm() {
    setWeight('');
    setReps('');
    setRir('');
    setNotes('');
    setCardioMin('');
    setVideoUrl(null);
    setVideoError(null);
    setEditingSetNumber(null);
  }

  function loadSetForEdit(s: LoggedSet) {
    setEditingSetNumber(s.setNumber);
    if (s.unit === 'lb' || s.unit === 'kg') setUnit(s.unit);
    setWeight(s.weight != null ? String(s.weight) : '');
    setReps(s.reps != null ? String(s.reps) : '');
    setRir(s.rir != null ? String(s.rir) : '');
    setNotes(s.notes ?? '');
    setCardioMin(s.cardioMinutes != null ? String(s.cardioMinutes) : '');
    setVideoUrl(s.videoUrl ?? null);
    setVideoError(null);
  }

  // In best mode the form always represents "the best set" — set_number is
  // pinned to 1 so a re-submit upserts the same row, and submitting always
  // counts as the final set so the exercise advances.
  const setNumber = bestMode
    ? 1
    : editingSetNumber ?? (current?.sets.length ?? 0) + 1;
  const isLastPrescribed = bestMode
    ? true
    : !editingSetNumber &&
      current?.prescribedSets != null &&
      setNumber >= current.prescribedSets;

  /**
   * Optimistic: the set list, rest timer, and advance all react instantly;
   * the network write (a single log_set RPC server-side) settles in the
   * background. On a hard failure (4xx — offline/5xx auto-queue as 202)
   * everything rolls back: the set list, the position, and the typed form
   * values, so nothing is silently lost.
   */
  function submitSet(opts?: { useLast?: boolean }) {
    if (!current) return;
    const now = Date.now();
    if (now - lastSubmitAtRef.current < 400) return;
    lastSubmitAtRef.current = now;

    const useLast = opts?.useLast === true;
    const lastSet = useLast && current.sets.length > 0
      ? current.sets[current.sets.length - 1]
      : null;
    if (useLast && (!lastSet || lastSet.weight == null || lastSet.reps == null)) return;
    // "Same as previous" always appends a new set, never edits.
    const effectiveSetNumber = useLast ? current.sets.length + 1 : setNumber;
    const effectiveIsLast = useLast
      ? current.prescribedSets != null && effectiveSetNumber >= current.prescribedSets
      : isLastPrescribed;

    const body: Record<string, unknown> = {
      exerciseId: current.id,
      setNumber: effectiveSetNumber,
    };
    if (current.isCardio) {
      body.cardioMinutes = cardioMin ? Number(cardioMin) : null;
    } else if (useLast && lastSet) {
      body.weight = lastSet.weight;
      body.unit = lastSet.unit ?? unit;
      body.reps = lastSet.reps;
      body.rir = null;
    } else {
      // Normalize comma decimal separator (Arabic/European keyboards) to dot
      // so Number() doesn't return NaN.
      body.weight = weight ? Number(weight.replace(',', '.')) : null;
      body.unit = unit;
      body.reps = reps ? Number(reps) : null;
      body.rir = rir ? Number(rir) : null;
    }
    if (!useLast && notes) body.notes = notes;
    // videoUrl actually holds the bucket-relative storage path; server expects videoPath.
    if (!useLast && videoUrl) body.videoPath = videoUrl;

    // Rollback snapshot — the exercise entry, position, and typed values.
    const prevExercise = current;
    const prevIdx = currentIdx;
    const formSnapshot = {
      weight, unit, reps, rir, notes, cardioMin, videoUrl, editingSetNumber,
    };
    const wasEditing = !useLast && editingSetNumber != null;

    // ---- Optimistic apply ----
    setState((prev) => {
      const next = prev.map((e) => {
        if (e.id !== current.id) return e;
        const newSet: LoggedSet = {
          setNumber: effectiveSetNumber,
          weight: body.weight as number | null,
          unit: (body.unit as 'kg' | 'lb' | undefined) ?? null,
          reps: body.reps as number | null,
          rir: body.rir as number | null,
          cardioMinutes: body.cardioMinutes as number | null,
          videoUrl: (body.videoPath as string | null) ?? null,
          notes: (body.notes as string | null) ?? null,
        };
        const exists = e.sets.some((s) => s.setNumber === effectiveSetNumber);
        const sets = exists
          ? e.sets.map((s) => (s.setNumber === effectiveSetNumber ? newSet : s))
          : [...e.sets, newSet];
        return {
          ...e,
          sets,
          logStatus: (effectiveIsLast
            ? 'completed'
            : e.logStatus) as ExerciseState['logStatus'],
        };
      });
      if (effectiveIsLast) setCurrentIdx((idx) => advanceFrom(next, idx));
      return next;
    });
    resetForm();
    // Rest starts immediately — an edit or a final set doesn't need one.
    setResting(!wasEditing && !effectiveIsLast);

    // ---- Background settle ----
    void (async () => {
      const rollback = (message: string) => {
        setState((prev) =>
          prev.map((e) => (e.id === prevExercise.id ? prevExercise : e)),
        );
        setCurrentIdx(prevIdx);
        setResting(false);
        setWeight(formSnapshot.weight);
        setUnit(formSnapshot.unit);
        setReps(formSnapshot.reps);
        setRir(formSnapshot.rir);
        setNotes(formSnapshot.notes);
        setCardioMin(formSnapshot.cardioMin);
        setVideoUrl(formSnapshot.videoUrl);
        setEditingSetNumber(formSnapshot.editingSetNumber);
        alert(message);
      };
      try {
        const res = await enqueueAndSend(`/api/client/workout/${workoutId}/set`, body);
        if (!res.ok && res.status !== 202) {
          const err = await res.json().catch(() => ({}));
          rollback(
            (err.error ?? 'Failed to save set') +
              ' — the set was not logged. Your numbers are back in the form.',
          );
          return;
        }
        // 202 = queued offline; PR data only comes from a real response.
        if (res.status !== 202) {
          const data = await res.json().catch(() => null);
          if (data?.pr?.message) setPrMessage(data.pr.message);
        }
      } catch {
        rollback('Failed to save set — the set was not logged. Try again.');
      }
    })();
  }

  function addExtraSet() {
    if (!current) return;
    // Just clear "isLastPrescribed" by allowing another submit cycle.
    // We do this by NOT marking the exercise complete and letting the user
    // submit another set above the prescribed count.
    // Resetting form is enough.
    resetForm();
  }

  function moveToNextExercise() {
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

  async function uploadVideo(file: File) {
    setVideoBusy(true);
    setVideoError(null);
    setVideoProgress(0);
    try {
      if (file.size > MAX_VIDEO_BYTES) {
        setVideoError(`Max ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB.`);
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

  const noSetsLogged = state.every((e) => e.sets.length === 0);

  if (doneNow || allDone) {
    return (
      <DoneScreen
        completedCount={completedCount}
        total={state.length}
        showFinish={!doneNow}
        submitting={submitting}
        onFinish={completeWorkout}
      />
    );
  }

  if (!current) {
    return <NoExercisesScreen />;
  }

  const isFirstSetOverall = state.every((e) => e.sets.length === 0);

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <SessionChrome
        dayLabel={dayLabel}
        completedCount={completedCount}
        total={state.length}
        currentIdx={currentIdx}
        onPrev={() => {
          setCurrentIdx((i) => Math.max(0, i - 1));
          resetForm();
        }}
        onNext={() => {
          setCurrentIdx((i) => Math.min(state.length - 1, i + 1));
          resetForm();
        }}
        online={online}
        pending={pending}
      />

      <CoachNoteCard note={current.coachNote} />

      <SelfNoteCard
        workoutId={workoutId}
        exerciseId={current.id}
        note={current.selfNote}
        onChange={(note) =>
          setState((prev) =>
            prev.map((e) => (e.id === current.id ? { ...e, selfNote: note } : e))
          )
        }
      />

      <ExerciseHeading ex={current} />

      <CueDisplay cue={current.cue} />

      {isDeload && <DeloadCard />}

      {isFirstSetOverall && (
        <div className="mt-5 rounded-2xl border border-warn/35 bg-warn/10 p-4 text-sm text-warn">
          <strong className="font-semibold">Warmup first.</strong> Do at least one
          warmup set with light weight and ensure form is perfect before logging
          working sets.
        </div>
      )}

      {current.sets.length > 0 && (
        <section className="mt-6 rounded-2xl border border-border bg-surface/40 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint mb-1.5 px-1">
            {bestMode ? 'Best set' : 'Logged'}
          </p>
          <ul className="space-y-1">
            {[...current.sets]
              .sort((a, b) => a.setNumber - b.setNumber)
              .map((s) => {
                const isEditingThis = editingSetNumber === s.setNumber;
                return (
                  <li key={s.setNumber}>
                    <button
                      type="button"
                      onClick={() =>
                        isEditingThis ? resetForm() : loadSetForEdit(s)
                      }
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors ${
                        isEditingThis
                          ? 'bg-primary/15 text-primary-hi'
                          : 'hover:bg-surface-2 text-text'
                      }`}
                    >
                      {!bestMode && (
                        <span className="text-faint tabular-nums text-xs">
                          {s.setNumber.toString().padStart(2, '0')}
                        </span>
                      )}
                      <span className="font-medium tabular-nums">
                        {summarizeSet(s, current.isCardio)}
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.18em] text-faint">
                        {isEditingThis ? 'editing' : 'edit'}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      <section className="mt-6 space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            {bestMode
              ? editingSetNumber != null
                ? 'Edit best set'
                : 'Best set'
              : (
                <>
                  {editingSetNumber != null ? 'Edit set ' : 'Set '}
                  {setNumber}
                  {current.prescribedSets && editingSetNumber == null ? (
                    <span className="text-faint text-sm font-normal ml-1.5">
                      of {current.prescribedSets}
                    </span>
                  ) : null}
                </>
              )}
          </h2>
          {editingSetNumber != null && (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-muted hover:text-text transition-colors"
            >
              Cancel edit
            </button>
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
          className="w-full px-3 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-base transition-shadow placeholder:text-faint"
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

        {(() => {
          if (bestMode || current.isCardio || editingSetNumber != null) return null;
          if (current.sets.length === 0) return null;
          const last = current.sets[current.sets.length - 1];
          if (last.weight == null || last.reps == null) return null;
          const unitLabel = last.unit ?? '';
          return (
            <button
              type="button"
              onClick={() => submitSet({ useLast: true })}
              className="w-full h-11 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors disabled:opacity-40"
            >
              Same as previous ({last.weight}
              {unitLabel} × {last.reps})
            </button>
          );
        })()}

        <button
          type="button"
          onClick={() => submitSet()}
          disabled={isFormEmpty(current.isCardio, weight, reps, cardioMin)}
          className="w-full h-14 rounded-2xl bg-primary hover:bg-primary-hi active:bg-primary-press text-bg text-base font-semibold disabled:opacity-40 disabled:shadow-none transition-all shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
        >
          {bestMode
            ? editingSetNumber != null
              ? 'Save best set'
              : 'Log best set'
            : editingSetNumber != null
              ? `Save set ${setNumber}`
              : isLastPrescribed
                ? 'Log final set'
                : `Log set ${setNumber}`}
        </button>

        {!bestMode && isLastPrescribed && (
          <button
            type="button"
            onClick={addExtraSet}
            className="w-full text-center text-sm text-muted hover:text-text transition-colors"
          >
            Add an extra set
          </button>
        )}

        {!bestMode && current.sets.length > 0 && !isLastPrescribed && (
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

      {/* After RestTimer in the DOM so a PR landing mid-rest celebrates on
          top of the timer, auto-dismisses, and the timer keeps running. */}
      <PrOverlay message={prMessage} onDismiss={() => setPrMessage(null)} />

      {modal.kind === 'skip' && (
        <ReasonModal
          title={`Skip ${modal.name}?`}
          onCancel={() => setModal({ kind: 'none' })}
          submitting={submitting}
          actions={[{ label: 'Skip exercise', tone: 'primary', onClick: submitSkip }]}
        />
      )}
      {modal.kind === 'pain' && (
        <PainModal
          title={`Report pain on ${modal.name}`}
          subtitle="Your coach will be notified either way."
          onCancel={() => setModal({ kind: 'none' })}
          submitting={submitting}
          onContinue={(r, t) => submitPain(r, t, true)}
          onSkip={(r, t) => submitPain(r, t, false)}
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
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setWeight(toggleWeightSign(weight))}
              aria-label="Toggle negative weight"
              title="Negative for counterweighted machines (e.g. pendulum)"
              className={`h-12 w-12 shrink-0 rounded-xl border text-xl leading-none transition-colors ${
                weight.trim().startsWith('-')
                  ? 'bg-primary/15 text-primary-hi border-primary/40'
                  : 'bg-surface text-muted border-border hover:text-text'
              }`}
            >
              ±
            </button>
            <input
              type="text"
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="w-full h-12 px-3 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow"
            />
          </div>
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
