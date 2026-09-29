/* Pixelgame Service Worker.
 *
 * Caching strategy
 * - App shell (HTML, CSS, JS modules, icons): precached per version into
 *   `pixelgame-shell-<version>` and served cache-first. The version is a hash
 *   of every file (see scripts/build-precache.mjs), so any change produces a
 *   new worker, a new cache, and an "update available" prompt in the app.
 * - Game data (data/v1/*.json): stale-while-revalidate in a separate cache.
 *   Compatible content updates (new archetypes, modifiers, ...) can be
 *   deployed without shipping new code; clients are told when new data has
 *   been downloaded. The schema version is part of the URL, so an old client
 *   never receives data it can't read.
 * - Anything else same-origin: network-first with cache fallback.
 * - Save games live in IndexedDB and are never touched here.
 *
 * Updates: a new worker waits until the page asks it to take over
 * (SKIP_WAITING) after the player chose "Update now" and the game saved, or
 * until all windows are closed. Old shell caches are deleted on activation.
 */

importScripts('./precache-manifest.js');

const { version, shell, data } = self.__PRECACHE;
const SHELL_CACHE = `pixelgame-shell-${version}`;
const DATA_CACHE = 'pixelgame-data-v1';
const RUNTIME_CACHE = 'pixelgame-runtime-v1';
const INDEX_URL = new URL('index.html', self.registration.scope).href;
const DATA_URLS = new Set(data.map((u) => new URL(u, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(shell.map((url) => new Request(url, { cache: 'reload' })));
    const dataCache = await caches.open(DATA_CACHE);
    await Promise.all(data.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await dataCache.put(new URL(url, self.registration.scope).href, res);
      } catch {
        // Data is also fetched (and cached) at runtime.
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('pixelgame-shell-') && key !== SHELL_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'GET_VERSION') event.source?.postMessage({ type: 'VERSION', version });
});

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

async function dataVersionOf(response) {
  try {
    return (await response.clone().json()).dataVersion ?? null;
  } catch {
    return null;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request.url);
  const network = fetch(new Request(request.url, { cache: 'no-cache' }))
    .then(async (res) => {
      if (!res.ok) return res;
      const before = cached ? await dataVersionOf(cached) : null;
      const after = await dataVersionOf(res);
      await cache.put(request.url, res.clone());
      if (cached && after && before !== after) broadcast({ type: 'DATA_UPDATED', dataVersion: after });
      return res;
    });
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  return network;
}

async function navigation(request) {
  const shellCache = await caches.open(SHELL_CACHE);
  const cached = await shellCache.match(INDEX_URL);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return (await caches.match(INDEX_URL, { ignoreSearch: true }))
      ?? new Response('<h1>Offline</h1><p>Open the game once while online to enable offline play.</p>', {
        status: 503, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
  }
}

async function shellOrNetwork(request) {
  const shellCache = await caches.open(SHELL_CACHE);
  const hit = await shellCache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      const runtime = await caches.open(RUNTIME_CACHE);
      runtime.put(request, res.clone());
    }
    return res;
  } catch (err) {
    const fallback = await caches.match(request, { ignoreSearch: true });
    if (fallback) return fallback;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/precache-manifest.js')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
  } else if (DATA_URLS.has(url.origin + url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  } else {
    event.respondWith(shellOrNetwork(request));
  }
});

// Background Sync: ask open windows to push pending cloud saves.
self.addEventListener('sync', (event) => {
  if (event.tag === 'pixelgame-sync') event.waitUntil(broadcast({ type: 'SYNC_REQUESTED' }));
});
