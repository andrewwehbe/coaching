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
      <div className="rounded-xl border border-amber-700/50 bg-amber-950/40 p-4 space-y-3">
        <p className="text-sm text-amber-100">
          You&apos;ve trained the last 2 days. Start <strong>{dayLabel}</strong> anyway?
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setConfirming(false)}
            className="flex-1 h-11 rounded-lg border border-neutral-700 text-sm font-medium"
          >
            Not now
          </button>
          <button
            onClick={go}
            disabled={busy}
            className="flex-1 h-11 rounded-lg bg-amber-600 text-white text-sm font-medium disabled:opacity-50"
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
      className="w-full h-14 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-base font-semibold disabled:opacity-50 transition-colors"
    >
      {existingWorkoutId ? 'Resume workout' : `Begin ${dayLabel.split(' - ')[0] ?? 'workout'}`}
    </button>
  );
}
