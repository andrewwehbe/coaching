'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Bottom sheet on phones, centered dialog on larger screens — the shell
 * that PainModal/ReasonModal and the load-in confirm each re-implemented.
 * Also the sanctioned replacement for native alert()/confirm(), which
 * shatter the installed-PWA illusion.
 *
 * Behavior: safe-area aware, Escape and backdrop-tap dismiss (unless
 * dismissible={false} for genuinely blocking flows), aria-modal with the
 * title wired as the dialog's label.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  dismissible = true,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  dismissible?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && dismissible) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissible, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-bg/85 backdrop-blur flex items-end sm:items-center justify-center p-4"
      style={{ paddingBottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}
      onClick={dismissible ? onClose : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-surface rounded-[var(--r-card)] border border-border p-5 space-y-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
      >
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
