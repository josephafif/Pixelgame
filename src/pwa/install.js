// Install prompt handling (Chromium's beforeinstallprompt, plus a hint for
// iOS Safari where installation goes through the Share sheet).

let deferred = null;
const listeners = new Set();

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  listeners.forEach((fn) => fn());
});

addEventListener('appinstalled', () => {
  deferred = null;
  listeners.forEach((fn) => fn());
});

export function onInstallAvailabilityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isStandalone() {
  return matchMedia?.('(display-mode: standalone)').matches
    || matchMedia?.('(display-mode: fullscreen)').matches
    || navigator.standalone === true;
}

export function canInstall() {
  return Boolean(deferred) && !isStandalone();
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function iosInstallHint() {
  return isIOS() && !isStandalone();
}

export async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  e.prompt();
  const { outcome } = await e.userChoice;
  listeners.forEach((fn) => fn());
  return outcome === 'accepted';
}
