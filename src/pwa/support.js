// Feature detection. Missing features degrade gracefully: the game keeps
// working as a normal web app and the settings screen explains what's off.

export function detectSupport() {
  const has = {
    serviceWorker: 'serviceWorker' in navigator && window.isSecureContext,
    indexedDB: typeof indexedDB !== 'undefined',
    manifest: 'relList' in HTMLLinkElement.prototype && document.createElement('link').relList.supports?.('manifest') !== false,
    moduleWorker: typeof Worker !== 'undefined',
    webAudio: Boolean(globalThis.AudioContext ?? globalThis.webkitAudioContext),
    pointerEvents: 'PointerEvent' in window,
    gamepad: 'getGamepads' in navigator,
    vibration: 'vibrate' in navigator,
    persistentStorage: Boolean(navigator.storage?.persist),
    webLocks: Boolean(navigator.locks),
    fullscreen: Boolean(document.fullscreenEnabled),
  };
  const labels = {
    serviceWorker: 'offline mode',
    indexedDB: 'IndexedDB saves (using fallback storage)',
    moduleWorker: 'background weapon generation',
    webAudio: 'sound',
    pointerEvents: 'touch controls',
  };
  const unsupported = Object.entries(labels).filter(([k]) => !has[k]).map(([, v]) => v);
  return { has, unsupported };
}
