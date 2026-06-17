'use client';

import { useState } from 'react';

/**
 * A client-authored "note to self" attached to the active exercise. Persists by
 * movement (name_key) on the server, so whatever the client writes here re-appears
 * the next time they train this exercise — in this program or a future one.
 */
export function SelfNoteCard({
  workoutId,
  exerciseId,
  note,
  onChange,
}: {
  workoutId: string;
  exerciseId: string;
  note: string | null;
  onChange: (note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = draft.trim();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/client/workout/${workoutId}/self-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exerciseId, note: trimmed || null }),
      });
      if (!res.ok) throw new Error('save failed');
      const data = (await res.json()) as { note: string | null };
      onChange(data.note);
      setDraft(data.note ?? '');
      setEditing(false);
    } catch {
      setError('Could not save — try again.');
    } finally {
      setSaving(false);
    }
  }

  function startEditing() {
    setDraft(note ?? '');
    setError(null);
    setEditing(true);
  }

  if (editing) {
    return (
      <div className="mb-5 rounded-2xl border border-primary/30 bg-primary/8 px-4 py-3 text-sm">
        <p className="text-xs uppercase tracking-wide text-primary-hi mb-2 font-medium">
          Note to self
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={2000}
          rows={3}
          autoFocus
          placeholder="e.g. seat at notch 4, lean back slightly, last set felt easy"
          className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-text placeholder:text-faint focus:border-primary focus:outline-none"
        />
        {error && <p className="mt-1 text-xs text-warn">{error}</p>}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hi disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
            className="rounded-full px-3 py-1.5 text-sm text-muted disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (note) {
    return (
      <div className="mb-5 rounded-2xl border border-primary/30 bg-primary/8 px-4 py-3 text-sm">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-primary-hi font-medium">
            Note to self
          </p>
          <button
            type="button"
            onClick={startEditing}
            className="text-xs text-muted hover:text-text"
          >
            Edit
          </button>
        </div>
        <p className="whitespace-pre-wrap text-text">{note}</p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      className="mb-5 text-sm text-muted hover:text-text"
    >
      + Add a note to self
    </button>
  );
}
