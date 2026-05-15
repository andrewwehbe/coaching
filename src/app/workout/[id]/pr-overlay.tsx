'use client';

import { useEffect } from 'react';

const COLORS = ['#22c55e', '#16a34a', '#f59e0b', '#fafafa', '#84cc16', '#06b6d4'];
const PIECES = Array.from({ length: 60 }, (_, i) => ({
  left: (i * 17) % 100,
  delay: (i * 70) % 800,
  duration: 1600 + ((i * 31) % 1400),
  color: COLORS[i % COLORS.length],
  rotate: (i * 31) % 360,
  drift: ((i * 23) % 220) - 110,
}));

const AUTO_DISMISS_MS = 2800;

export function PrOverlay({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 backdrop-blur-sm cursor-pointer"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      onClick={onDismiss}
      role="alert"
      aria-live="assertive"
    >
      <style>{`
        @keyframes pr-confetti-fall {
          0%   { transform: translate3d(0, -10vh, 0) rotate(0deg); opacity: 1; }
          100% { transform: translate3d(var(--drift, 0px), 110vh, 0) rotate(720deg); opacity: 0.9; }
        }
        @keyframes pr-pop-in {
          0%   { transform: scale(0.85); opacity: 0; }
          60%  { transform: scale(1.05); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .pr-confetti {
          position: absolute;
          width: 8px;
          height: 12px;
          top: -10vh;
          will-change: transform, opacity;
          animation-name: pr-confetti-fall;
          animation-timing-function: cubic-bezier(.2,.6,.4,1);
          animation-fill-mode: forwards;
        }
        .pr-pop-in {
          animation: pr-pop-in 380ms cubic-bezier(.2,.7,.3,1.2) both;
        }
      `}</style>

      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
        {PIECES.map((p, i) => (
          <span
            key={i}
            className="pr-confetti"
            style={{
              left: `${p.left}%`,
              backgroundColor: p.color,
              animationDelay: `${p.delay}ms`,
              animationDuration: `${p.duration}ms`,
              transform: `rotate(${p.rotate}deg)`,
              ['--drift' as string]: `${p.drift}px`,
            }}
          />
        ))}
      </div>

      <div className="pr-pop-in relative text-center px-6 max-w-md">
        <p className="text-[11px] uppercase tracking-[0.32em] text-primary-hi font-medium">
          New PR
        </p>
        <p className="mt-4 font-display text-4xl sm:text-5xl text-text leading-[1.05]">
          {message}
        </p>
        <p className="mt-8 text-[10px] uppercase tracking-[0.22em] text-faint">
          Tap to dismiss
        </p>
      </div>
    </div>
  );
}
