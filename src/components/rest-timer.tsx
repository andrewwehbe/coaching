'use client';

import { useEffect, useRef, useState } from 'react';

const PRESETS = [120, 180, 240] as const;

export function RestTimer({
  onDone,
  defaultSeconds = 180,
}: {
  onDone: () => void;
  defaultSeconds?: number;
}) {
  const [seconds, setSeconds] = useState(defaultSeconds);
  const [remaining, setRemaining] = useState(defaultSeconds);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
    setRemaining(seconds);
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      const left = Math.max(0, seconds - elapsed);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(t);
        try {
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            navigator.vibrate?.([200, 100, 200]);
          }
        } catch {
          /* noop */
        }
      }
    }, 250);
    return () => clearInterval(t);
  }, [seconds]);

  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  const done = remaining === 0;
  const progress = seconds > 0 ? 1 - remaining / seconds : 1;

  return (
    <div
      className="fixed inset-0 z-50 bg-bg/95 backdrop-blur-md flex flex-col items-center justify-center px-6"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Soft radial glow behind timer */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(500px 500px at 50% 45%, rgba(34,197,94,0.12), transparent 70%)',
        }}
      />

      <p className="relative text-xs uppercase tracking-[0.22em] text-faint mb-4">Rest</p>

      <p
        className={`relative font-bold tabular-nums tracking-tight transition-colors ${
          done ? 'text-primary-hi animate-soft-pulse' : 'text-text'
        }`}
        style={{ fontSize: '7.5rem', lineHeight: 1 }}
      >
        {mm}:{ss.toString().padStart(2, '0')}
      </p>

      {/* Progress bar */}
      <div className="relative mt-6 h-1 w-56 rounded-full bg-surface-2 overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      <div className="relative mt-10 flex gap-2">
        {PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSeconds(s)}
            className={`h-11 px-5 rounded-xl text-sm font-medium border transition-all ${
              seconds === s
                ? 'bg-primary/15 border-primary/50 text-primary-hi ring-1 ring-primary/30'
                : 'border-border text-muted hover:border-border-strong hover:text-text'
            }`}
          >
            {s / 60} min
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onDone}
        className="relative mt-10 w-full max-w-xs h-14 rounded-2xl bg-primary hover:bg-primary-hi active:bg-primary-press text-bg text-base font-semibold transition-all shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)]"
      >
        {done ? 'Next set' : 'Start now'}
      </button>

      <button
        type="button"
        onClick={onDone}
        className="relative mt-3 text-sm text-muted hover:text-text underline underline-offset-4 transition-colors"
        title="Skip the in-app timer and use your phone's timer (so you can lock the screen)"
      >
        I&apos;ll time it myself
      </button>
    </div>
  );
}
