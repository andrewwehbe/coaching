'use client';

import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'coaching:push-prompt-dismissed';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushPrompt() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (process.env.NODE_ENV !== 'production') return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    if (localStorage.getItem(DISMISSED_KEY) === '1') return;
    // Don't ambush the user — show after 4s.
    const t = window.setTimeout(() => setShow(true), 4000);
    return () => window.clearTimeout(t);
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        dismiss();
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapid) {
        dismiss();
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          userAgent: navigator.userAgent,
        }),
      });
      setShow(false);
    } catch {
      dismiss();
    } finally {
      setBusy(false);
    }
  }

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
    <div className="rounded-[var(--r-card)] border border-accent/30 bg-accent/8 px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text font-medium">Get notified</p>
        <p className="text-xs text-muted mt-0.5">Pain reports, missed workouts, and check-ins.</p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="text-xs text-muted hover:text-text transition-colors"
      >
        Not now
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={enable}
        className="text-xs font-semibold rounded-lg bg-primary hover:bg-primary-hi text-bg px-3 py-1.5 disabled:opacity-50 transition-colors"
      >
        Enable
      </button>
    </div>
  );
}
