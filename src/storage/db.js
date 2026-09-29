// Key/value persistence with graceful degradation:
//   IndexedDB  →  localStorage  →  in-memory (nothing persists)
// All adapters expose the same async API: get, set, delete, keys.

const DB_NAME = 'pixelgame';
const DB_VERSION = 1;
const STORE = 'kv';
const LS_PREFIX = 'pixelgame:';

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openIndexedDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

function indexedDbAdapter(db) {
  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  // Writes resolve only when the transaction commits, so a save that
  // "succeeded" is really on disk.
  const write = (fn) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    fn(t.objectStore(STORE));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
  });
  db.onversionchange = () => db.close();
  return {
    kind: 'indexeddb',
    get: (key) => promisify(tx('readonly').get(key)),
    set: (key, value) => write((s) => s.put(value, key)),
    delete: (key) => write((s) => s.delete(key)),
    keys: () => promisify(tx('readonly').getAllKeys()),
  };
}

function localStorageAdapter(ls) {
  return {
    kind: 'localstorage',
    async get(key) {
      const raw = ls.getItem(LS_PREFIX + key);
      return raw == null ? undefined : JSON.parse(raw);
    },
    async set(key, value) {
      ls.setItem(LS_PREFIX + key, JSON.stringify(value));
    },
    async delete(key) {
      ls.removeItem(LS_PREFIX + key);
    },
    async keys() {
      const out = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k?.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
      }
      return out;
    },
  };
}

export function memoryAdapter() {
  const map = new Map();
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    kind: 'memory',
    get: async (key) => clone(map.get(key)),
    set: async (key, value) => void map.set(key, clone(value)),
    delete: async (key) => void map.delete(key),
    keys: async () => [...map.keys()],
  };
}

/** Opens the best available storage backend. */
export async function openStorage() {
  if (typeof indexedDB !== 'undefined') {
    try {
      return indexedDbAdapter(await openIndexedDb());
    } catch (err) {
      console.warn('[storage] IndexedDB unavailable:', err?.message ?? err);
    }
  }
  try {
    const ls = globalThis.localStorage;
    ls.setItem(`${LS_PREFIX}probe`, '1');
    ls.removeItem(`${LS_PREFIX}probe`);
    return localStorageAdapter(ls);
  } catch {
    console.warn('[storage] localStorage unavailable, progress will not persist');
  }
  return memoryAdapter();
}

/** Asks the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
