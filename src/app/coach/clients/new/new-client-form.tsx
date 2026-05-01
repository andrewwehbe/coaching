'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type BodyWeightFreq = 'none' | 'daily' | '3x' | 'weekly';

export function NewClientForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [weeklyDayTarget, setWeeklyDayTarget] = useState(4);
  const [bodyWeightFreq, setBodyWeightFreq] = useState<BodyWeightFreq>('none');
  const [photoCheckIn, setPhotoCheckIn] = useState(false);
  const [mealPlan, setMealPlan] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; pin: string; id: string } | null>(null);
  const [pinHidden, setPinHidden] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/coach/clients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          weekly_day_target: weeklyDayTarget,
          body_weight_freq: bodyWeightFreq,
          photo_check_in_enabled: photoCheckIn,
          meal_plan_enabled: mealPlan,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Failed to create client');
        return;
      }
      setCreated({ name: body.client.name, pin: body.pin, id: body.client.id });
    } catch {
      setError('Network error.');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-primary/40 bg-primary/8 p-6 text-center shadow-[0_0_60px_-20px_rgba(34,197,94,0.7)]">
          <p className="text-sm text-primary-hi mb-2">Send this PIN to {created.name}:</p>
          <p className="text-5xl font-bold tracking-[0.3em] tabular-nums my-4 text-text">
            {pinHidden ? '•••••' : created.pin}
          </p>
          <p className="text-xs text-muted">
            This is the only time the PIN will be shown. If you lose it, regenerate from the
            client&apos;s detail page.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setPinHidden((h) => !h)}
            className="flex-1 h-12 rounded-xl border border-border text-sm text-text hover:bg-surface-2 transition-colors"
          >
            {pinHidden ? 'Show' : 'Hide'} PIN
          </button>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(created.pin);
            }}
            className="flex-1 h-12 rounded-xl border border-border text-sm text-text hover:bg-surface-2 transition-colors"
          >
            Copy
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Link
            href={`/coach/clients/${created.id}`}
            className="h-12 flex items-center justify-center rounded-xl bg-primary hover:bg-primary-hi text-bg text-sm font-semibold transition-colors shadow-[0_8px_24px_-10px_rgba(34,197,94,0.6)]"
          >
            Open client
          </Link>
          <button
            type="button"
            onClick={() => {
              router.push('/coach');
              router.refresh();
            }}
            className="h-12 rounded-xl border border-border text-sm text-text hover:bg-surface-2 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Name">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Client name"
          className="w-full h-12 rounded-xl bg-surface border border-border px-3 focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 transition-shadow placeholder:text-faint"
        />
      </Field>

      <Field label="Weekly day target">
        <input
          type="number"
          min={1}
          max={7}
          value={weeklyDayTarget}
          onChange={(e) => setWeeklyDayTarget(Number(e.target.value))}
          className="w-full h-12 rounded-xl bg-surface border border-border px-3 tabular-nums focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 transition-shadow"
        />
      </Field>

      <Field label="Body weight tracking">
        <select
          value={bodyWeightFreq}
          onChange={(e) => setBodyWeightFreq(e.target.value as BodyWeightFreq)}
          className="w-full h-12 rounded-xl bg-surface border border-border px-3 focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 transition-shadow"
        >
          <option value="none">None</option>
          <option value="daily">Daily</option>
          <option value="3x">3x / week</option>
          <option value="weekly">Weekly</option>
        </select>
      </Field>

      <Toggle
        label="Photo check-ins"
        checked={photoCheckIn}
        onChange={setPhotoCheckIn}
      />
      <Toggle label="Meal plan" checked={mealPlan} onChange={setMealPlan} />

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="w-full h-14 rounded-2xl bg-primary hover:bg-primary-hi active:bg-primary-press text-bg font-semibold disabled:opacity-40 disabled:shadow-none transition-all shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
      >
        {submitting ? 'Creating…' : 'Create client'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-[0.18em] text-faint mb-1.5 block">
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between w-full rounded-xl border border-border bg-surface/60 hover:bg-surface px-4 py-3 transition-colors"
    >
      <span className="text-sm text-text">{label}</span>
      <span
        className={`w-10 h-6 rounded-full transition-colors relative ${
          checked ? 'bg-primary' : 'bg-border-strong'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-bg transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </span>
    </button>
  );
}
