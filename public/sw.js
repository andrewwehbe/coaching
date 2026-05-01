/* Coaching app service worker.
   Strategy:
   - Precache /offline so navigation always has a fallback when network fails.
   - Network-first for navigation (HTML) — apps must reflect server state quickly.
   - Cache-first for /icons + /_next/static — long-lived hashed assets.
   - Never cache API responses (would leak stale logs / sessions).
*/

const VERSION = 'v1';
const APP_CACHE = `coaching-app-${VERSION}`;
const STATIC_CACHE = `coaching-static-${VERSION}`;
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
      } catch {
        /* offline page might not be reachable on first install — fine */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API or auth — always go to network.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests: network-first, fall back to /offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          return fresh;
        } catch {
          const cache = await caches.open(APP_CACHE);
          const cached = await cache.match(OFFLINE_URL);
          return (
            cached ??
            new Response('Offline', { status: 503, statusText: 'offline' })
          );
        }
      })()
    );
    return;
  }

  // Static assets: cache-first.
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      })()
    );
  }
});

/* Push notification handler. Payload shape: { title, body, url? }. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Coaching', body: event.data ? event.data.text() : '' };
  }
  const title = data.title ?? 'Coaching';
  const options = {
    body: data.body ?? '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url ?? '/' },
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })()
  );
});

/* Allow page to ping the SW to replay queued writes. The actual replay
   happens in the page (it owns the auth cookie context); the SW just
   broadcasts to all clients so any open tab can flush. */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'flush-queue') {
    event.waitUntil(
      (async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of all) c.postMessage({ type: 'flush-queue' });
      })()
    );
  }
});
