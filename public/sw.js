/* Coaching app service worker.
   Strategy:
   - Precache /offline so navigation always has a fallback when network fails.
   - Network-first for navigation HTML. /today, /workout, the coach pages etc.
     are all week/state-dependent — serving a stale-while-revalidate copy made
     clients see last week's "done" days on the first visit of a new week, so we
     always hit the network and only fall back to cache (then /offline) when the
     network is unreachable.
   - Cache-first for /icons + /_next/static — long-lived hashed assets.
   - Never cache API responses (would leak stale logs / sessions).
   - Logout posts {type:'clear-cache'} so a different user on the same device
     doesn't see the previous user's cached HTML.
*/

const VERSION = 'v8';
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

  // Navigation requests: network-first, fall back to a cached copy, then /offline.
  // Always prefer the network so week/state-dependent pages (/today, /workout,
  // coach pages) are never stale.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        try {
          const fresh = await fetch(req);
          // Keep a copy only as an offline fallback — don't serve it preemptively.
          if (fresh.ok && fresh.type === 'basic') {
            cache.put(req, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cached = await cache.match(req);
          if (cached) return cached;
          const offline = await cache.match(OFFLINE_URL);
          return (
            offline ?? new Response('Offline', { status: 503, statusText: 'offline' })
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
    // Coalesce *identical* notifications (same title+body) so a duplicate
    // delivery collapses onto the existing one instead of stacking. Distinct
    // alerts differ in title/body and so keep their own tag. renotify keeps the
    // alert audible/visible when a genuinely new one replaces an old same-tag.
    tag: `${title}\n${data.body ?? ''}`,
    renotify: true,
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

/* Page → SW messages.

   - flush-queue: replay queued writes. Actual replay happens in pages
     (they own auth cookie context); SW just broadcasts to all open tabs.
   - clear-cache: nuke the entire APP_CACHE. Posted on logout so the next
     user doesn't get the previous user's cached HTML.
   - invalidate-paths { paths: string[] }: targeted invalidation for
     specific URLs (e.g. /today after workout completion). Keeps the
     rest of the cache warm so navigations to other screens stay fast.
*/
self.addEventListener('message', (event) => {
  const data = event.data ?? {};
  if (data.type === 'flush-queue') {
    event.waitUntil(
      (async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of all) c.postMessage({ type: 'flush-queue' });
      })()
    );
  } else if (data.type === 'clear-cache') {
    event.waitUntil(caches.delete(APP_CACHE));
  } else if (data.type === 'invalidate-paths' && Array.isArray(data.paths)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        await Promise.all(
          data.paths
            .filter((p) => typeof p === 'string')
            .map((p) => {
              const url = new URL(p, self.location.origin).toString();
              return cache.delete(url);
            })
        );
      })()
    );
  }
});
