'use client';

import { useEffect, useState } from 'react';

type State =
  | 'unsupported' // browser/OS can't do push (e.g. iOS Safari outside installed PWA)
  | 'unknown' // not yet checked
  | 'off' // permission default or denied, or no subscription
  | 'pending' // user just clicked Enable
  | 'on'; // permission granted AND we have a SW subscription

async function syncSubscriptionToServer(sub: PushSubscription): Promise<boolean> {
  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        userAgent: navigator.userAgent,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIOSSafariNotInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  if (!isIOS) return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const standalone =
    nav.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return !standalone;
}

export function NotificationsToggle() {
  const [state, setState] = useState<State>('unknown');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void detect();
  }, []);

  async function detect() {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported');
      return;
    }
    if (isIOSSafariNotInstalled()) {
      setState('unsupported');
      return;
    }
    if (Notification.permission !== 'granted') {
      setState('off');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Self-heal: re-POST the existing subscription so the server row
        // exists even if a previous subscribe POST failed.
        await syncSubscriptionToServer(sub);
        setState('on');
      } else {
        setState('off');
      }
    } catch {
      setState('off');
    }
  }

  async function enable() {
    setError(null);
    setState('pending');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setError(perm === 'denied' ? 'Blocked. Enable in browser settings.' : 'Permission needed');
        setState('off');
        return;
      }
      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapid) {
        setError('Push not configured');
        setState('off');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapid),
        });
      }
      const ok = await syncSubscriptionToServer(sub);
      if (!ok) {
        setError('Subscribe failed');
        setState('off');
        return;
      }
      setState('on');
    } catch (err) {
      setError((err as Error).message ?? 'Failed');
      setState('off');
    }
  }

  if (state === 'unknown') return null;

  if (state === 'unsupported') {
    if (typeof window !== 'undefined' && isIOSSafariNotInstalled()) {
      return (
        <span
          className="text-xs text-faint cursor-help"
          title="On iPhone, install the app first: Share → Add to Home Screen, then open from the home screen."
        >
          🔔 Install to enable
        </span>
      );
    }
    return null;
  }

  if (state === 'on') {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-primary-hi" title="Notifications on">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          On
        </span>
        <button
          type="button"
          onClick={async () => {
            const res = await fetch('/api/push/test', { method: 'POST' });
            if (!res.ok) {
              const e = await res.json().catch(() => ({}));
              setError(e.error ?? 'Test failed');
            } else {
              setError(null);
            }
          }}
          className="text-xs text-muted hover:text-text underline transition-colors"
          title="Send a test notification to this device"
        >
          test
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={enable}
      disabled={state === 'pending'}
      className="inline-flex items-center gap-1.5 text-xs font-medium rounded-lg border border-primary/40 bg-primary/10 text-primary-hi hover:bg-primary/15 px-2.5 py-1 transition-colors disabled:opacity-50"
      title={error ?? 'Enable push notifications'}
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      {state === 'pending' ? 'Enabling…' : 'Enable notifications'}
    </button>
  );
}
