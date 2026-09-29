// Main-thread facade for weapon generation. Uses a module Web Worker when
// the browser supports it and falls back to generating on the main thread
// (same code, same results) when it doesn't.

import { generateWeapon, regenerate } from './generator.js';

const INIT_TIMEOUT_MS = 4000;

export class WeaponService {
  /**
   * @param {object} raw raw game data JSON (sent to the worker)
   * @param {object} data indexed game data (used by the fallback)
   */
  constructor(raw, data) {
    this.raw = raw;
    this.data = data;
    this.worker = null;
    this.mode = 'main-thread';
    this.nextId = 1;
    this.pending = new Map();
  }

  async init() {
    if (typeof Worker === 'undefined') return this.mode;
    try {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'weapon-gen' });
      worker.onmessage = (e) => this.#onMessage(e.data);
      const ready = new Promise((resolve, reject) => {
        worker.onerror = (e) => reject(new Error(e.message || 'worker failed to start'));
        this.#post(worker, 'init', this.raw).then(resolve, reject);
      });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('worker init timeout')), INIT_TIMEOUT_MS));
      await Promise.race([ready, timeout]);
      worker.onerror = (e) => this.#failAll(new Error(e.message || 'worker crashed'));
      this.worker = worker;
      this.mode = 'worker';
    } catch (err) {
      console.warn('[weapons] Web Worker unavailable, generating on main thread:', err.message);
      this.#failAll(err);
      this.worker = null;
    }
    return this.mode;
  }

  #post(worker, type, payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });
  }

  #onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  #failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async #run(type, payload, fallback) {
    if (this.worker) {
      try {
        return await this.#post(this.worker, type, payload);
      } catch (err) {
        console.warn('[weapons] worker call failed, retrying on main thread:', err.message);
      }
    }
    return fallback();
  }

  generate(request) {
    return this.#run('generate', request, () => generateWeapon(this.data, request));
  }

  generateMany(requests) {
    return this.#run('generateMany', requests, () => requests.map((r) => generateWeapon(this.data, r)));
  }

  regenerate(inputs) {
    return this.#run('regenerate', inputs, () => regenerate(this.data, inputs));
  }
}
