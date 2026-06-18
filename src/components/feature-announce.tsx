'use client';

import { useEffect, useState } from 'react';

// Bump the suffix to re-announce a future feature; each key shows exactly once
// per device, then never again.
const SEEN_KEY = 'coaching:feature-note-to-self-seen';

export function FeatureAnnounce() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (localStorage.getItem(SEEN_KEY) === '1') return;
    } catch {
      return;
    }
    setShow(true);
  }, []);

  useEffect(() => {
    if (!show) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show]);

  function dismiss() {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* noop */
    }
    setShow(false);
  }

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 backdrop-blur-sm p-4"
      style={{
        paddingTop: 'max(1rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))',
      }}
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      aria-labelledby="feature-announce-title"
    >
      <style>{`
        @keyframes feature-pop-in {
          0%   { transform: scale(0.92) translateY(8px); opacity: 0; }
          60%  { transform: scale(1.01) translateY(0); opacity: 1; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        .feature-pop-in { animation: feature-pop-in 360ms cubic-bezier(.2,.7,.3,1.15) both; }
      `}</style>

      <div
        className="feature-pop-in w-full max-w-sm bg-surface rounded-3xl border border-border p-6 space-y-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <p className="text-[10px] uppercase tracking-[0.28em] text-primary-hi font-medium">
            New feature added
          </p>
          <h2
            id="feature-announce-title"
            className="mt-2 text-xl font-semibold leading-tight text-text"
          >
            Write a note to yourself
          </h2>
        </div>

        {/* Mock of the new in-workout control */}
        <div className="rounded-2xl border border-border bg-bg px-4 pt-3 pb-4" aria-hidden="true">
          <div className="h-1 rounded-full bg-surface-2 overflow-hidden">
            <div className="h-full w-3/4 rounded-full bg-primary" />
          </div>
          <p className="mt-4 text-center text-sm text-muted">+ Add a note to self</p>
          <div className="mt-4">
            <p className="text-[10px] uppercase tracking-[0.28em] text-faint">Exercise 8</p>
            <p className="mt-1 font-display text-2xl text-text leading-none">Hyperextension</p>
            <p className="mt-1 text-sm text-muted">1x5-8</p>
          </div>
        </div>

        <p className="text-sm text-muted">
          You can now tap <span className="text-text font-medium">&ldquo;Add a note to self&rdquo;</span> on
          any exercise to jot a quick reminder, a form cue, or how it felt. It stays with
          that exercise for next time.
        </p>

        <button
          type="button"
          onClick={dismiss}
          className="w-full h-11 rounded-xl bg-primary hover:bg-primary-hi text-bg text-sm font-semibold transition-colors"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
