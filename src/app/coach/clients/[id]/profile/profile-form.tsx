'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type TrainingAge = 'novice' | 'intermediate' | 'advanced';
type PrimaryGoal = 'hypertrophy' | 'strength' | 'fat_loss' | 'general';
type Equipment = 'full_gym' | 'home_gym' | 'dumbbells_only' | 'bodyweight';

type Initial = {
  training_age: TrainingAge | null;
  primary_goal: PrimaryGoal | null;
  equipment: Equipment | null;
  exercise_blacklist: string[];
};

const TRAINING_AGE_OPTS: Array<{ value: TrainingAge; label: string; hint: string }> = [
  { value: 'novice', label: 'Novice', hint: '< ~1 yr lifting; progresses nearly every session' },
  {
    value: 'intermediate',
    label: 'Intermediate',
    hint: '~1–3 yr; progresses across a mesocycle',
  },
  { value: 'advanced', label: 'Advanced', hint: '3+ yr; progresses across a block' },
];

const GOAL_OPTS: Array<{ value: PrimaryGoal; label: string }> = [
  { value: 'hypertrophy', label: 'Hypertrophy' },
  { value: 'strength', label: 'Strength' },
  { value: 'fat_loss', label: 'Fat loss' },
  { value: 'general', label: 'General fitness' },
];

const EQUIPMENT_OPTS: Array<{ value: Equipment; label: string }> = [
  { value: 'full_gym', label: 'Full gym' },
  { value: 'home_gym', label: 'Home gym (rack + barbell + DBs)' },
  { value: 'dumbbells_only', label: 'Dumbbells only' },
  { value: 'bodyweight', label: 'Bodyweight only' },
];

export function ProfileForm({
  clientId,
  initial,
}: {
  clientId: string;
  initial: Initial;
}) {
  const router = useRouter();
  const [trainingAge, setTrainingAge] = useState<TrainingAge | ''>(
    initial.training_age ?? '',
  );
  const [goal, setGoal] = useState<PrimaryGoal | ''>(initial.primary_goal ?? '');
  const [equipment, setEquipment] = useState<Equipment | ''>(initial.equipment ?? '');
  const [blacklist, setBlacklist] = useState<string[]>(initial.exercise_blacklist);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function addBlacklisted() {
    const v = draft.trim();
    if (!v) return;
    const exists = blacklist.some((b) => b.toLowerCase() === v.toLowerCase());
    if (!exists) setBlacklist((prev) => [...prev, v]);
    setDraft('');
    setSaved(false);
  }

  function removeBlacklisted(name: string) {
    setBlacklist((prev) => prev.filter((b) => b !== name));
    setSaved(false);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/coach/clients/${clientId}/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          training_age: trainingAge || null,
          primary_goal: goal || null,
          equipment: equipment || null,
          exercise_blacklist: blacklist,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Failed to save');
        return;
      }
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-surface/40 p-4">
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint mb-3">
          Training age
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {TRAINING_AGE_OPTS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setTrainingAge(opt.value);
                setSaved(false);
              }}
              className={
                'text-left rounded-lg border px-3 py-2 transition-colors ' +
                (trainingAge === opt.value
                  ? 'border-primary bg-primary/15 text-primary-hi'
                  : 'border-border bg-surface/40 hover:border-primary/50 text-text')
              }
            >
              <span className="block text-sm font-medium">{opt.label}</span>
              <span className="block text-[11px] text-muted mt-0.5">{opt.hint}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setTrainingAge('');
            setSaved(false);
          }}
          className="mt-2 text-[10px] uppercase tracking-[0.18em] text-faint hover:text-text"
        >
          Clear
        </button>
      </section>

      <section className="rounded-2xl border border-border bg-surface/40 p-4">
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.18em] text-faint">
            Primary goal
          </span>
          <select
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value as PrimaryGoal | '');
              setSaved(false);
            }}
            className="mt-2 w-full sm:w-auto rounded-lg bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-primary/60"
          >
            <option value="">— Not set —</option>
            {GOAL_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="rounded-2xl border border-border bg-surface/40 p-4">
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.18em] text-faint">
            Equipment access
          </span>
          <select
            value={equipment}
            onChange={(e) => {
              setEquipment(e.target.value as Equipment | '');
              setSaved(false);
            }}
            className="mt-2 w-full sm:w-auto rounded-lg bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-primary/60"
          >
            <option value="">— Not set —</option>
            {EQUIPMENT_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="rounded-2xl border border-border bg-surface/40 p-4">
        <p className="text-[10px] uppercase tracking-[0.18em] text-faint">
          Exercise blacklist
        </p>
        <p className="text-xs text-muted mt-0.5 mb-3">
          Exercises this client must never be assigned (injuries, hated lifts).
          Recommender will skip these when proposing swaps.
        </p>
        <div className="flex items-center gap-2 mb-2">
          <input
            type="text"
            value={draft}
            placeholder="e.g. Overhead press"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addBlacklisted();
              }
            }}
            className="flex-1 rounded-lg bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-primary/60"
          />
          <button
            type="button"
            onClick={addBlacklisted}
            disabled={!draft.trim()}
            className="inline-flex items-center rounded-sm border border-border-strong hover:border-primary/50 bg-surface/40 hover:bg-surface text-muted hover:text-text px-3 py-2 text-[10px] uppercase tracking-[0.22em] font-medium transition-colors disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {blacklist.length === 0 ? (
          <p className="text-xs text-faint">No exercises blacklisted.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {blacklist.map((b) => (
              <li
                key={b}
                className="inline-flex items-center gap-1.5 rounded-sm border border-danger/30 bg-danger/10 text-danger px-2 py-1 text-xs"
              >
                <span>{b}</span>
                <button
                  type="button"
                  onClick={() => removeBlacklisted(b)}
                  className="text-danger/70 hover:text-danger"
                  aria-label={`Remove ${b}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-faint">
          Leave any field blank — the recommender uses sensible defaults
          (intermediate / hypertrophy / full gym / no blacklist) until set.
        </p>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-primary-hi">Saved</span>}
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-sm border border-primary bg-primary/15 hover:bg-primary/25 text-primary-hi px-4 py-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] font-medium transition-colors disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save profile'}
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
