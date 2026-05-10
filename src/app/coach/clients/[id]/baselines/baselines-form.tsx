'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Row = {
  name_key: string;
  display_name: string;
  days: number[];
  existing: { weight: string; unit: 'kg' | 'lb'; reps: string };
};

type Field = { weight: string; unit: 'kg' | 'lb'; reps: string };

export function BaselinesForm({
  clientId,
  exercises,
  initialTrainingStart,
}: {
  clientId: string;
  exercises: Row[];
  initialTrainingStart: string;
}) {
  const router = useRouter();
  const [trainingStart, setTrainingStart] = useState(initialTrainingStart);
  const [fields, setFields] = useState<Record<string, Field>>(() => {
    const m: Record<string, Field> = {};
    for (const e of exercises) m[e.name_key] = { ...e.existing };
    return m;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  function set(name_key: string, patch: Partial<Field>) {
    setFields((prev) => ({ ...prev, [name_key]: { ...prev[name_key], ...patch } }));
    setSaved(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const bests = exercises
        .map((e) => {
          const f = fields[e.name_key];
          const w = Number(f.weight.replace(',', '.'));
          const r = Number(f.reps);
          if (!f.weight || !f.reps || Number.isNaN(w) || Number.isNaN(r) || w <= 0 || r <= 0) {
            return null;
          }
          return { name_key: e.name_key, weight: w, unit: f.unit, reps: r };
        })
        .filter((b): b is NonNullable<typeof b> => b != null);

      const res = await fetch(`/api/coach/clients/${clientId}/baselines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          training_start_at: trainingStart
            ? new Date(trainingStart + 'T00:00:00').toISOString()
            : null,
          bests,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Failed to save');
        return;
      }
      const body = await res.json();
      setSaved(body.written ?? 0);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-surface/40 p-4">
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.18em] text-faint">
            Training start date
          </span>
          <p className="text-xs text-muted mt-0.5 mb-2">
            When the client actually started this mesocycle. Leave blank to use
            the program upload date.
          </p>
          <input
            type="date"
            value={trainingStart}
            onChange={(e) => {
              setTrainingStart(e.target.value);
              setSaved(null);
            }}
            className="w-full sm:w-auto rounded-lg bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 transition-shadow"
          />
        </label>
      </section>

      {exercises.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No weighted exercises in this program.
        </p>
      ) : (
        <section className="rounded-2xl border border-border bg-surface/40 divide-y divide-border">
          {exercises.map((e) => {
            const f = fields[e.name_key];
            return (
              <div key={e.name_key} className="px-4 py-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-baseline">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{e.display_name}</p>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-faint">
                    Day {e.days.join(', ')}
                    {e.existing.weight && (
                      <>
                        <span className="mx-1.5 text-border-strong">·</span>
                        current best: {e.existing.weight}
                        {e.existing.unit.toUpperCase()} × {e.existing.reps}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 tabular-nums">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.5"
                    placeholder="weight"
                    value={f.weight}
                    onChange={(ev) => set(e.name_key, { weight: ev.target.value })}
                    className="w-20 rounded-lg bg-bg border border-border px-2 py-1.5 text-sm text-text text-right focus:outline-none focus:border-primary/60"
                  />
                  <select
                    value={f.unit}
                    onChange={(ev) =>
                      set(e.name_key, { unit: ev.target.value as 'kg' | 'lb' })
                    }
                    className="rounded-lg bg-bg border border-border px-1.5 py-1.5 text-sm text-text focus:outline-none focus:border-primary/60"
                  >
                    <option value="kg">kg</option>
                    <option value="lb">lb</option>
                  </select>
                  <span className="text-faint">×</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    step="1"
                    placeholder="reps"
                    value={f.reps}
                    onChange={(ev) => set(e.name_key, { reps: ev.target.value })}
                    className="w-16 rounded-lg bg-bg border border-border px-2 py-1.5 text-sm text-text text-right focus:outline-none focus:border-primary/60"
                  />
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-faint">
          Empty rows are skipped. Existing bests are overwritten by the new
          values you enter.
        </p>
        <div className="flex items-center gap-3">
          {saved != null && (
            <span className="text-xs text-primary-hi tabular-nums">
              {saved} saved
            </span>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-sm border border-primary bg-primary/15 hover:bg-primary/25 text-primary-hi px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium transition-colors disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save baselines'}
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
