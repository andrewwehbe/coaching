'use client';

import { useRef, useState, useId } from 'react';

import type { Cue } from '@/lib/cue';
import { CueDisplay } from './cue-display';
import { SelfNoteCard } from './self-note-card';
import { RestTimer } from '@/components/rest-timer';
import { Button, Field, TextareaField, toast } from '@/components/ui';
import { enqueueAndSend } from '@/lib/offline-queue';
import { MAX_VIDEO_BYTES } from '@/lib/config';
import { toggleWeightSign } from '@/lib/weight';
import { PrOverlay } from './pr-overlay';
import {
  advanceFrom,
  CoachNoteCard,
  DeloadCard,
  DoneScreen,
  EndSessionSheet,
  ExerciseHeading,
  NoExercisesScreen,
  PainModal,
  ReasonModal,
  SessionChrome,
  SessionFooter,
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

/**
 * Per-exercise form draft. Keyed by exercise id so flipping Prev/Next to
 * review another exercise no longer wipes a half-typed entry — the old
 * version kept ONE set of form states and reset them on every navigation.
 */
type Draft = {
  weight: string;
  unit: 'kg' | 'lb';
  reps: string;
  rir: string;
  notes: string;
  cardioMin: string;
  videoUrl: string | null;
  videoError: string | null;
  editingSetNumber: number | null;
};

function emptyDraft(unit: 'kg' | 'lb'): Draft {
  return {
    weight: '',
    unit,
    reps: '',
    rir: '',
    notes: '',
    cardioMin: '',
    videoUrl: null,
    videoError: null,
    editingSetNumber: null,
  };
}

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
  });

  // ---- Per-exercise drafts ----
  // The unit choice sticks across exercises (lb clients set it once).
  const lastUnitRef = useRef<'kg' | 'lb'>('kg');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draft: Draft = current
    ? drafts[current.id] ?? emptyDraft(lastUnitRef.current)
    : emptyDraft('kg');

  function patchDraft(exerciseId: string, patch: Partial<Draft>) {
    if (patch.unit) lastUnitRef.current = patch.unit;
    setDrafts((prev) => ({
      ...prev,
      [exerciseId]: {
        ...(prev[exerciseId] ?? emptyDraft(lastUnitRef.current)),
        ...patch,
      },
    }));
  }

  function clearDraft(exerciseId: string) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[exerciseId];
      return next;
    });
  }

  // Video upload transfer state is global (one upload at a time); the
  // resulting path lands in the owning exercise's draft.
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);

  // The submit is optimistic (no network wait), so the button never
  // disables long enough to absorb an accidental double-tap. Debounce here.
  const lastSubmitAtRef = useRef(0);

  function loadSetForEdit(s: LoggedSet) {
    if (!current) return;
    patchDraft(current.id, {
      editingSetNumber: s.setNumber,
      unit: s.unit === 'lb' || s.unit === 'kg' ? s.unit : draft.unit,
      weight: s.weight != null ? String(s.weight) : '',
      reps: s.reps != null ? String(s.reps) : '',
      rir: s.rir != null ? String(s.rir) : '',
      notes: s.notes ?? '',
      cardioMin: s.cardioMinutes != null ? String(s.cardioMinutes) : '',
      videoUrl: s.videoUrl ?? null,
      videoError: null,
    });
  }

  // In best mode the form always represents "the best set" — set_number is
  // pinned to 1 so a re-submit upserts the same row, and submitting always
  // counts as the final set so the exercise advances.
  const setNumber = bestMode
    ? 1
    : draft.editingSetNumber ?? (current?.sets.length ?? 0) + 1;
  const isLastPrescribed = bestMode
    ? true
    : !draft.editingSetNumber &&
      current?.prescribedSets != null &&
      setNumber >= current.prescribedSets;

  /**
   * Optimistic: the set list, rest timer, and advance all react instantly;
   * the network write (a single log_set RPC server-side) settles in the
   * background. On a hard failure (4xx — offline/5xx auto-queue as 202)
   * everything rolls back: the set list, the position, and the typed
   * draft, surfaced as a toast so nothing is silently lost.
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
      body.cardioMinutes = draft.cardioMin ? Number(draft.cardioMin) : null;
    } else if (useLast && lastSet) {
      body.weight = lastSet.weight;
      body.unit = lastSet.unit ?? draft.unit;
      body.reps = lastSet.reps;
      body.rir = null;
    } else {
      // Normalize comma decimal separator (Arabic/European keyboards) to dot
      // so Number() doesn't return NaN.
      body.weight = draft.weight ? Number(draft.weight.replace(',', '.')) : null;
      body.unit = draft.unit;
      body.reps = draft.reps ? Number(draft.reps) : null;
      body.rir = draft.rir ? Number(draft.rir) : null;
    }
    if (!useLast && draft.notes) body.notes = draft.notes;
    // videoUrl actually holds the bucket-relative storage path; server expects videoPath.
    if (!useLast && draft.videoUrl) body.videoPath = draft.videoUrl;

    // Rollback snapshot — the exercise entry, position, and typed draft.
    const prevExercise = current;
    const prevIdx = currentIdx;
    const draftSnapshot = draft;
    const wasEditing = !useLast && draft.editingSetNumber != null;

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
    clearDraft(current.id);
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
        setDrafts((prev) => ({ ...prev, [prevExercise.id]: draftSnapshot }));
        toast(message, 'danger');
      };
      try {
        const res = await enqueueAndSend(`/api/client/workout/${workoutId}/set`, body);
        if (!res.ok && res.status !== 202) {
          const err = await res.json().catch(() => ({}));
          rollback(
            (err.error ?? "Couldn't save the set") +
              ' — nothing was logged. Your numbers are back in the form.',
          );
          return;
        }
        // 202 = queued offline; PR data only comes from a real response.
        if (res.status !== 202) {
          const data = await res.json().catch(() => null);
          if (data?.pr?.message) setPrMessage(data.pr.message);
        }
      } catch {
        rollback("Couldn't save the set — nothing was logged. Try again.");
      }
    })();
  }

  function addExtraSet() {
    if (!current) return;
    // Just clear "isLastPrescribed" by allowing another submit cycle.
    // We do this by NOT marking the exercise complete and letting the user
    // submit another set above the prescribed count.
    clearDraft(current.id);
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
    clearDraft(current.id);
  }

  async function uploadVideo(file: File) {
    if (!current) return;
    const exerciseId = current.id;
    setVideoBusy(true);
    setVideoProgress(0);
    patchDraft(exerciseId, { videoError: null });
    try {
      if (file.size > MAX_VIDEO_BYTES) {
        patchDraft(exerciseId, {
          videoError: `Max ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB.`,
        });
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
        patchDraft(exerciseId, { videoError: e.error ?? 'Upload prep failed' });
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
        patchDraft(exerciseId, {
          videoError: 'Upload failed. Check signal and try again.',
        });
        return;
      }
      patchDraft(exerciseId, { videoUrl: path });
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
        onPrev={() => setCurrentIdx((i) => Math.max(0, i - 1))}
        onNext={() => setCurrentIdx((i) => Math.min(state.length - 1, i + 1))}
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
        <div className="mt-5 rounded-[var(--r-card)] border border-warn/35 bg-warn/10 p-4 text-sm text-warn">
          <strong className="font-semibold">Warmup first.</strong> Do at least one
          warmup set with light weight and ensure form is perfect before logging
          working sets.
        </div>
      )}

      {current.sets.length > 0 && (
        <section className="mt-6 rounded-[var(--r-card)] border border-border bg-surface/40 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint mb-1.5 px-1">
            {bestMode ? 'Best set' : 'Logged'}
          </p>
          <ul className="space-y-1">
            {[...current.sets]
              .sort((a, b) => a.setNumber - b.setNumber)
              .map((s) => {
                const isEditingThis = draft.editingSetNumber === s.setNumber;
                return (
                  <li key={s.setNumber}>
                    <button
                      type="button"
                      onClick={() =>
                        isEditingThis ? clearDraft(current.id) : loadSetForEdit(s)
                      }
                      className={`flex w-full items-center justify-between rounded-[var(--r-control)] px-3 py-2 text-sm transition-colors ${
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
              ? draft.editingSetNumber != null
                ? 'Edit best set'
                : 'Best set'
              : (
                <>
                  {draft.editingSetNumber != null ? 'Edit set ' : 'Set '}
                  {setNumber}
                  {current.prescribedSets && draft.editingSetNumber == null ? (
                    <span className="text-faint text-sm font-normal ml-1.5">
                      of {current.prescribedSets}
                    </span>
                  ) : null}
                </>
              )}
          </h2>
          {draft.editingSetNumber != null && (
            <Button variant="textlink" onClick={() => clearDraft(current.id)}>
              Cancel edit
            </Button>
          )}
        </div>

        {current.isCardio ? (
          <Field
            label={`Minutes ${current.cardioType ? `(${current.cardioType})` : ''}`}
            type="number"
            inputMode="numeric"
            value={draft.cardioMin}
            onChange={(e) => patchDraft(current.id, { cardioMin: e.target.value })}
          />
        ) : (
          <StrengthFields
            draft={draft}
            onPatch={(patch) => patchDraft(current.id, patch)}
          />
        )}

        <TextareaField
          value={draft.notes}
          onChange={(e) => patchDraft(current.id, { notes: e.target.value })}
          placeholder="Notes (optional)"
          rows={2}
        />

        <VideoUpload
          videoUrl={draft.videoUrl}
          busy={videoBusy}
          progress={videoProgress}
          error={draft.videoError}
          onPick={uploadVideo}
          onClear={() => patchDraft(current.id, { videoUrl: null })}
        />

        <div className="flex gap-2">
          <Button
            variant="dangerGhost"
            className="flex-1"
            onClick={() => setModal({ kind: 'pain', exerciseId: current.id, name: current.name })}
          >
            Report pain
          </Button>
          <Button
            variant="ghost"
            className="flex-1"
            onClick={() => setModal({ kind: 'skip', exerciseId: current.id, name: current.name })}
          >
            Skip exercise
          </Button>
        </div>

        {(() => {
          if (bestMode || current.isCardio || draft.editingSetNumber != null) return null;
          if (current.sets.length === 0) return null;
          const last = current.sets[current.sets.length - 1];
          if (last.weight == null || last.reps == null) return null;
          const unitLabel = last.unit ?? '';
          return (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => submitSet({ useLast: true })}
            >
              Same as previous ({last.weight}
              {unitLabel} × {last.reps})
            </Button>
          );
        })()}

        <Button
          variant="cta"
          onClick={() => submitSet()}
          disabled={isFormEmpty(current.isCardio, draft)}
        >
          {bestMode
            ? draft.editingSetNumber != null
              ? 'Save best set'
              : 'Log best set'
            : draft.editingSetNumber != null
              ? `Save set ${setNumber}`
              : isLastPrescribed
                ? 'Log final set'
                : `Log set ${setNumber}`}
        </Button>

        {!bestMode && isLastPrescribed && (
          <Button variant="textlink" className="w-full justify-center text-sm text-muted" onClick={addExtraSet}>
            Add an extra set
          </Button>
        )}

        {!bestMode && current.sets.length > 0 && !isLastPrescribed && (
          <Button
            variant="textlink"
            className="w-full justify-center text-sm text-muted"
            onClick={moveToNextExercise}
          >
            Done with this exercise
          </Button>
        )}

        <SessionFooter onOpenEndSheet={() => setModal({ kind: 'end' })} />
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
      {modal.kind === 'end' && (
        <EndSessionSheet
          canFinish={!noSetsLogged}
          submitting={submitting}
          onFinish={completeWorkout}
          onCancelWorkout={cancelWorkout}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
    </main>
  );
}

function isFormEmpty(isCardio: boolean, draft: Draft): boolean {
  if (isCardio) return !draft.cardioMin;
  return !draft.weight || !draft.reps;
}

function StrengthFields({
  draft,
  onPatch,
}: {
  draft: Draft;
  onPatch: (patch: Partial<Draft>) => void;
}) {
  const weightId = useId();
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor={weightId} className="block text-xs text-faint mb-1">
            Weight
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onPatch({ weight: toggleWeightSign(draft.weight) })}
              aria-label="Toggle negative weight"
              title="Negative for counterweighted machines (e.g. pendulum)"
              className={`h-12 w-12 shrink-0 rounded-[var(--r-control)] border text-xl leading-none transition-colors ${
                draft.weight.trim().startsWith('-')
                  ? 'bg-primary/15 text-primary-hi border-primary/40'
                  : 'bg-surface text-muted border-border hover:text-text'
              }`}
            >
              ±
            </button>
            <input
              id={weightId}
              type="text"
              inputMode="decimal"
              value={draft.weight}
              onChange={(e) => onPatch({ weight: e.target.value })}
              className="w-full h-12 px-3 rounded-[var(--r-control)] bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow"
            />
          </div>
        </div>
        <div className="w-20">
          <span className="block text-xs text-faint mb-1">Unit</span>
          <div className="grid grid-cols-2 gap-1 h-12 p-1 rounded-[var(--r-control)] bg-surface border border-border">
            {(['kg', 'lb'] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => onPatch({ unit: u })}
                aria-pressed={draft.unit === u}
                className={`text-sm font-medium rounded-lg transition-colors ${
                  draft.unit === u
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
        <Field
          label="Reps"
          className="flex-1"
          type="number"
          inputMode="numeric"
          value={draft.reps}
          onChange={(e) => onPatch({ reps: e.target.value })}
        />
        <Field
          label="RIR (optional)"
          className="flex-1"
          type="number"
          inputMode="numeric"
          value={draft.rir}
          onChange={(e) => onPatch({ rir: e.target.value })}
        />
      </div>
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
      <div className="flex items-center justify-between rounded-[var(--r-control)] border border-primary/30 bg-primary/8 px-3 py-2.5 text-sm">
        <span className="text-primary-hi font-medium">📹 Video attached</span>
        <Button variant="textlink" onClick={onClear}>
          Remove
        </Button>
      </div>
    );
  }
  if (busy) {
    return (
      <div className="rounded-[var(--r-control)] border border-primary/40 bg-primary/8 px-3 py-3 text-sm">
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
      <label className="flex items-center justify-center gap-2 rounded-[var(--r-control)] border border-dashed border-border-strong px-3 py-3 text-sm text-muted cursor-pointer transition-colors hover:border-primary/50 hover:text-text">
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
