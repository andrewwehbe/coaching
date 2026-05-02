'use client';

import { useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';

type ParseError = { row: number; message: string };

type PreviewExercise = {
  name: string;
  prescription_raw: string;
  prescribed_sets: number;
  rep_min: number | null;
  rep_max: number | null;
  rir_target: string | null;
  is_cardio: boolean;
};

type PreviewDay = {
  label: string;
  exercises: PreviewExercise[];
};

type PreviewResponse =
  | { ok: true; program: { days: PreviewDay[] }; filename: string }
  | { ok: false; errors: ParseError[] };

export function ProgramUploader({ clientId }: { clientId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleFile(f: File) {
    setError(null);
    setPreview(null);
    setFile(f);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch(`/api/coach/clients/${clientId}/program/preview`, {
        method: 'POST',
        body: fd,
      });
      const body = (await res.json().catch(() => null)) as PreviewResponse | null;
      if (!body) {
        setError('Unexpected server response.');
        return;
      }
      setPreview(body);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/coach/clients/${clientId}/program/commit`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Failed to commit program.');
        return;
      }
      router.push(`/coach/clients/${clientId}`);
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  }

  return (
    <div className="space-y-5">
      {!preview && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`rounded-xl border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
            dragActive
              ? 'border-emerald-500 bg-emerald-950/20'
              : 'border-neutral-700 bg-neutral-900/40 hover:border-neutral-500'
          }`}
        >
          <p className="text-sm font-medium">
            {file ? file.name : 'Tap to choose an .xlsx from your phone'}
          </p>
          <p className="text-xs text-neutral-500 mt-1">
            {busy ? 'Parsing…' : 'Last sheet in workbook is used.'}
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {preview && !preview.ok && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/30 p-4 space-y-2">
          <p className="text-sm font-medium text-red-200">
            {preview.errors.length} parse error
            {preview.errors.length === 1 ? '' : 's'}
          </p>
          <ul className="text-xs text-red-200/80 space-y-1">
            {preview.errors.map((e, i) => (
              <li key={i}>
                <span className="font-mono text-red-300">Row {e.row}:</span>{' '}
                {e.message}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={reset}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-neutral-700 hover:border-neutral-500"
          >
            Choose another file
          </button>
        </div>
      )}

      {preview && preview.ok && (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/20 p-4">
            <p className="text-sm font-medium text-emerald-200">
              Parsed {preview.program.days.length} day
              {preview.program.days.length === 1 ? '' : 's'} from{' '}
              <span className="font-mono">{preview.filename}</span>.
            </p>
          </div>

          <ol className="space-y-3">
            {preview.program.days.map((d, i) => (
              <li
                key={i}
                className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
              >
                <p className="text-xs uppercase tracking-wide text-neutral-500">
                  Day {i + 1}
                </p>
                <p className="font-medium">{d.label}</p>
                <ul className="mt-3 space-y-1 text-sm">
                  {d.exercises.map((ex, j) => (
                    <li
                      key={j}
                      className="flex justify-between gap-3 text-neutral-300"
                    >
                      <span>{ex.name}</span>
                      <span className="text-neutral-500 font-mono text-xs">
                        {ex.prescription_raw}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={commit}
              className="flex-1 px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-medium text-sm"
            >
              {busy ? 'Saving…' : 'Confirm and save'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              className="px-4 py-3 rounded-xl border border-neutral-700 hover:border-neutral-500 disabled:opacity-50 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
