'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Exercise = {
  id: string;
  name: string;
  prescription_raw: string | null;
  prescribed_sets: number | null;
  is_cardio: boolean;
};

type Day = {
  id: string;
  day_index: number;
  label: string;
  exercises: Exercise[];
};

type SetRow = {
  weight: string;
  unit: 'kg' | 'lb';
  reps: string;
  rir: string;
  cardio_minutes: string;
  notes: string;
};

type Entry = {
  status: 'completed' | 'skipped' | 'pain';
  skip_reason: string;
  pain_reason: string;
  client_note: string;
  sets: SetRow[];
};

function emptySet(): SetRow {
  return { weight: '', unit: 'kg', reps: '', rir: '', cardio_minutes: '', notes: '' };
}

function emptyEntry(prescribedSets: number | null): Entry {
  const n = Math.max(1, prescribedSets ?? 3);
  return {
    status: 'completed',
    skip_reason: '',
    pain_reason: '',
    client_note: '',
    sets: Array.from({ length: n }, emptySet),
  };
}

export function LogOnBehalfForm({ clientId, days }: { clientId: string; days: Day[] }) {
  const router = useRouter();
  const [dayId, setDayId] = useState(days[0].id);
  const day = days.find((d) => d.id === dayId)!;
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(day.exercises.map((e) => [e.id, emptyEntry(e.prescribed_sets)])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchDay(nextId: string) {
    const nextDay = days.find((d) => d.id === nextId);
    if (!nextDay) return;
    setDayId(nextId);
    setEntries(
      Object.fromEntries(nextDay.exercises.map((e) => [e.id, emptyEntry(e.prescribed_sets)])),
    );
  }

  function updateEntry(exerciseId: string, patch: Partial<Entry>) {
    setEntries((prev) => ({ ...prev, [exerciseId]: { ...prev[exerciseId], ...patch } }));
  }

  function updateSet(exerciseId: string, idx: number, patch: Partial<SetRow>) {
    setEntries((prev) => {
      const e = prev[exerciseId];
      const sets = e.sets.map((s, i) => (i === idx ? { ...s, ...patch } : s));
      return { ...prev, [exerciseId]: { ...e, sets } };
    });
  }

  function addSet(exerciseId: string) {
    setEntries((prev) => ({
      ...prev,
      [exerciseId]: { ...prev[exerciseId], sets: [...prev[exerciseId].sets, emptySet()] },
    }));
  }

  function removeSet(exerciseId: string, idx: number) {
    setEntries((prev) => {
      const e = prev[exerciseId];
      if (e.sets.length <= 1) return prev;
      return { ...prev, [exerciseId]: { ...e, sets: e.sets.filter((_, i) => i !== idx) } };
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        day_id: dayId,
        completed: true,
        exercises: day.exercises.map((ex) => {
          const entry = entries[ex.id];
          const sets =
            entry.status === 'completed'
              ? entry.sets
                  .map((s, i) => ({
                    set_number: i + 1,
                    weight: s.weight ? Number(s.weight) : null,
                    unit: s.weight ? s.unit : null,
                    reps: s.reps ? Number(s.reps) : null,
                    rir: s.rir ? Number(s.rir) : null,
                    cardio_minutes: s.cardio_minutes ? Number(s.cardio_minutes) : null,
                    notes: s.notes || null,
                  }))
                  .filter(
                    (s) =>
                      s.weight != null ||
                      s.reps != null ||
                      s.cardio_minutes != null ||
                      s.notes != null,
                  )
              : [];
          return {
            exercise_id: ex.id,
            status: entry.status,
            skip_reason: entry.skip_reason || null,
            pain_reason: entry.pain_reason || null,
            client_note: entry.client_note || null,
            sets,
          };
        }),
      };

      const res = await fetch(`/api/coach/clients/${clientId}/log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Failed to log');
        return;
      }
      router.push(`/coach/clients/${clientId}`);
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <label className="block">
        <span className="text-xs uppercase tracking-wide text-faint mb-1.5 block">Day</span>
        <select
          value={dayId}
          onChange={(e) => switchDay(e.target.value)}
          className="w-full h-12 rounded-xl bg-surface border border-border px-3 focus:outline-none focus:border-border-strong"
        >
          {days.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      {day.exercises.map((ex) => {
        const entry = entries[ex.id];
        return (
          <div
            key={ex.id}
            className="rounded-xl border border-border bg-surface/40 p-4 space-y-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium">{ex.name}</p>
              <p className="text-xs text-faint">{ex.prescription_raw ?? ''}</p>
            </div>

            <div className="flex gap-1.5 text-xs">
              {(['completed', 'skipped', 'pain'] as const).map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => updateEntry(ex.id, { status: s })}
                  className={`px-2 py-1 rounded-lg border ${
                    entry.status === s
                      ? s === 'pain'
                        ? 'border-red-700/50 bg-red-950/50 text-red-200'
                        : s === 'skipped'
                          ? 'border-amber-700/50 bg-amber-950/40 text-amber-200'
                          : 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200'
                      : 'border-border-strong text-muted'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            {entry.status === 'pain' && (
              <textarea
                value={entry.pain_reason}
                onChange={(e) => updateEntry(ex.id, { pain_reason: e.target.value })}
                placeholder="Pain notes…"
                rows={2}
                className="w-full text-sm rounded-lg bg-bg/70 border border-red-700/40 px-3 py-2 focus:outline-none focus:border-red-500 resize-none"
              />
            )}

            {entry.status === 'skipped' && (
              <input
                value={entry.skip_reason}
                onChange={(e) => updateEntry(ex.id, { skip_reason: e.target.value })}
                placeholder="Skip reason…"
                className="w-full text-sm h-10 rounded-lg bg-bg/70 border border-border px-3 focus:outline-none focus:border-border-strong"
              />
            )}

            {entry.status === 'completed' && (
              <div className="space-y-2">
                {entry.sets.map((s, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <span className="col-span-1 text-xs text-faint text-right">{i + 1}</span>
                    {ex.is_cardio ? (
                      <input
                        type="number"
                        inputMode="numeric"
                        value={s.cardio_minutes}
                        onChange={(e) =>
                          updateSet(ex.id, i, { cardio_minutes: e.target.value })
                        }
                        placeholder="min"
                        className="col-span-4 h-10 text-sm rounded-lg bg-bg/70 border border-border px-2 focus:outline-none focus:border-border-strong"
                      />
                    ) : (
                      <>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={s.weight}
                          onChange={(e) => updateSet(ex.id, i, { weight: e.target.value })}
                          placeholder="weight"
                          className="col-span-3 h-10 text-sm rounded-lg bg-bg/70 border border-border px-2 focus:outline-none focus:border-border-strong"
                        />
                        <select
                          value={s.unit}
                          onChange={(e) =>
                            updateSet(ex.id, i, { unit: e.target.value as 'kg' | 'lb' })
                          }
                          className="col-span-2 h-10 text-sm rounded-lg bg-bg/70 border border-border px-1 focus:outline-none focus:border-border-strong"
                        >
                          <option value="kg">kg</option>
                          <option value="lb">lb</option>
                        </select>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={s.reps}
                          onChange={(e) => updateSet(ex.id, i, { reps: e.target.value })}
                          placeholder="reps"
                          className="col-span-2 h-10 text-sm rounded-lg bg-bg/70 border border-border px-2 focus:outline-none focus:border-border-strong"
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          value={s.rir}
                          onChange={(e) => updateSet(ex.id, i, { rir: e.target.value })}
                          placeholder="RIR"
                          className="col-span-2 h-10 text-sm rounded-lg bg-bg/70 border border-border px-2 focus:outline-none focus:border-border-strong"
                        />
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => removeSet(ex.id, i)}
                      disabled={entry.sets.length <= 1}
                      className="col-span-2 text-xs text-faint hover:text-muted disabled:opacity-30"
                    >
                      remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addSet(ex.id)}
                  className="text-xs text-muted hover:text-text"
                >
                  + Add set
                </button>
              </div>
            )}

            <input
              value={entry.client_note}
              onChange={(e) => updateEntry(ex.id, { client_note: e.target.value })}
              placeholder="Note (optional)"
              className="w-full h-10 text-sm rounded-lg bg-bg/70 border border-border px-3 focus:outline-none focus:border-border-strong"
            />
          </div>
        );
      })}

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full h-12 rounded-xl bg-emerald-700/80 hover:bg-emerald-700 disabled:opacity-50 font-medium"
      >
        {submitting ? 'Saving…' : 'Save workout'}
      </button>
    </form>
  );
}
