// Service Worker registration and the update flow.
//
// - A new version is downloaded in the background and then *waits*.
// - The player is told an update is ready and chooses "Update now" or
//   "Later"; nothing reloads underneath a running game.
// - "Update now" saves first, then activates the new worker and reloads.
// - "Later" is safe too: the waiting version activates by itself the next
//   time the app is started, so nobody gets stuck on an old version.
// - Save data lives in IndexedDB, which the worker never touches.
// - Escape hatch: opening the app with ?sw=reset unregisters the worker and
//   clears its caches (never the save).

import { CONFIG } from '../config.js';

export function serviceWorkerSupported() {
  return 'serviceWorker' in navigator && window.isSecureContext;
}

export async function resetServiceWorker() {
  const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = (await globalThis.caches?.keys?.()) ?? [];
  await Promise.all(keys.filter((k) => k.startsWith('pixelgame-')).map((k) => caches.delete(k)));
}

/**
 * @param {object} handlers
 * @param {(apply: () => void) => void} handlers.onUpdateReady
 * @param {() => void} handlers.onOfflineReady
 * @param {(msg: object) => void} handlers.onMessage
 */
export async function registerServiceWorker({ onUpdateReady, onOfflineReady, onMessage }) {
  if (!serviceWorkerSupported()) return null;
  const params = new URLSearchParams(location.search);
  if (params.get('sw') === 'reset') {
    await resetServiceWorker();
    params.delete('sw');
    const qs = params.toString();
    location.replace(`${location.pathname}${qs ? `?${qs}` : ''}`);
    return null;
  }

  const reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  const announce = (worker) => {
    if (!worker) return;
    onUpdateReady(() => worker.postMessage({ type: 'SKIP_WAITING' }));
  };

  // Already waiting from an earlier visit.
  if (reg.waiting && hadController) announce(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state !== 'installed') return;
      if (navigator.serviceWorker.controller) announce(worker);
      else onOfflineReady();
    });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install claims the page; only reload for real updates.
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (e) => onMessage?.(e.data ?? {}));

  if (hadController && reg.active) onOfflineReady();
  else navigator.serviceWorker.ready.then(() => onOfflineReady());

  // Look for new versions regularly and whenever the app comes back.
  const check = () => {
    if (navigator.onLine !== false) reg.update().catch(() => {});
  };
  setInterval(check, CONFIG.updateCheckIntervalMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  addEventListener('online', check);
  return reg;
}
