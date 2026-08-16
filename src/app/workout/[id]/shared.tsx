'use client';

/**
 * Shared plumbing for the two workout loggers (workout-session.tsx = one
 * set at a time, workout-session-all.tsx = whole-exercise grid). Before
 * this module the two components duplicated ~560 identical lines — types,
 * modals, submit flows, offline sync, chrome — and every logging-UI change
 * had to land twice. Each component now owns only its input UI.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

import { OfflineBanner } from '@/components/offline-banner';
import { Button, Sheet, TextareaField, toast } from '@/components/ui';
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

export type LogStatus = 'completed' | 'skipped' | 'pain' | null;

/** Fields both logger variants carry per exercise. */
export type ExerciseCore = {
  id: string;
  name: string;
  position: number;
  prescriptionRaw: string | null;
  prescribedSets: number | null;
  repMin: number | null;
  repMax: number | null;
  coachNote: string | null;
  selfNote: string | null;
  isCardio: boolean;
  cardioType: 'treadmill' | 'elliptical' | 'stairmaster' | null;
  logStatus: LogStatus;
  // True when the client reported pain but chose to keep going on this
  // exercise. logStatus stays null so they can still log sets; this just
  // drives a visible "pain reported" hint on the active card.
  painReportedAndContinuing?: boolean;
  sets: LoggedSet[];
};

export type ModalState =
  | { kind: 'none' }
  | { kind: 'skip'; exerciseId: string; name: string }
  | { kind: 'pain'; exerciseId: string; name: string }
  | { kind: 'end' };

/** Next incomplete exercise after fromIdx, wrapping; fromIdx if none left. */
export function advanceFrom<T extends { logStatus: LogStatus }>(
  updated: T[],
  fromIdx: number,
): number {
  for (let i = fromIdx + 1; i < updated.length; i++) {
    if (updated[i].logStatus == null) return i;
  }
  for (let i = 0; i < fromIdx; i++) {
    if (updated[i].logStatus == null) return i;
  }
  return fromIdx;
}

