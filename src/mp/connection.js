// The browser side of the WebSocket: login handshake, JSON requests with
// replies, binary snapshots, and a running estimate of the round trip.

import { PROTOCOL_VERSION, MSG } from '../net/protocol.js';

export class Connection {
  /**
   * @param {string} url wss://…/ws
   * @param {object} handlers { onJson(msg), onSnapshot(buf), onClose({ code, reason }), onNeedName(msg) }
   */
  constructor(url, handlers) {
    this.url = url;
    this.h = handlers;
    this.ws = null;
    this.pending = new Map();
    this.nextRid = 1;
    this.rtt = 100;
    this.rttSamples = [];
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.open = false;
  }

  /** Connects and logs in; resolves with the server's welcome message. */
  connect(token) {
    return new Promise((resolve, reject) => {
      let welcomed = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      // The server must answer within 15 s, except while a new player picks
      // a name (that takes as long as it takes; pings keep the line open).
      let timeout = null;
      const arm = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (!welcomed) {
            ws.close();
            reject(new Error('Servern svarar inte'));
          }
        }, 15000);
      };
      this.rearm = arm;
      arm();
      ws.onopen = () => {
        this.open = true;
        this.sendJson({ t: 'auth', v: PROTOCOL_VERSION, token });
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          this.bytesIn += e.data.byteLength;
          if (new Uint8Array(e.data)[0] === MSG.SNAPSHOT) this.h.onSnapshot?.(e.data);
          return;
        }
        this.bytesIn += e.data.length;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          welcomed = true;
          clearTimeout(timeout);
          this.rearm = null;
          this.#startPing();
          resolve(msg);
        }
        if (msg.t === 'need-name') {
          clearTimeout(timeout);
          if (!this.pingTimer) this.#startPing();
          this.h.onNeedName?.(msg);
          return;
        }
        if (msg.t === 'res') {
          const p = this.pending.get(msg.rid);
          if (p) {
            this.pending.delete(msg.rid);
            p.resolve(msg);
          }
          return;
        }
        if (msg.t === 'pong') {
          const rtt = performance.now() - msg.c;
          this.rttSamples.push(rtt);
          if (this.rttSamples.length > 10) this.rttSamples.shift();
          this.rtt = [...this.rttSamples].sort((a, b) => a - b)[Math.floor(this.rttSamples.length / 2)];
          return;
        }
        if (msg.t === 'kick') this.kickReason = msg.reason;
        this.h.onJson?.(msg);
      };
      ws.onclose = (e) => {
        this.open = false;
        clearTimeout(timeout);
        clearInterval(this.pingTimer);
        for (const p of this.pending.values()) p.resolve({ ok: false, error: 'Frånkopplad' });
        this.pending.clear();
        const reason = this.kickReason ?? e.reason ?? '';
        if (!welcomed) reject(new Error(reason || 'Kunde inte ansluta till servern'));
        else this.h.onClose?.({ code: e.code, reason });
      };
      ws.onerror = () => {};
    });
  }

  #startPing() {
    clearInterval(this.pingTimer);
    const ping = () => this.sendJson({ t: 'ping', c: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  /** A new player's name (and password): the server answers with a welcome or asks again. */
  sendCreate(name, password) {
    this.rearm?.();
    return this.sendJson({ t: 'create', name, password });
  }

  sendJson(msg) {
    if (this.ws?.readyState !== 1) return false;
    const text = JSON.stringify(msg);
    this.bytesOut += text.length;
    this.ws.send(text);
    return true;
  }

  sendBinary(buf) {
    if (this.ws?.readyState !== 1) return false;
    this.bytesOut += buf.byteLength;
    this.ws.send(buf);
    return true;
  }

  /** A request the server answers ({ ok, error }). */
  request(msg) {
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      if (!this.sendJson({ ...msg, rid })) {
        resolve({ ok: false, error: 'Inte ansluten' });
        return;
      }
      this.pending.set(rid, { resolve });
      setTimeout(() => {
        if (this.pending.delete(rid)) resolve({ ok: false, error: 'Servern svarade inte' });
      }, 8000);
    });
  }

  get buffered() {
    return this.ws?.bufferedAmount ?? 0;
  }

  close() {
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
