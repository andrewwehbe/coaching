'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

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

export type ExerciseStateAll = {
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
  logStatus: 'completed' | 'skipped' | 'pain' | null;
  painReportedAndContinuing?: boolean;
  sets: LoggedSet[];
  priorSets: LoggedSet[];
};

type ModalState =
  | { kind: 'none' }
  | { kind: 'skip'; exerciseId: string; name: string }
  | { kind: 'pain'; exerciseId: string; name: string };

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

function num(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
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
  const router = useRouter();
  const [state, setState] = useState(exercises);
  const [doneNow, setDoneNow] = useState(completed);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  const [currentIdx, setCurrentIdx] = useState(() => {
    const i = exercises.findIndex((e) => e.logStatus == null);
    return i >= 0 ? i : 0;
  });
  const current = state[currentIdx] ?? null;
  const completedCount = state.filter((e) => e.logStatus != null).length;
  const allDone = state.length > 0 && completedCount === state.length;

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

  function advanceFrom(updated: ExerciseStateAll[], fromIdx: number): number {
    for (let i = fromIdx + 1; i < updated.length; i++) {
      if (updated[i].logStatus == null) return i;
    }
    for (let i = 0; i < fromIdx; i++) {
      if (updated[i].logStatus == null) return i;
    }
    return fromIdx;
  }

  async function saveExercise() {
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
    setSubmitting(true);
    try {
      const savedSets: LoggedSet[] = [];
      for (const { row, setNumber } of toSubmit) {
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
        const res = await enqueueAndSend(`/api/client/workout/${workoutId}/set`, body);
        if (!res.ok && res.status !== 202) {
          const err = await res.json().catch(() => ({}));
          setErrorMsg(err.error ?? `Failed to save set ${setNumber}`);
          return;
        }
        savedSets.push({
          setNumber,
          weight: (body.weight as number | null) ?? null,
          unit: (body.unit as 'kg' | 'lb' | undefined) ?? null,
          reps: (body.reps as number | null) ?? null,
          rir: (body.rir as number | null) ?? null,
          cardioMinutes: (body.cardioMinutes as number | null) ?? null,
          videoUrl: null,
          notes: (body.notes as string | null) ?? null,
        });
      }

      setState((prev) => {
        const next = prev.map((e) =>
          e.id === current.id
            ? { ...e, sets: savedSets, logStatus: 'completed' as const }
            : e,
        );
        setCurrentIdx((idx) => advanceFrom(next, idx));
        return next;
      });
    } finally {
      setSubmitting(false);
    }
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
          e.id === modal.exerciseId ? { ...e, logStatus: 'skipped' as const } : e,
        );
        setCurrentIdx((idx) => advanceFrom(next, idx));
        return next;
      });
      setModal({ kind: 'none' });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPain(
    reason: string,
    painType: 'joint' | 'tendon' | 'muscle' | null,
    proceed: boolean,
  ) {
    if (modal.kind !== 'pain') return;
    setSubmitting(true);
    try {
      const res = await enqueueAndSend(`/api/client/workout/${workoutId}/pain`, {
        exerciseId: modal.exerciseId,
        reason,
        pain_type: painType,
        proceed,
      });
      if (!res.ok && res.status !== 202) {
        alert('Failed to send pain report');
        return;
      }
      setState((prev) => {
        const next = prev.map((e) =>
          e.id === modal.exerciseId
            ? proceed
              ? { ...e, painReportedAndContinuing: true }
              : { ...e, logStatus: 'pain' as const }
            : e,
        );
        if (!proceed) setCurrentIdx((idx) => advanceFrom(next, idx));
        return next;
      });
      setModal({ kind: 'none' });
    } finally {
      setSubmitting(false);
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
      try {
        navigator.serviceWorker?.controller?.postMessage({
          type: 'invalidate-paths',
          paths: ['/today', '/trends'],
        });
      } catch {}
      router.push(`/workout/${workoutId}/summary`);
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

  const rows = rowsByExerciseId[current.id] ?? [];

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
          onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
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
          onClick={() => setCurrentIdx((i) => Math.min(state.length - 1, i + 1))}
          disabled={currentIdx >= state.length - 1}
          className="flex-1 h-10 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </nav>

      <OfflineBanner online={online} pending={pending} />

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
        {current.painReportedAndContinuing && current.logStatus !== 'pain' && (
          <span className="ml-2 text-warn normal-case tracking-normal">· pain reported · go carefully</span>
        )}
      </p>
      <h1 className="text-3xl font-bold leading-tight tracking-tight mb-2">{current.name}</h1>
      <p className="text-sm text-muted mb-5">{current.prescriptionRaw ?? '—'}</p>

      {isDeload && (
        <div className="mb-4 rounded-2xl border border-accent/40 bg-accent/8 px-4 py-3 text-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-accent mb-1 font-medium">
            Deload week
          </p>
          <p className="text-text">
            Drop ~25% off your usual load. Keep the prescribed reps, but stop
            ~3 reps shy of failure on every set.
          </p>
        </div>
      )}

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
          onClick={saveExercise}
          disabled={submitting}
          className="w-full h-14 rounded-2xl bg-primary hover:bg-primary-hi active:bg-primary-press text-bg text-base font-semibold disabled:opacity-40 disabled:shadow-none transition-all shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
        >
          {submitting
            ? 'Saving…'
            : current.logStatus === 'completed'
              ? 'Save changes & next'
              : 'Save sets & next'}
        </button>

        <div className="pt-3 mt-3 border-t border-border flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={cancelWorkout}
            disabled={submitting}
            className="text-xs text-faint hover:text-warn transition-colors"
          >
            Cancel workout
          </button>
          {completedCount === state.length - 1 && current.logStatus == null && (
            <span className="text-[10px] text-faint uppercase tracking-[0.18em]">
              Last one
            </span>
          )}
        </div>
      </section>

      {modal.kind === 'skip' && (
        <SkipModal
          name={modal.name}
          onClose={() => setModal({ kind: 'none' })}
          onSubmit={submitSkip}
          submitting={submitting}
        />
      )}
      {modal.kind === 'pain' && (
        <PainModal
          name={modal.name}
          onClose={() => setModal({ kind: 'none' })}
          onSubmit={submitPain}
          submitting={submitting}
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
}: {
  setNumber: number;
  row: RowDraft;
  isCardio: boolean;
  onChange: (patch: Partial<RowDraft>) => void;
  onRemove: (() => void) | null;
}) {
  if (isCardio) {
    return (
      <div className="rounded-2xl border border-border bg-surface/40 px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-faint">Set {setNumber}</p>
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
      <div className="grid grid-cols-12 gap-2 items-end">
        <label className="col-span-5">
          <span className="text-[10px] uppercase tracking-wider text-faint">Weight</span>
          <input
            type="text"
            inputMode="decimal"
            value={row.weight}
            onChange={(e) => onChange({ weight: e.target.value })}
            className="mt-1 w-full px-2 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-base tabular-nums"
          />
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

function describeSet(s: LoggedSet, isCardio: boolean): string {
  if (isCardio) return s.cardioMinutes != null ? `${s.cardioMinutes} min` : '—';
  if (s.weight == null && s.reps == null) return '—';
  const w = s.weight != null ? `${s.weight}${(s.unit ?? '').toUpperCase()}` : '—';
  const r = s.reps != null ? `× ${s.reps}` : '';
  const rir = s.rir != null ? `  ·  RIR ${s.rir}` : '';
  return `${w} ${r}${rir}`.trim();
}

function SkipModal({
  name,
  onClose,
  onSubmit,
  submitting,
}: {
  name: string;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <div
      className="fixed inset-0 z-50 bg-bg/85 backdrop-blur flex items-end sm:items-center justify-center p-4"
      style={{ paddingBottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-surface rounded-2xl border border-border p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Skip {name}?</h3>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (e.g., equipment busy, short on time)"
          className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-border focus:outline-none focus:border-primary/60 text-base"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-11 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || !reason.trim()}
            onClick={() => onSubmit(reason.trim())}
            className="flex-1 h-11 rounded-xl bg-warn/20 border border-warn/40 text-warn font-medium disabled:opacity-50"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

function PainModal({
  name,
  onClose,
  onSubmit,
  submitting,
}: {
  name: string;
  onClose: () => void;
  onSubmit: (reason: string, painType: 'joint' | 'tendon' | 'muscle' | null, proceed: boolean) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState('');
  const [painType, setPainType] = useState<'joint' | 'tendon' | 'muscle' | null>(null);
  return (
    <div
      className="fixed inset-0 z-50 bg-bg/85 backdrop-blur flex items-end sm:items-center justify-center p-4"
      style={{ paddingBottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-surface rounded-2xl border border-border p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Pain on {name}?</h3>
        <div className="flex gap-2">
          {(['joint', 'tendon', 'muscle'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setPainType(t)}
              className={`flex-1 h-10 rounded-xl border text-xs uppercase tracking-[0.18em] ${
                painType === t
                  ? 'border-danger/60 bg-danger/10 text-danger'
                  : 'border-border text-muted'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Where / when did it hurt?"
          className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-border focus:outline-none focus:border-primary/60 text-base"
        />
        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            disabled={submitting || !reason.trim()}
            onClick={() => onSubmit(reason.trim(), painType, false)}
            className="h-11 rounded-xl bg-danger/15 border border-danger/40 text-danger text-sm font-medium disabled:opacity-50"
          >
            Stop this exercise
          </button>
          <button
            type="button"
            disabled={submitting || !reason.trim()}
            onClick={() => onSubmit(reason.trim(), painType, true)}
            className="h-11 rounded-xl border border-border text-text text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          >
            Keep going carefully
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 text-xs text-muted hover:text-text"
          >
            Never mind
          </button>
        </div>
      </div>
    </div>
  );
}