/** Parse a numeric field, tolerating comma decimal separators. */
export function num(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function summarizeSet(s: LoggedSet, isCardio: boolean): string {
  if (isCardio) {
    return `${s.cardioMinutes ?? '?'} min`;
  }
  const w = s.weight != null ? `${s.weight}${(s.unit ?? 'kg').toUpperCase()}` : '?';
  return `${w} × ${s.reps ?? '?'}`;
}

export function describeSet(s: LoggedSet, isCardio: boolean): string {
  if (isCardio) return s.cardioMinutes != null ? `${s.cardioMinutes} min` : '—';
  if (s.weight == null && s.reps == null) return '—';
  const w = s.weight != null ? `${s.weight}${(s.unit ?? '').toUpperCase()}` : '—';
  const r = s.reps != null ? `× ${s.reps}` : '';
  const rir = s.rir != null ? `  ·  RIR ${s.rir}` : '';
  return `${w} ${r}${rir}`.trim();
}

/**
 * Online/offline tracking + queued-write flushing. Flushes on mount and on
 * regaining connectivity; polls the pending count so the banner stays live.
 */
export function useOfflineSync(): { online: boolean; pending: number } {
  const router = useRouter();
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

  return { online, pending };
}

/**
 * The non-set lifecycle actions both variants share: skip, pain, complete,
 * cancel. Generic over the variant's exercise state shape.
 */
export function useWorkoutLifecycle<T extends ExerciseCore>({
  workoutId,
  completed,
  modal,
  setModal,
  setState,
  setCurrentIdx,
  onAdvanced,
}: {
  workoutId: string;
  completed: boolean;
  modal: ModalState;
  setModal: Dispatch<SetStateAction<ModalState>>;
  setState: Dispatch<SetStateAction<T[]>>;
  setCurrentIdx: Dispatch<SetStateAction<number>>;
  /** Called after skip / stop-for-pain advances (e.g. to reset the form). */
  onAdvanced?: () => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [doneNow, setDoneNow] = useState(completed);

  async function submitSkip(reason: string) {
    if (modal.kind !== 'skip') return;
    setSubmitting(true);
    try {
      const res = await enqueueAndSend(`/api/client/workout/${workoutId}/skip`, {
        exerciseId: modal.exerciseId,
        reason,
      });
      if (!res.ok && res.status !== 202) {
        toast("Couldn't skip — check your connection and try again.", 'danger');
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
      onAdvanced?.();
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
        toast("Couldn't send the pain report — try again.", 'danger');
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
      if (!proceed) onAdvanced?.();
    } finally {
      setSubmitting(false);
    }
  }

  async function completeWorkout() {
    setSubmitting(true);
    try {
      const res = await enqueueAndSend(`/api/client/workout/${workoutId}/done`, {});
      if (!res.ok && res.status !== 202) {
        toast("Couldn't finish the workout — try again.", 'danger');
        return;
      }
      setDoneNow(true);
      // Targeted invalidation: just /today (which shows day status) and
      // /trends (which shows the freshly-updated PRs / consistency).
      // The rest of the cache stays warm.
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

  // Confirmation lives in EndSessionSheet — this executes directly.
  async function cancelWorkout() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/client/workout/${workoutId}/cancel`, {
        method: 'POST',
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        toast(e.error ?? "Couldn't cancel the workout — try again.", 'danger');
        return;
      }
      router.push('/today');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return {
    submitting,
    setSubmitting,
    doneNow,
    setDoneNow,
    submitSkip,
    submitPain,
    completeWorkout,
    cancelWorkout,
  };
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

export function DoneScreen({
  completedCount,
  total,
  showFinish,
  submitting,
  onFinish,
}: {
  completedCount: number;
  total: number;
  showFinish: boolean;
  submitting: boolean;
  onFinish: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-6">
      <div className="h-20 w-20 rounded-full bg-primary/15 ring-1 ring-primary/40 flex items-center justify-center shadow-[0_0_60px_-10px_rgba(34,197,94,0.7)]">
        <svg className="h-10 w-10 text-primary-hi" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h1 className="text-3xl font-bold tracking-tight">Workout done.</h1>
      <p className="text-muted">
        {completedCount} of {total} exercises logged.
      </p>
      {showFinish && (
        <button
          onClick={onFinish}
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

export function NoExercisesScreen() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
      <h1 className="text-2xl font-semibold">No exercises today.</h1>
      <Link href="/today" className="text-primary-hi hover:text-primary transition-colors">
        Back to today
      </Link>
    </main>
  );
}

export function SessionChrome({
  dayLabel,
  completedCount,
  total,
  currentIdx,
  onPrev,
  onNext,
  online,
  pending,
}: {
  dayLabel: string;
  completedCount: number;
  total: number;
  currentIdx: number;
  onPrev: () => void;
  onNext: () => void;
  online: boolean;
  pending: number;
}) {
  return (
    <>
      <header className="flex items-center justify-between mb-3 text-sm">
        <Link href="/today" className="text-muted hover:text-text transition-colors">
          ← {dayLabel}
        </Link>
        <span className="font-medium text-faint tabular-nums">
          {completedCount} / {total}
        </span>
      </header>

      <nav className="flex items-center justify-between gap-2 mb-4">
        <button
          type="button"
          onClick={onPrev}
          disabled={currentIdx === 0}
          className="flex-1 h-10 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ← Prev
        </button>
        <span className="text-xs text-faint tabular-nums px-2">
          {currentIdx + 1} of {total}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={currentIdx >= total - 1}
          className="flex-1 h-10 rounded-xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </nav>

      <OfflineBanner online={online} pending={pending} />

      <div className="mb-6 h-1 w-full rounded-full bg-surface-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${total ? (completedCount / total) * 100 : 0}%` }}
        />
      </div>
    </>
  );
}

export function CoachNoteCard({ note }: { note: string | null }) {
  if (!note) return null;
  return (
    <div className="mb-5 rounded-2xl border border-accent/30 bg-accent/8 px-4 py-3 text-sm">
      <p className="text-xs uppercase tracking-wide text-accent mb-1 font-medium">From your coach</p>
      <p className="text-text">{note}</p>
    </div>
  );
}

export function DeloadCard({ className = 'mt-4' }: { className?: string }) {
  return (
    <div className={`${className} rounded-2xl border border-accent/40 bg-accent/8 px-4 py-3 text-sm`}>
      <p className="text-xs uppercase tracking-[0.18em] text-accent mb-1 font-medium">
        Deload week
      </p>
      <p className="text-text">
        Drop ~25% off your usual load. Keep the prescribed reps, but stop
        ~3 reps shy of failure on every set. Don&rsquo;t chase a PR today.
      </p>
    </div>
  );
}

export function ExerciseHeading({ ex }: { ex: ExerciseCore }) {
  return (
    <>
      <p className="text-xs uppercase tracking-[0.18em] text-faint mb-1.5">
        Exercise {ex.position}
        {ex.logStatus === 'completed' && (
          <span className="ml-2 text-primary-hi normal-case tracking-normal">· done</span>
        )}
        {ex.logStatus === 'skipped' && (
          <span className="ml-2 text-muted normal-case tracking-normal">· skipped</span>
        )}
        {ex.logStatus === 'pain' && (
          <span className="ml-2 text-warn normal-case tracking-normal">· pain reported</span>
        )}
        {ex.painReportedAndContinuing && ex.logStatus !== 'pain' && (
          <span className="ml-2 text-warn normal-case tracking-normal">· pain reported · go carefully</span>
        )}
      </p>
      <h1 className="text-3xl font-bold leading-tight tracking-tight mb-2">{ex.name}</h1>
      <p className="text-sm text-muted mb-5">{ex.prescriptionRaw ?? '—'}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared modals
// ---------------------------------------------------------------------------

export type ModalAction = {
  label: string;
  tone: 'primary' | 'danger';
  onClick: (reason: string) => void;
};

type PainType = 'joint' | 'tendon' | 'muscle';

const PAIN_TYPE_OPTS: Array<{ value: PainType; label: string; hint: string }> = [
  { value: 'joint', label: 'Joint', hint: 'sharp, in a joint' },
  { value: 'tendon', label: 'Tendon', hint: 'localized to a tendon' },
  { value: 'muscle', label: 'Muscle', hint: 'diffuse, in the muscle' },
];

export function PainModal({
  title,
  subtitle,
  onContinue,
  onSkip,
  onCancel,
  submitting,
}: {
  title: string;
  subtitle?: string;
  onContinue: (reason: string, painType: PainType | null) => void;
  onSkip: (reason: string, painType: PainType | null) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [text, setText] = useState('');
  const [painType, setPainType] = useState<PainType | null>(null);
  return (
    <Sheet title={title} subtitle={subtitle} onClose={onCancel}>
      <div>
        <p className="text-[10px] uppercase tracking-[0.22em] text-faint mb-2">
          Type
        </p>
        <div className="grid grid-cols-3 gap-2">
          {PAIN_TYPE_OPTS.map((o) => {
            const active = painType === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setPainType(active ? null : o.value)}
                aria-pressed={active}
                className={
                  'rounded-[var(--r-control)] border px-2 py-2 text-left transition-colors ' +
                  (active
                    ? 'border-primary bg-primary/15 text-primary-hi'
                    : 'border-border bg-bg hover:border-primary/40 text-text')
                }
              >
                <span className="block text-xs font-medium">{o.label}</span>
                <span className="block text-[10px] text-faint mt-0.5">{o.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <TextareaField
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What does it feel like?"
        autoFocus
        rows={3}
        inputClassName="bg-bg"
      />
      <div className="space-y-2">
        <Button
          variant="primary"
          className="w-full"
          disabled={!text.trim() || submitting}
          onClick={() => onContinue(text.trim(), painType)}
        >
          Continue with exercise
        </Button>
        <Button
          variant="danger"
          className="w-full"
          disabled={!text.trim() || submitting}
          onClick={() => onSkip(text.trim(), painType)}
        >
          Skip exercise
        </Button>
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}

export function ReasonModal({
  title,
  subtitle,
  actions,
  onCancel,
  submitting,
}: {
  title: string;
  subtitle?: string;
  actions: ModalAction[];
  onCancel: () => void;
  submitting: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <Sheet title={title} subtitle={subtitle} onClose={onCancel}>
      <TextareaField
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Reason"
        autoFocus
        rows={3}
        inputClassName="bg-bg"
      />
      <div className="space-y-2">
        {actions.map((a) => (
          <Button
            key={a.label}
            variant={a.tone === 'danger' ? 'danger' : 'primary'}
            className="w-full"
            disabled={!text.trim() || submitting}
            onClick={() => a.onClick(text.trim())}
          >
            {a.label}
          </Button>
        ))}
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * The single safe exit for a session. Replaces the old footer where
 * "Cancel workout" (destroys the session) sat 12px from "End workout"
 * (finishes early) as two tiny text buttons — and replaces the native
 * confirm() that guarded cancel. The sheet IS the confirmation.
 */
export function EndSessionSheet({
  canFinish,
  submitting,
  onFinish,
  onCancelWorkout,
  onClose,
}: {
  /** True once at least one set is logged — finishing needs data to save. */
  canFinish: boolean;
  submitting: boolean;
  onFinish: () => void;
  onCancelWorkout: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="End this session?"
      subtitle={
        canFinish
          ? 'Ending saves everything you logged. Cancelling deletes this session.'
          : 'Nothing is logged yet. Cancelling deletes this session.'
      }
      onClose={onClose}
    >
      <div className="space-y-2">
        {canFinish && (
          <Button
            variant="primary"
            className="w-full"
            disabled={submitting}
            onClick={onFinish}
          >
            End workout &amp; save
          </Button>
        )}
        <Button
          variant="dangerGhost"
          className="w-full"
          disabled={submitting}
          onClick={onCancelWorkout}
        >
          Cancel workout — nothing saved
        </Button>
        <Button variant="ghost" className="w-full" onClick={onClose}>
          Keep training
        </Button>
      </div>
    </Sheet>
  );
}

/** Session footer: one calm entry point to the end-session sheet. */
export function SessionFooter({
  onOpenEndSheet,
  trailing,
}: {
  onOpenEndSheet: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="pt-3 mt-3 border-t border-border flex items-center justify-between gap-3">
      <Button variant="textlink" onClick={onOpenEndSheet} className="text-faint">
        End or cancel session…
      </Button>
      {trailing}
    </div>
  );
}
