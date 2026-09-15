'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Badge, Button, toast, type BadgeTone } from '@/components/ui';
import type { ScheduledDay } from '@/lib/schedule';

const TONE: Record<ScheduledDay['status'], BadgeTone> = {
  done: 'done',
  in_progress: 'progress',
  upcoming: 'neutral',
  missed: 'warn',
};

const LABEL: Record<ScheduledDay['status'], string> = {
  done: 'Done this week',
  in_progress: 'In progress',
  upcoming: 'Up next',
  missed: 'Missed',
};

export function TrainPicker({
  clientId,
  days,
  suggestedDayId,
}: {
  clientId: string;
  days: ScheduledDay[];
  suggestedDayId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function open(day: ScheduledDay) {
    // Resume without a round trip when the schedule already knows the row.
    if (day.status === 'in_progress' && day.workoutId) {
      router.push(`/workout/${day.workoutId}`);
      return;
    }
    setBusy(day.dayId);
    try {
      const res = await fetch(`/api/coach/clients/${clientId}/workout/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dayId: day.dayId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.workoutId) {
        toast(body.error ?? "Couldn't start the session.", 'danger');
        return;
      }
      router.push(`/workout/${body.workoutId}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="flex flex-col gap-3">
      {days.map((day) => {
        const suggested = day.dayId === suggestedDayId;
        const verb =
          day.status === 'in_progress' ? 'Resume' : day.status === 'done' ? 'Log again' : 'Start';
        return (
          <li
            key={day.dayId}
            className={`rounded-[var(--r-card)] border px-4 py-4 ${
              suggested ? 'border-primary/60 bg-primary/5' : 'border-border bg-surface/40'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.22em] text-faint">
                  Day {day.dayIndex}
                </p>
                <p className="mt-1 font-medium leading-snug">{day.label}</p>
              </div>
              <Badge tone={TONE[day.status]}>{LABEL[day.status]}</Badge>
            </div>
            <Button
              variant={suggested ? 'primary' : 'ghost'}
              className="mt-4 w-full"
              disabled={busy != null}
              onClick={() => open(day)}
            >
              {busy === day.dayId ? 'Opening…' : verb}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
