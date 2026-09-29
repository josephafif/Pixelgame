// Optional cloud sync. The game is fully playable without it; when a sync
// endpoint is configured (src/config.js) the latest local save is pushed
// whenever the device is online, and queued while offline.
//
// Protocol (simple, last-writer-wins by revision):
//   PUT  {endpoint}/saves/{accountId}   body: { rev, updatedAt, save }
//     200 → stored.   409 → server has a newer save: body { rev, updatedAt, save }
//   GET  {endpoint}/saves/{accountId}   → { rev, updatedAt, save } | 404

export class SyncManager {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint base URL; empty disables sync
   * @param {() => object} opts.getSave returns the current in-memory save
   * @param {(status: string, detail?: string) => void} [opts.onStatus]
   * @param {(remote: object) => void} [opts.onConflict] server has newer data
   */
  constructor({ endpoint, getSave, onStatus = () => {}, onConflict = () => {} }) {
    this.endpoint = (endpoint ?? '').replace(/\/+$/, '');
    this.getSave = getSave;
    this.onStatus = onStatus;
    this.onConflict = onConflict;
    this.status = this.enabled ? 'idle' : 'disabled';
    this.flushing = null;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.flush());
      window.addEventListener('offline', () => this.#set(this.enabled ? 'offline' : 'disabled'));
    }
  }

  get enabled() {
    return Boolean(this.endpoint);
  }

  get online() {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  #set(status, detail) {
    this.status = status;
    this.onStatus(status, detail);
  }

  hasPendingChanges() {
    const save = this.getSave();
    return Boolean(save) && save.rev > (save.sync?.lastSyncedRev ?? 0);
  }

  /** Call after every local save. */
  notifySaved() {
    if (!this.enabled) return;
    if (!this.online) {
      this.#set('offline', 'Changes will sync when you are back online');
      this.#registerBackgroundSync();
      return;
    }
    this.flush();
  }

  async #registerBackgroundSync() {
    try {
      const reg = await navigator.serviceWorker?.ready;
      await reg?.sync?.register('pixelgame-sync');
    } catch {
      // Background Sync is optional; the 'online' listener covers the rest.
    }
  }

  flush() {
    if (!this.enabled || !this.online) return Promise.resolve(false);
    if (this.flushing) return this.flushing;
    this.flushing = this.#push().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async #push() {
    const save = this.getSave();
    if (!save || !this.hasPendingChanges()) {
      this.#set('synced');
      return true;
    }
    const accountId = save.sync?.accountId;
    if (!accountId) {
      this.#set('error', 'No account linked');
      return false;
    }
    this.#set('syncing');
    try {
      const res = await fetch(`${this.endpoint}/saves/${encodeURIComponent(accountId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev: save.rev, updatedAt: save.updatedAt, save }),
      });
      if (res.status === 409) {
        this.onConflict(await res.json());
        this.#set('conflict');
        return false;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      save.sync.lastSyncedRev = save.rev;
      this.#set('synced');
      return true;
    } catch (err) {
      this.#set(this.online ? 'error' : 'offline', err.message);
      return false;
    }
  }
}
