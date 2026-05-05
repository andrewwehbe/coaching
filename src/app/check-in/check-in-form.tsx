'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const LABELS = ['front', 'side', 'back', 'extra'] as const;
type Label = (typeof LABELS)[number];

type PendingPhoto = {
  label: Label;
  storagePath: string;
  previewUrl: string;
};

export function CheckInForm({ defaultUnit }: { defaultUnit: 'kg' | 'lb' }) {
  const router = useRouter();
  const [weight, setWeight] = useState('');
  const [unit, setUnit] = useState<'kg' | 'lb'>(defaultUnit);
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function uploadPhoto(label: Label, file: File) {
    setBusy(label);
    setError(null);
    try {
      if (file.size > 10 * 1024 * 1024) {
        setError('Photos must be under 10 MB.');
        return;
      }
      const presign = await fetch('/api/client/check-in/photo-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          contentType: file.type || 'image/jpeg',
        }),
      });
      if (!presign.ok) {
        const e = await presign.json().catch(() => ({}));
        setError(e.error ?? 'Upload prep failed');
        return;
      }
      const { uploadUrl, path } = (await presign.json()) as {
        uploadUrl: string;
        token: string;
        path: string;
      };
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'image/jpeg' },
        body: file,
      });
      if (!put.ok) {
        setError('Photo upload failed');
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      setPhotos((prev) => {
        const without = prev.filter((p) => p.label !== label);
        return [...without, { label, storagePath: path, previewUrl }];
      });
    } finally {
      setBusy(null);
    }
  }

  function removePhoto(label: Label) {
    setPhotos((prev) => {
      const removed = prev.find((p) => p.label === label);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((p) => p.label !== label);
    });
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (weight) {
        // Normalize comma decimal separator (Arabic/European keyboards) to dot.
        body.bodyWeight = Number(weight.replace(',', '.'));
        body.bodyWeightUnit = unit;
      }
      if (notes) body.notes = notes;
      if (photos.length > 0) {
        body.photos = photos.map(({ label, storagePath }) => ({ label, storagePath }));
      }
      if (Object.keys(body).length === 0) {
        setError('Add a weight, photo, or note.');
        return;
      }
      const res = await fetch('/api/client/check-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error ?? 'Failed to save check-in');
        return;
      }
      setDone(true);
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-primary/40 bg-primary/8 p-5 text-center space-y-3 shadow-[0_0_50px_-20px_rgba(34,197,94,0.6)]">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/15 ring-1 ring-primary/40 flex items-center justify-center">
          <svg className="h-6 w-6 text-primary-hi" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-text font-medium">Check-in saved.</p>
        <button
          type="button"
          onClick={() => {
            setDone(false);
            setWeight('');
            setNotes('');
            setPhotos([]);
          }}
          className="text-sm text-primary-hi hover:text-primary transition-colors"
        >
          Add another
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-xs text-faint mb-1">Body weight</label>
          <input
            type="text"
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="—"
            className="w-full h-12 px-3 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow placeholder:text-faint"
          />
        </div>
        <div className="w-20">
          <label className="block text-xs text-faint mb-1">Unit</label>
          <div className="grid grid-cols-2 gap-1 h-12 p-1 rounded-xl bg-surface border border-border">
            {(['kg', 'lb'] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`text-sm font-medium rounded-lg transition-colors ${
                  unit === u
                    ? 'bg-primary/15 text-primary-hi ring-1 ring-primary/40'
                    : 'text-muted hover:text-text'
                }`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <label className="block text-xs text-faint mb-2">Photos (optional)</label>
        <div className="grid grid-cols-2 gap-2">
          {LABELS.map((label) => {
            const photo = photos.find((p) => p.label === label);
            const isBusy = busy === label;
            return (
              <div key={label}>
                {photo ? (
                  <div className="relative rounded-xl overflow-hidden border border-primary/40 aspect-square bg-surface">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.previewUrl}
                      alt={label}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <span className="absolute top-1.5 left-1.5 text-[10px] uppercase tracking-wide bg-bg/80 text-primary-hi px-1.5 py-0.5 rounded font-medium">
                      {label}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePhoto(label)}
                      className="absolute top-1.5 right-1.5 h-6 w-6 rounded-full bg-bg/80 text-text text-xs hover:bg-danger hover:text-bg transition-colors"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <label
                    className={`flex flex-col items-center justify-center aspect-square rounded-xl border border-dashed border-border-strong text-xs text-muted cursor-pointer transition-colors ${
                      isBusy ? 'opacity-50 pointer-events-none' : 'hover:border-primary/50 hover:text-text'
                    }`}
                  >
                    <span className="text-base mb-1">📷</span>
                    <span className="capitalize">{isBusy ? 'Uploading…' : label}</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadPhoto(label, f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={3}
        className="w-full px-3 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-sm transition-shadow placeholder:text-faint"
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={submitting || !!busy}
        className="w-full h-14 rounded-2xl bg-primary hover:bg-primary-hi active:bg-primary-press text-bg text-base font-semibold disabled:opacity-40 disabled:shadow-none transition-all shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
      >
        Save check-in
      </button>
    </div>
  );
}
