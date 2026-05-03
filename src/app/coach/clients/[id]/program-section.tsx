'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

type Exercise = {
  id: string;
  position: number;
  name: string;
  prescription_raw: string | null;
  coach_note: string | null;
  archived_at: string | null;
};

type Day = {
  id: string;
  day_index: number;
  label: string;
  exercises: Exercise[];
};

export function ProgramSection({ days, hasProgram }: { days: Day[]; hasProgram: boolean }) {
  const params = useParams<{ id: string }>();
  if (!hasProgram) {
    return (
      <section className="mb-6">
        <h2 className="text-sm uppercase tracking-wide text-faint mb-2">Program</h2>
        <div className="rounded-xl border border-border bg-surface/40 px-4 py-4 text-sm">
          <p className="text-muted mb-3">No active program yet.</p>
          <Link
            href={`/coach/clients/${params.id}/program`}
            className="inline-block rounded-lg bg-primary hover:bg-primary-hi text-bg px-4 py-2 text-sm font-semibold transition-colors"
          >
            Upload .xlsx
          </Link>
        </div>
      </section>
    );
  }

  const sorted = days
    .slice()
    .sort((a, b) => a.day_index - b.day_index)
    .map((d) => ({
      ...d,
      exercises: d.exercises
        .filter((e) => e.archived_at == null)
        .sort((a, b) => a.position - b.position),
    }));

  return (
    <section className="mb-6">
      <h2 className="text-sm uppercase tracking-wide text-faint mb-2">Program</h2>
      <div className="space-y-3">
        {sorted.map((d) => (
          <DayBlock key={d.id} day={d} />
        ))}
      </div>
    </section>
  );
}

function DayBlock({ day }: { day: Day }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-2xl border border-border bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface transition-colors rounded-2xl"
      >
        <span className="font-medium text-text">{day.label}</span>
        <span className="text-xs text-faint">
          {day.exercises.length} ex · {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <ul className="border-t border-border divide-y divide-border">
          {day.exercises.map((e) => (
            <ExerciseRow key={e.id} exercise={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExerciseRow({ exercise }: { exercise: Exercise }) {
  const [note, setNote] = useState(exercise.coach_note ?? '');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if ((note.trim() || null) === (exercise.coach_note?.trim() || null)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/coach/exercises/${exercise.id}/note`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || null }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Failed');
        return;
      }
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="font-medium">
          <span className="text-faint mr-2">{exercise.position}.</span>
          {exercise.name}
        </p>
        <p className="text-xs text-faint shrink-0">{exercise.prescription_raw ?? ''}</p>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={save}
        placeholder="Coach note (shown to client during this exercise)…"
        rows={2}
        className="w-full text-sm rounded-lg bg-bg/70 border border-border px-3 py-2 focus:outline-none focus:border-border-strong resize-none text-text placeholder:text-faint"
      />
      <div className="flex items-center justify-end mt-1 h-4 text-[10px] text-faint">
        {saving && 'Saving…'}
        {!saving && savedAt && 'Saved'}
        {!saving && error && <span className="text-danger">{error}</span>}
      </div>
    </li>
  );
}
