'use client';

/**
 * Minimal toast system — the sanctioned home for transient outcomes
 * ("Couldn't save — try again", "Queued, will sync") instead of native
 * alert(). No provider ceremony: call toast() from anywhere client-side;
 * <Toaster /> is mounted once in the root layout.
 */
import { useEffect, useState } from 'react';

export type ToastTone = 'neutral' | 'danger' | 'success';
type ToastItem = { id: number; message: string; tone: ToastTone };

type Listener = (t: ToastItem) => void;
let listener: Listener | null = null;
let nextId = 1;
const AUTO_DISMISS_MS = 4000;

export function toast(message: string, tone: ToastTone = 'neutral') {
  listener?.({ id: nextId++, message, tone });
}

const TONE: Record<ToastTone, string> = {
  neutral: 'border-border bg-surface text-text',
  danger: 'border-danger/40 bg-surface text-danger',
  success: 'border-primary/40 bg-surface text-primary-hi',
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    listener = (t) => {
      setItems((prev) => [...prev.slice(-2), t]);
      window.setTimeout(
        () => setItems((prev) => prev.filter((i) => i.id !== t.id)),
        AUTO_DISMISS_MS,
      );
    };
    return () => {
      listener = null;
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 pointer-events-none"
      style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.75rem))' }}
    >
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setItems((prev) => prev.filter((i) => i.id !== t.id))}
          className={`pointer-events-auto w-full max-w-sm rounded-[var(--r-control)] border px-4 py-3 text-sm text-left shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] ${TONE[t.tone]}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
