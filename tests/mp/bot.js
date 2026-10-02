// A headless test client: logs in, sends inputs at 30 Hz with the same
// prediction the browser uses, and records what the server says.

import WebSocket from 'ws';
import { encodeInput, decodeSnapshot, PROTOCOL_VERSION } from '../../src/net/protocol.js';

export class Bot {
  constructor(url, { token = 'guest', name = null } = {}) {
    this.url = url;
    this.token = token;
    this.name = name;
    this.known = new Map();
    this.json = [];
    this.snapshots = 0;
    this.self = null;
    this.ack = 0;
    this.seq = 0;
    this.listeners = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', v: PROTOCOL_VERSION, token: this.token })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const snap = decodeSnapshot(data, this.known);
          this.snapshots++;
          this.self = snap.self;
          this.ack = snap.ack;
          this.tick = snap.tick;
          this.lastSnap = snap;
          return;
        }
        const msg = JSON.parse(data.toString());
        this.json.push(msg);
        if (msg.t === 'guest') this.token = msg.token;
        if (msg.t === 'need-name' && !msg.error) ws.send(JSON.stringify({ t: 'create', name: this.name ?? `Bot${Math.floor(Math.random() * 1e6)}` }));
        if (msg.t === 'welcome') {
          this.welcome = msg;
          resolve(this);
        }
        if (msg.t === 'kick') this.kicked = msg.reason;
        for (const fn of this.listeners) fn(msg);
      });
      ws.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() };
        if (!this.welcome) reject(new Error(`closed: ${reason}`));
      });
      ws.on('error', reject);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  /** Waits for a JSON message matching pred. */
  waitFor(pred, ms = 3000) {
    const hit = this.json.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      this.on((m) => {
        if (pred(m)) {
          clearTimeout(t);
          resolve(m);
        }
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  request(msg, ms = 3000) {
    const rid = Math.floor(Math.random() * 1e9);
    this.send({ ...msg, rid });
    return this.waitFor((m) => m.t === 'res' && m.rid === rid, ms);
  }

  input(frame) {
    this.seq++;
    const f = { seq: this.seq, mx: 0, my: 0, buttons: 0, cmd: 0, aim: 0, target: 0, view: this.tick ?? 0, ...frame };
    this.ws.send(encodeInput([f]));
    return f;
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
