'use client';

import { useState } from 'react';

import { SelfNoteCard } from './self-note-card';
import { Button } from '@/components/ui';
import { enqueueAndSend } from '@/lib/offline-queue';
import { toggleWeightSign } from '@/lib/weight';
import {
  advanceFrom,
  CoachNoteCard,
  DeloadCard,
  describeSet,
  DoneScreen,
  EndSessionSheet,
  ExerciseHeading,
  NoExercisesScreen,
  num,
  PainModal,
  ReasonModal,
  SessionChrome,
  SessionFooter,
  useOfflineSync,
  useWorkoutLifecycle,
  type LoggedSet,
  type ModalState,
  type ExerciseCore,
} from './shared';

export type { LoggedSet };

export type ExerciseStateAll = ExerciseCore & {
  priorSets: LoggedSet[];
};

type RowDraft = {
  weight: string;
  reps: string;
  rir: string;
  unit: 'kg' | 'lb';
  cardioMin: string;
  notes: string;
  dirty: boolean;
};

function emptyRow(unit: 'kg' | 'lb' = 'kg'): RowDraft {
  return { weight: '', reps: '', rir: '', unit, cardioMin: '', notes: '', dirty: false };
}

function setToRow(s: LoggedSet, fallbackUnit: 'kg' | 'lb' = 'kg'): RowDraft {
  return {
    weight: s.weight != null ? String(s.weight) : '',
    reps: s.reps != null ? String(s.reps) : '',
    rir: s.rir != null ? String(s.rir) : '',
    unit: s.unit === 'lb' || s.unit === 'kg' ? s.unit : fallbackUnit,
    cardioMin: s.cardioMinutes != null ? String(s.cardioMinutes) : '',
    notes: s.notes ?? '',
    dirty: false,
  };
}

function priorRow(s: LoggedSet): RowDraft {
  return {
    weight: s.weight != null ? String(s.weight) : '',
    reps: s.reps != null ? String(s.reps) : '',
    rir: s.rir != null ? String(s.rir) : '',
    unit: s.unit === 'lb' || s.unit === 'kg' ? s.unit : 'kg',
    cardioMin: s.cardioMinutes != null ? String(s.cardioMinutes) : '',
    notes: '',
    dirty: false,
  };
}

function buildInitialRows(ex: ExerciseStateAll): RowDraft[] {
  const target = Math.max(
    ex.prescribedSets ?? 0,
    ex.sets.length,
    ex.priorSets.length,
    1,
  );
  const out: RowDraft[] = [];
  const fallbackUnit: 'kg' | 'lb' =
    ex.sets.find((s) => s.unit === 'lb' || s.unit === 'kg')?.unit as 'kg' | 'lb' | undefined ??
    (ex.priorSets.find((s) => s.unit === 'lb' || s.unit === 'kg')?.unit as 'kg' | 'lb' | undefined) ??
    'kg';
  for (let i = 0; i < target; i++) {
    const setNumber = i + 1;
    const existing = ex.sets.find((s) => s.setNumber === setNumber);
    if (existing) {
      out.push(setToRow(existing, fallbackUnit));
      continue;
    }
    const prior = ex.priorSets.find((s) => s.setNumber === setNumber);
    if (prior) {
      // Pre-fill with last session's numbers so ClientE can tweak instead of re-typing.
      out.push(priorRow(prior));
      continue;
    }
    out.push(emptyRow(fallbackUnit));
  }
  return out;
}

function isRowEmpty(r: RowDraft, isCardio: boolean): boolean {
  if (isCardio) return r.cardioMin.trim() === '';
  return r.weight.trim() === '' && r.reps.trim() === '';
}

