/* IndexedDB-backed write queue for workout endpoints.
   Calls go through enqueueAndSend(): if the network is up we POST immediately
   and return the response; if it fails we persist the request and return a
   synthetic 202 so the UI can advance. A flush runs on online + on demand. */

const DB_NAME = 'coaching-offline';
const STORE = 'queue';
const DB_VERSION = 1;

export type QueuedRequest = {
  id?: number;
  url: string;
  body: unknown;
  /** Idempotency hint so repeated flushes don't double-write. */
  idempotencyKey: string;
  createdAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('no-idb'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    Promise.resolve(fn(store)).then((v) => {
      tx.oncomplete = () => resolve(v);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }, reject);
  });
}

async function add(req: QueuedRequest): Promise<number> {
  return withStore('readwrite', (store) => {
    return new Promise<number>((resolve, reject) => {
      const r = store.add(req);
      r.onsuccess = () => resolve(r.result as number);
      r.onerror = () => reject(r.error);
    });
  });
}

async function listAll(): Promise<QueuedRequest[]> {
  return withStore('readonly', (store) => {
    return new Promise<QueuedRequest[]>((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve((r.result ?? []) as QueuedRequest[]);
      r.onerror = () => reject(r.error);
    });
  });
}

async function remove(id: number): Promise<void> {
  return withStore('readwrite', (store) => {
    return new Promise<void>((resolve, reject) => {
      const r = store.delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  });
}

export async function pendingCount(): Promise<number> {
  try {
    const all = await listAll();
    return all.length;
  } catch {
    return 0;
  }
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError; // fetch throws TypeError on network failure
}

function makeKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** POST a JSON body. If offline / network fails, queue and return synthetic 202. */
export async function enqueueAndSend(
  url: string,
  body: unknown
): Promise<Response> {
  const idempotencyKey = makeKey();
  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

  if (isOnline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408)) {
        return res;
      }
      // Server transient error: queue and pretend-accept.
      await add({ url, body, idempotencyKey, createdAt: Date.now() });
      return new Response(JSON.stringify({ queued: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      // Fall through to queue.
    }
  }

  await add({ url, body, idempotencyKey, createdAt: Date.now() });
  return new Response(JSON.stringify({ queued: true }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });
}

/** Flush queued writes. Returns number successfully sent. */
export async function flushQueue(): Promise<number> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;
  let sent = 0;
  let items: QueuedRequest[];
  try {
    items = await listAll();
  } catch {
    return 0;
  }
  // Send in insertion order so set N is logged before set N+1.
  items.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const item of items) {
    try {
      const res = await fetch(item.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': item.idempotencyKey,
        },
        body: JSON.stringify(item.body),
      });
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        // 4xx is permanent — drop it so we don't retry forever.
        if (item.id != null) await remove(item.id);
        if (res.ok) sent++;
      }
      // 5xx / network transient: leave queued for next flush.
    } catch {
      // Network died mid-flush — bail; we'll retry next event.
      break;
    }
  }
  return sent;
}
