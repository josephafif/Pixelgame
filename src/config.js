// App-wide configuration. Everything here is safe to change per deployment.

export const APP_NAME = 'Pixelgame: Infinite Arsenal';
export const APP_VERSION = '0.1.0';

export const CONFIG = {
  // Optional cloud save endpoint. Leave empty to play fully offline/local.
  // When set, saves are PUT as JSON to `${syncEndpoint}/saves/${accountId}`
  // whenever the device is online (see src/storage/sync.js for the protocol).
  syncEndpoint: '',
  // How often a running app asks the Service Worker to look for a new version.
  updateCheckIntervalMs: 30 * 60 * 1000,
  // Autosave cadence while playing (also saves on pause/hide/update).
  autosaveIntervalMs: 15 * 1000,
};

// Deployments can override config without rebuilding by defining
// window.PIXELGAME_CONFIG before src/main.js loads.
if (typeof globalThis !== 'undefined' && globalThis.PIXELGAME_CONFIG) {
  Object.assign(CONFIG, globalThis.PIXELGAME_CONFIG);
}