export function WorkoutSessionAll({
  workoutId,
  dayLabel,
  completed,
  isDeload,
  exercises,
}: {
  workoutId: string;
  dayLabel: string;
  completed: boolean;
  isDeload?: boolean;
  exercises: ExerciseStateAll[];
}) {
  const [state, setState] = useState(exercises);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { online, pending } = useOfflineSync();

  const [currentIdx, setCurrentIdx] = useState(() => {
    const i = exercises.findIndex((e) => e.logStatus == null);
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

  const [rowsByExerciseId, setRowsByExerciseId] = useState<Record<string, RowDraft[]>>(
    () => Object.fromEntries(exercises.map((e) => [e.id, buildInitialRows(e)])),
  );

  function updateRow(exerciseId: string, idx: number, patch: Partial<RowDraft>) {
    setRowsByExerciseId((prev) => {
      const rows = prev[exerciseId] ?? [];
      const next = rows.map((r, i) => (i === idx ? { ...r, ...patch, dirty: true } : r));
      return { ...prev, [exerciseId]: next };
    });
  }

  function addRow(exerciseId: string) {
    setRowsByExerciseId((prev) => {
      const rows = prev[exerciseId] ?? [];
      const lastUnit = rows.length > 0 ? rows[rows.length - 1].unit : 'kg';
      return { ...prev, [exerciseId]: [...rows, emptyRow(lastUnit)] };
    });
  }

  function removeRow(exerciseId: string, idx: number) {
    setRowsByExerciseId((prev) => {
      const rows = prev[exerciseId] ?? [];
      if (rows.length <= 1) return prev;
      return { ...prev, [exerciseId]: rows.filter((_, i) => i !== idx) };
    });
  }

  // Copy this row's working numbers down to every other row on the same
  // exercise. Notes stay per-row (typically per-set commentary). Lets ClientE
  // log 3x of the same weight/reps without typing it three times.
  function applyRowToAll(exerciseId: string, sourceIdx: number) {
    setRowsByExerciseId((prev) => {
      const rows = prev[exerciseId] ?? [];
      const src = rows[sourceIdx];
      if (!src) return prev;
      const next = rows.map((r, i) =>
        i === sourceIdx
          ? r
          : {
              ...r,
              weight: src.weight,
              reps: src.reps,
              rir: src.rir,
              unit: src.unit,
              cardioMin: src.cardioMin,
              dirty: true,
            },
      );
      return { ...prev, [exerciseId]: next };
    });
  }

  /**
   * Optimistic: mark the exercise complete and advance immediately; the
   * per-set writes (each a single log_set RPC server-side) settle in the
   * background. On any hard failure (4xx — offline/5xx auto-queue as 202)
   * the exercise rolls back, the view returns to it, and the drafts are
   * still in the rows, so nothing is lost.
   */
  function saveExercise() {
    if (!current) return;
    setErrorMsg(null);
    const rows = rowsByExerciseId[current.id] ?? [];
    // Only send rows that have content. A row with only RIR is skipped — strength
    // sets need a weight or reps to be meaningful.
    const toSubmit = rows
      .map((r, i) => ({ row: r, setNumber: i + 1 }))
      .filter(({ row }) => !isRowEmpty(row, current.isCardio));
    if (toSubmit.length === 0) {
      setErrorMsg('Enter at least one set before saving.');
      return;
    }

    const bodies = toSubmit.map(({ row, setNumber }) => {
      const body: Record<string, unknown> = {
        exerciseId: current.id,
        setNumber,
      };
      if (current.isCardio) {
        body.cardioMinutes = num(row.cardioMin);
      } else {
        body.weight = num(row.weight);
        body.unit = row.unit;
        body.reps = num(row.reps);
        body.rir = num(row.rir);
      }
      if (row.notes) body.notes = row.notes;
      return { body, setNumber };
    });

    const savedSets: LoggedSet[] = bodies.map(({ body, setNumber }) => ({
      setNumber,
      weight: (body.weight as number | null) ?? null,
      unit: (body.unit as 'kg' | 'lb' | undefined) ?? null,
      reps: (body.reps as number | null) ?? null,
      rir: (body.rir as number | null) ?? null,
      cardioMinutes: (body.cardioMinutes as number | null) ?? null,
      videoUrl: null,
      notes: (body.notes as string | null) ?? null,
    }));

    // Rollback snapshot.
    const prevExercise = current;
    const prevIdx = currentIdx;

    // ---- Optimistic apply ----
    setState((prev) => {
      const next = prev.map((e) =>
        e.id === current.id
          ? { ...e, sets: savedSets, logStatus: 'completed' as const }
          : e,
      );
      setCurrentIdx((idx) => advanceFrom(next, idx));
      return next;
    });

    // ---- Background settle ----
    void (async () => {
      const rollback = (message: string) => {
        setState((prev) =>
          prev.map((e) => (e.id === prevExercise.id ? prevExercise : e)),
        );
        setCurrentIdx(prevIdx);
        setErrorMsg(message);
      };
      try {
        const results = await Promise.all(
          bodies.map(({ body }) =>
            enqueueAndSend(`/api/client/workout/${workoutId}/set`, body),
          ),
        );
        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          if (!res.ok && res.status !== 202) {
            const err = await res.json().catch(() => ({}));
            rollback(
              (err.error ?? `Failed to save set ${bodies[i].setNumber}`) +
                ' — nothing was marked done. Your numbers are still below.',
            );
            return;
          }
        }
      } catch {
        rollback('Failed to save — nothing was marked done. Try again.');
      }
    })();
  }

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

  const rows = rowsByExerciseId[current.id] ?? [];

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

      {isDeload && <DeloadCard className="mb-4" />}

      {current.priorSets.length > 0 && (
        <section className="mb-4 rounded-2xl border border-border bg-surface/40 px-4 py-3">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint mb-2">Last session</p>
          <ul className="space-y-1 text-sm tabular-nums">
            {[...current.priorSets]
              .sort((a, b) => a.setNumber - b.setNumber)
              .map((s) => (
                <li key={s.setNumber} className="flex items-center justify-between">
                  <span className="text-faint">Set {s.setNumber}</span>
                  <span className="text-text font-medium">{describeSet(s, current.isCardio)}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint">This session</p>
        {rows.map((row, idx) => (
          <SetRow
            key={idx}
            setNumber={idx + 1}
            row={row}
            isCardio={current.isCardio}
            onChange={(patch) => updateRow(current.id, idx, patch)}
            onRemove={rows.length > 1 ? () => removeRow(current.id, idx) : null}
            onApplyToAll={
              rows.length > 1 && !isRowEmpty(row, current.isCardio)
                ? () => applyRowToAll(current.id, idx)
                : null
            }
          />
        ))}

        <button
          type="button"
          onClick={() => addRow(current.id)}
          className="w-full text-center text-xs uppercase tracking-[0.18em] text-muted hover:text-text transition-colors py-2"
        >
          + Add a set
        </button>

        {errorMsg && <p className="text-sm text-danger">{errorMsg}</p>}

        <div className="flex gap-2 pt-2">
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

        <Button variant="cta" onClick={saveExercise}>
          {current.logStatus === 'completed'
            ? 'Save changes & next'
            : 'Save sets & next'}
        </Button>

        <SessionFooter
          onOpenEndSheet={() => setModal({ kind: 'end' })}
          trailing={
            completedCount === state.length - 1 && current.logStatus == null ? (
              <span className="text-[10px] text-faint uppercase tracking-[0.18em]">
                Last one
              </span>
            ) : undefined
          }
        />
      </section>

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
          canFinish={state.some((e) => e.sets.length > 0)}
          submitting={submitting}
          onFinish={completeWorkout}
          onCancelWorkout={cancelWorkout}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
    </main>
  );
}

function SetRow({
  setNumber,
  row,
  isCardio,
  onChange,
  onRemove,
  onApplyToAll,
}: {
  setNumber: number;
  row: RowDraft;
  isCardio: boolean;
  onChange: (patch: Partial<RowDraft>) => void;
  onRemove: (() => void) | null;
  onApplyToAll: (() => void) | null;
}) {
  const rowControls = (
    <div className="flex items-center gap-3">
      {onApplyToAll && (
        <button
          type="button"
          onClick={onApplyToAll}
          className="text-[10px] uppercase tracking-[0.14em] text-primary-hi hover:text-primary transition-colors"
          title="Copy this set's numbers to every set"
        >
          Apply to all
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] text-faint hover:text-danger transition-colors"
        >
          Remove
        </button>
      )}
    </div>
  );
  if (isCardio) {
    return (
      <div className="rounded-2xl border border-border bg-surface/40 px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint">Set {setNumber}</p>
          {rowControls}
        </div>
        <label className="block">
          <span className="text-xs text-muted">Minutes</span>
          <input
            type="number"
            inputMode="numeric"
            value={row.cardioMin}
            onChange={(e) => onChange({ cardioMin: e.target.value })}
            className="mt-1 w-full px-3 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-base"
          />
        </label>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-surface/40 px-3 py-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint">Set {setNumber}</p>
        {rowControls}
      </div>
      <div className="grid grid-cols-12 gap-2 items-end">
        <label className="col-span-5">
          <span className="text-[10px] uppercase tracking-wider text-faint">Weight</span>
          <div className="mt-1 flex gap-1.5">
            <button
              type="button"
              onClick={() => onChange({ weight: toggleWeightSign(row.weight) })}
              aria-label="Toggle negative weight"
              title="Negative for counterweighted machines (e.g. pendulum)"
              className={`shrink-0 w-9 rounded-xl border text-lg leading-none transition-colors ${
                row.weight.trim().startsWith('-')
                  ? 'bg-primary/15 text-primary-hi border-primary/40'
                  : 'bg-surface text-muted border-border hover:text-text'
              }`}
            >
              ±
            </button>
            <input
              type="text"
              inputMode="decimal"
              value={row.weight}
              onChange={(e) => onChange({ weight: e.target.value })}
              className="w-full px-2 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-base tabular-nums"
            />
          </div>
        </label>
        <div className="col-span-2 flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-faint">Unit</span>
          <div className="mt-1 inline-flex rounded-xl border border-border bg-surface overflow-hidden">
            {(['kg', 'lb'] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => onChange({ unit: u })}
                className={`flex-1 px-1 py-2 text-xs font-medium ${
                  row.unit === u ? 'bg-primary/15 text-primary-hi' : 'text-muted'
                }`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
        <label className="col-span-2">
          <span className="text-[10px] uppercase tracking-wider text-faint">Reps</span>
          <input
            type="number"
            inputMode="numeric"
            value={row.reps}
            onChange={(e) => onChange({ reps: e.target.value })}
            className="mt-1 w-full px-2 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-base tabular-nums"
          />
        </label>
        <label className="col-span-3">
          <span className="text-[10px] uppercase tracking-wider text-faint">RIR</span>
          <input
            type="number"
            inputMode="numeric"
            value={row.rir}
            onChange={(e) => onChange({ rir: e.target.value })}
            className="mt-1 w-full px-2 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-base tabular-nums"
          />
        </label>
      </div>
    </div>
  );
}
