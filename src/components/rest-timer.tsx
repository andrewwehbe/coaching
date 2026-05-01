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

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950/95 backdrop-blur flex flex-col items-center justify-center px-6">
      <p className="text-xs uppercase tracking-wide text-neutral-500 mb-3">Rest</p>
      <p
        className={`font-bold tabular-nums ${
          remaining === 0 ? 'text-emerald-400' : 'text-neutral-100'
        }`}
        style={{ fontSize: '7rem', lineHeight: 1 }}
      >
        {mm}:{ss.toString().padStart(2, '0')}
      </p>

      <div className="mt-10 flex gap-2">
        {PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSeconds(s)}
            className={`h-11 px-5 rounded-lg text-sm font-medium border transition-colors ${
              seconds === s
                ? 'bg-neutral-800 border-neutral-600 text-neutral-100'
                : 'border-neutral-800 text-neutral-400 hover:border-neutral-700'
            }`}
          >
            {s / 60} min
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onDone}
        className="mt-10 w-full max-w-xs h-14 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-base font-semibold transition-colors"
      >
        {remaining === 0 ? 'Next set' : 'Start now'}
      </button>
    </div>
  );
}
