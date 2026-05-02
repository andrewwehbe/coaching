'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type DraftExercise = {
  id?: string; // present for existing rows; undefined for new
  name: string;
  prescription_raw: string;
  coach_note: string;
};

type DraftDay = {
  id?: string;
  label: string;
  exercises: DraftExercise[];
};

export function ProgramEditor({
  clientId,
  initial,
}: {
  clientId: string;
  initial: DraftDay[];
}) {
  const router = useRouter();
  const [days, setDays] = useState<DraftDay[]>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  function update(next: (prev: DraftDay[]) => DraftDay[]) {
    setDays((prev) => next(prev));
    setSavedAt(null);
  }

  function addDay() {
    update((prev) => [...prev, { label: `Day ${prev.length + 1}`, exercises: [] }]);
  }

  function renameDay(di: number, label: string) {
    update((prev) => prev.map((d, i) => (i === di ? { ...d, label } : d)));
  }

  function addExercise(di: number) {
    update((prev) =>
      prev.map((d, i) =>
        i === di
          ? { ...d, exercises: [...d.exercises, { name: '', prescription_raw: '3x5-8', coach_note: '' }] }
          : d
      )
    );
  }

  function updateEx(di: number, ei: number, patch: Partial<DraftExercise>) {
    update((prev) =>
      prev.map((d, i) =>
        i === di
          ? {
              ...d,
              exercises: d.exercises.map((e, j) => (j === ei ? { ...e, ...patch } : e)),
            }
          : d
      )
    );
  }

  function removeEx(di: number, ei: number) {
    update((prev) =>
      prev.map((d, i) =>
        i === di ? { ...d, exercises: d.exercises.filter((_, j) => j !== ei) } : d
      )
    );
  }

  function moveEx(di: number, ei: number, dir: -1 | 1) {
    update((prev) =>
      prev.map((d, i) => {
        if (i !== di) return d;
        const next = ei + dir;
        if (next < 0 || next >= d.exercises.length) return d;
        const arr = d.exercises.slice();
        const [item] = arr.splice(ei, 1);
        arr.splice(next, 0, item);
        return { ...d, exercises: arr };
      })
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Trim + validate locally before sending.
      const cleaned = days.map((d) => ({
        id: d.id,
        label: d.label.trim(),
        exercises: d.exercises.map((e) => ({
          id: e.id,
          name: e.name.trim(),
          prescription_raw: e.prescription_raw.trim(),
          coach_note: e.coach_note.trim() || null,
        })),
      }));
      for (const d of cleaned) {
        if (!d.label) {
          setError('Every day needs a name.');
          setSaving(false);
          return;
        }
        for (const e of d.exercises) {
          if (!e.name || !e.prescription_raw) {
            setError(`Exercise in "${d.label}" is missing a name or prescription.`);
            setSaving(false);
            return;
          }
        }
      }

      const res = await fetch(`/api/coach/clients/${clientId}/program/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: cleaned }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        days?: Array<{ id: string; exercises: Array<{ id: string }> }>;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? 'Save failed');
        return;
      }
      // Merge server-issued ids back into local state so a follow-up save
      // updates these rows instead of trying to insert them again — the latter
      // hits the (day_id, position) unique constraint with a 409.
      if (body.days) {
        setDays((prev) =>
          prev.map((d, di) => {
            const saved = body.days?.[di];
            if (!saved) return d;
            return {
              ...d,
              id: saved.id,
              exercises: d.exercises.map((e, ei) => {
                const sx = saved.exercises[ei];
                return sx ? { ...e, id: sx.id } : e;
              }),
            };
          })
        );
      }
      setSavedAt(Date.now());
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 pb-24">
      {days.map((day, di) => (
        <div key={day.id ?? `new-${di}`} className="rounded-2xl border border-border bg-surface/60">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
            <span className="text-xs uppercase tracking-[0.18em] text-faint">Day {di + 1}</span>
            <input
              value={day.label}
              onChange={(e) => renameDay(di, e.target.value)}
              className="flex-1 bg-transparent border-none focus:outline-none text-sm font-medium"
              placeholder="Day name"
            />
          </div>
          <ul className="divide-y divide-border">
            {day.exercises.map((ex, ei) => (
              <li key={ex.id ?? `new-${ei}`} className="px-4 py-3 space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-faint w-5 text-right tabular-nums">{ei + 1}.</span>
                  <input
                    value={ex.name}
                    onChange={(e) => updateEx(di, ei, { name: e.target.value })}
                    placeholder="Exercise name"
                    className="flex-1 bg-bg/40 rounded-lg border border-border px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/50"
                  />
                </div>
                <div className="flex gap-2 pl-7">
                  <input
                    value={ex.prescription_raw}
                    onChange={(e) => updateEx(di, ei, { prescription_raw: e.target.value })}
                    placeholder="3x5-8"
                    className="w-28 bg-bg/40 rounded-lg border border-border px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/50"
                  />
                  <input
                    value={ex.coach_note}
                    onChange={(e) => updateEx(di, ei, { coach_note: e.target.value })}
                    placeholder="Note (optional)"
                    className="flex-1 bg-bg/40 rounded-lg border border-border px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/50"
                  />
                </div>
                <div className="flex items-center justify-end gap-3 pl-7 text-xs">
                  <button
                    type="button"
                    onClick={() => moveEx(di, ei, -1)}
                    disabled={ei === 0}
                    className="text-faint hover:text-text disabled:opacity-30"
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveEx(di, ei, 1)}
                    disabled={ei === day.exercises.length - 1}
                    className="text-faint hover:text-text disabled:opacity-30"
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeEx(di, ei)}
                    className="text-warn hover:opacity-80"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="px-4 py-3 border-t border-border">
            <button
              type="button"
              onClick={() => addExercise(di)}
              className="text-sm text-primary-hi hover:text-primary"
            >
              + Add exercise
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addDay}
        className="w-full rounded-2xl border border-dashed border-border bg-surface/30 px-4 py-4 text-sm text-muted hover:text-text hover:border-primary/40"
      >
        + Add day
      </button>

      <div className="fixed bottom-0 left-0 right-0 px-4 py-3 bg-bg/95 backdrop-blur border-t border-border">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs">
            {error && <span className="text-warn">{error}</span>}
            {!error && savedAt && <span className="text-primary-hi">Saved</span>}
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-xl bg-primary hover:bg-primary-hi text-bg px-5 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save program'}
          </button>
        </div>
      </div>
    </div>
  );
}
