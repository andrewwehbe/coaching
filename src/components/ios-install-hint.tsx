'use client';

import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'coaching:ios-install-dismissed';

function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  // iPadOS now reports as Mac; check touchpoints to differentiate.
  const iPadAsMac = /Mac/.test(ua) && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadAsMac;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS-specific property, plus standard display-mode query.
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

function isSafari(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

export function IosInstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isIOS() || isStandalone() || !isSafari()) return;
    try {
      if (localStorage.getItem(DISMISSED_KEY) === '1') return;
    } catch {
      return;
    }
    // Wait a beat so it doesn't compete with the push prompt.
    const t = window.setTimeout(() => setShow(true), 6000);
    return () => window.clearTimeout(t);
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* noop */
    }
    setShow(false);
  }

  if (!show) return null;

  return (
    <div
      className="fixed left-4 right-4 z-40 rounded-2xl border border-accent/30 bg-surface/95 backdrop-blur-md px-4 py-3 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)] flex items-start gap-3 max-w-md mx-auto"
      style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text">Install Coaching on your phone</p>
        <p className="text-xs text-muted mt-1">
          Tap <span className="text-accent">Share</span>{' '}
          <span className="inline-block align-middle">
            <svg className="inline h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4l4 4M4 20h16" />
            </svg>
          </span>{' '}
          then <span className="text-accent">Add to Home Screen</span>.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="text-muted hover:text-text transition-colors text-xs px-2 py-1 -mr-1"
        aria-label="Dismiss install hint"
      >
        ✕
      </button>
    </div>
  );
}
