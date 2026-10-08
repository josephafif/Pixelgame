// The official Pixelgame server on Cloudflare (Workers Free: no card, no bill).
//
// One Durable Object, "World", is the whole game world: the same server code
// as on Node (server/), its database in the object's own SQLite storage. The
// Worker in front only passes requests on to it:
//   wss://<worker>/ws   the game        GET /info  GET /health  POST /login
//
// The world sleeps when nobody plays (it costs nothing then) and wakes up on
// the next connection. Free plan limits (per day): 100,000 requests, where
// 20 incoming WebSocket messages count as one, and 13,000 GB-s of running
// time, which is about 28 hours for one object. Clients therefore send their
// inputs 15 times a second here (INPUT_EVERY=2) instead of 30; snapshots
// going out are free.

import { DurableObject } from 'cloudflare:workers';
import raw from '../data/v1/gamedata.json';
import { loadConfig } from '../server/config.js';
import { GameDb } from '../server/game-db.js';
import { setupGame } from '../server/setup.js';
import { handleConnection } from '../server/net.js';
import { DoSqlite } from './do-sqlite.js';

const IDLE_CHECK_MS = 30 * 1000;
const FREE_REQUESTS_PER_DAY = 100000;

function makeLog(level) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[level] ?? 1;
  const at = (lvl) => (...args) => {
    if (order[lvl] >= min) (lvl === 'error' ? console.error : console.log)(lvl.toUpperCase(), ...args);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A Workers WebSocket that looks like the `ws` package's (what server/net.js expects). */
export class SocketAdapter {
  constructor(ws, onMessage) {
    this.ws = ws;
    // Newer runtimes hand binary messages over as Blobs unless asked otherwise.
    ws.binaryType = 'arraybuffer';
    this.readyState = 1;
    this.handlers = { message: [], close: [], error: [] };
    ws.addEventListener('message', (e) => {
      onMessage?.();
      const isBinary = typeof e.data !== 'string';
      const data = isBinary ? Buffer.from(e.data) : Buffer.from(e.data, 'utf8');
      for (const fn of this.handlers.message) fn(data, isBinary);
    });
    ws.addEventListener('close', (e) => {
      if (this.readyState !== 3) {
        try {
          ws.close(e.code === 1005 ? 1000 : e.code, e.reason);
        } catch {
          // already closed
        }
      }
      this.readyState = 3;
      for (const fn of this.handlers.close) fn(e.code, e.reason);
    });
    ws.addEventListener('error', (e) => {
      for (const fn of this.handlers.error) fn(e);
    });
  }

  on(event, fn) {
    this.handlers[event]?.push(fn);
  }

  get bufferedAmount() {
    return 0; // not known on Workers
  }

  send(data) {
    if (this.readyState !== 1) return;
    try {
      this.ws.send(data);
    } catch {
      this.readyState = 3;
    }
  }

  close(code, reason) {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    try {
      this.ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  terminate() {
    this.close(1011, 'terminated');
  }
}

/** The Worker's variables as the server's environment (strings only). */
function envVars(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

export class World extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.config = loadConfig({ serveStatic: false, trustProxy: false, localAdmin: false }, {
      INPUT_EVERY: '2', SAVE_INTERVAL_MS: '30000', UPKEEP_CATCH_UP: '1', ...envVars(env),
    });
    this.log = makeLog(this.config.logLevel);
    this.db = new GameDb(new DoSqlite(ctx.storage));
    const { gs, auth, api } = setupGame({ raw, db: this.db, config: this.config, log: this.log });
    this.gs = gs;
    this.auth = auth;
    this.api = api;
    this.perIp = new Map();
    this.idleTimer = null;
    // A rough count of today's billed requests, to see how close the free plan is.
    const usage = JSON.parse(this.db.meta('usage') ?? 'null');
    this.usage = usage?.day === this.#today() ? usage : { day: this.#today(), messages: 0, http: 0 };
    // Today's usage is saved along with the world (every SAVE_INTERVAL_MS and when it sleeps).
    for (const name of ['saveAll', 'saveWorld']) {
      const save = gs[name].bind(gs);
      gs[name] = () => {
        save();
        this.db.setMeta('usage', JSON.stringify(this.usage));
      };
    }
  }

  #today() {
    return new Date().toISOString().slice(0, 10);
  }

  #count(kind) {
    if (this.usage.day !== this.#today()) this.usage = { day: this.#today(), messages: 0, http: 0 };
    this.usage[kind]++;
  }

  #billedToday() {
    return Math.ceil(this.usage.messages / 20) + this.usage.http;
  }

  /** The loop runs while anyone is in the world; then it saves and the object can sleep. */
  #wake() {
    if (!this.gs.running) {
      this.gs.start();
      this.log.info(`[world] awake (seed ${this.gs.worldSeed})`);
    }
    this.idleTimer ??= setInterval(() => {
      if (this.gs.players.size > 0) return;
      clearInterval(this.idleTimer);
      this.idleTimer = null;
      this.gs.saveAll();
      this.gs.stop();
      this.log.info('[world] nobody here: asleep');
    }, IDLE_CHECK_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.#count('http');
    const ip = request.headers.get('cf-connecting-ip') ?? '?';
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const origin = request.headers.get('origin');
      if (this.config.origins.length && origin && !this.config.origins.includes(origin)) {
        this.log.warn(`[net] refused origin ${origin}`);
        return new Response('Forbidden', { status: 403 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.#wake();
      const headers = Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v]));
      const socket = new SocketAdapter(server, () => this.#count('messages'));
      handleConnection(this.gs, this.auth, this.config, socket, { headers, socket: { remoteAddress: ip } }, this.perIp);
      return new Response(null, { status: 101, webSocket: client });
    }
    const out = await this.api({
      method: request.method,
      path: url.pathname,
      origin: request.headers.get('origin'),
      ip,
      text: () => request.text(),
    }, { awake: this.gs.running, requestsToday: this.#billedToday(), freeRequestsPerDay: FREE_REQUESTS_PER_DAY });
    if (out) return new Response(out.body, { status: out.status, headers: out.headers });
    return new Response('Pixelgame server: see /health and /info', { status: 404 });
  }
}

export default {
  // Once a day (wrangler.jsonc "triggers"): Supabase pauses free projects
  // after a week without requests, and the server list lives there.
  async scheduled(event, env) {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return;
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/list_game_servers`, {
      method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY, 'content-type': 'application/json' }, body: '{}',
    }).catch((err) => console.log('WARN supabase keep-alive failed', err.message));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response('Pixelgame: den officiella servern är igång.\nSpela på https://pixelgame-infinite-arsenal.netlify.app (Multiplayer).\nStatus: /health\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (!['/ws', '/info', '/health', '/login'].includes(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    // One world, placed in western Europe (closest to the players).
    const world = env.WORLD.get(env.WORLD.idFromName('main'), { locationHint: 'weur' });
    return world.fetch(request);
  },
};
