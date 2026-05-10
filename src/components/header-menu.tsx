'use client';

import { useEffect, useRef, useState } from 'react';

type SwitchKind = 'switch-to-coach' | 'switch-to-self' | null;

/**
 * Account dropdown shown in the /today and /coach headers. Self-contained:
 * it renders the trigger (3-dot icon), the popover, and all the menu rows.
 * Click outside / Escape close it. Each action handles its own loading
 * state so the menu can stay open until the action completes (relevant
 * for the switch + signout flows that hard-navigate at the end).
 */
export function HeaderMenu({
  switchKind,
  switchLabel,
}: {
  switchKind: SwitchKind;
  switchLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function doSwitch() {
    if (!switchKind) return;
    setBusy('switch');
    try {
      const url =
        switchKind === 'switch-to-coach'
          ? '/api/client/switch-to-coach'
          : '/api/coach/switch-to-self';
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error ?? 'Switch failed');
        return;
      }
      navigator.serviceWorker?.controller?.postMessage({ type: 'clear-cache' });
      window.location.href = switchKind === 'switch-to-coach' ? '/coach' : '/today';
    } finally {
      setBusy(null);
    }
  }

  async function doSignout() {
    setBusy('signout');
    await fetch('/api/auth/logout', { method: 'POST' });
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-cache' });
    window.location.href = '/login';
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong transition-colors"
      >
        <DotsIcon className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 min-w-[180px] rounded-xl border border-border bg-surface shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] py-1 z-50"
        >
          <NotificationsMenuRow />

          {switchKind && (
            <button
              role="menuitem"
              type="button"
              disabled={busy !== null}
              onClick={doSwitch}
              className="w-full text-left px-3 py-2 text-sm text-text hover:bg-surface-2 disabled:opacity-50 transition-colors"
            >
              {busy === 'switch' ? 'Switching…' : switchLabel}
            </button>
          )}

          <div className="my-1 h-px bg-border" />

          <button
            role="menuitem"
            type="button"
            disabled={busy !== null}
            onClick={doSignout}
            className="w-full text-left px-3 py-2 text-sm text-muted hover:text-danger hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {busy === 'signout' ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

// ---------- Notifications row ----------

type NotifState = 'unsupported' | 'unknown' | 'off' | 'pending' | 'on';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIOSSafariNotInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  if (!/iPhone|iPad|iPod/.test(ua)) return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const standalone =
    nav.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return !standalone;
}

async function syncSubToServer(sub: PushSubscription): Promise<boolean> {
  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function NotificationsMenuRow() {
  const [state, setState] = useState<NotifState>('unknown');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void detect();
  }, []);

  async function detect() {
    if (typeof window === 'undefined') return;
    if (
      !('Notification' in window) ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      isIOSSafariNotInstalled()
    ) {
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
        await syncSubToServer(sub);
        setState('on');
      } else setState('off');
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
      const ok = await syncSubToServer(sub);
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

  async function sendTest() {
    const res = await fetch('/api/push/test', { method: 'POST' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setError(e.error ?? 'Test failed');
    } else setError(null);
  }

  if (state === 'unknown') return null;

  if (state === 'unsupported') {
    if (typeof window !== 'undefined' && isIOSSafariNotInstalled()) {
      return (
        <div className="px-3 py-2 text-xs text-muted">
          To get notifications, install the app:{' '}
          <strong className="text-text">Share → Add to Home Screen</strong>.
        </div>
      );
    }
    return null;
  }

  if (state === 'on') {
    return (
      <button
        role="menuitem"
        type="button"
        onClick={sendTest}
        className="w-full text-left px-3 py-2 text-sm text-text hover:bg-surface-2 transition-colors flex items-center justify-between gap-3"
        title={error ?? 'Tap to send a test notification'}
      >
        <span>Notifications</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-primary-hi">on</span>
      </button>
    );
  }

  return (
    <button
      role="menuitem"
      type="button"
      onClick={enable}
      disabled={state === 'pending'}
      className="w-full text-left px-3 py-2 text-sm text-text hover:bg-surface-2 transition-colors disabled:opacity-50 flex items-center justify-between gap-3"
    >
      <span>Notifications</span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted">
        {state === 'pending' ? 'enabling…' : error ? error : 'enable'}
      </span>
    </button>
  );
}
