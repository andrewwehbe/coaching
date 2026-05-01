'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function BeginButton({
  dayId,
  dayLabel,
  warn,
  existingWorkoutId,
}: {
  dayId: string;
  dayLabel: string;
  warn: boolean;
  existingWorkoutId: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      if (existingWorkoutId) {
        router.push(`/workout/${existingWorkoutId}`);
        return;
      }
      const res = await fetch('/api/client/workout/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dayId }),
      });
      if (!res.ok) {
        setBusy(false);
        return;
      }
      const { workoutId } = await res.json();
      router.push(`/workout/${workoutId}`);
    } catch {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <div className="rounded-2xl border border-warn/35 bg-warn/10 p-4 space-y-3">
        <p className="text-sm text-warn">
          You&apos;ve trained the last 2 days. Start <strong className="font-semibold">{dayLabel}</strong> anyway?
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setConfirming(false)}
            className="flex-1 h-11 rounded-xl border border-border text-sm font-medium text-text hover:bg-surface-2 transition-colors"
          >
            Not now
          </button>
          <button
            onClick={go}
            disabled={busy}
            className="flex-1 h-11 rounded-xl bg-warn/90 hover:bg-warn text-bg text-sm font-semibold disabled:opacity-50 transition-colors"
          >
            Start anyway
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => (warn ? setConfirming(true) : go())}
      disabled={busy}
      className="w-full h-14 rounded-2xl bg-primary hover:bg-primary-hi active:bg-primary-press text-bg text-base font-semibold disabled:opacity-50 transition-all shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
    >
      {existingWorkoutId ? 'Resume workout' : `Begin ${dayLabel.split(' - ')[0] ?? 'workout'}`}
    </button>
  );
}
