#!/usr/bin/env node
// Pixelgame multiplayer server.
//   node server/index.js            (settings from environment, see .env.example)
//
// HTTP:  GET /health  GET /info   (WebSocket at /ws)
// With SERVE_STATIC=1 it also serves the game itself (handy for local play).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { prepareGameData } from '../src/data/gamedata.js';
import { mpGameData } from '../src/net/mpbuild.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Auth } from './auth.js';
import { GameServer } from './game-server.js';
import { handleConnection, serverInfo } from './net.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const STATIC_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'precache-manifest.js']);
const STATIC_DIRS = ['css/', 'fonts/', 'icons/', 'src/', 'data/v1/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function makeLog(level) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[level] ?? 1;
  const at = (lvl) => (...args) => {
    if (order[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)}`;
    (lvl === 'error' ? console.error : console.log)(line, ...args);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export async function startServer(overrides = {}) {
  const config = loadConfig(overrides);
  const log = overrides.log ?? makeLog(config.logLevel);
  const raw = JSON.parse(readFileSync(join(root, 'data/v1/gamedata.json'), 'utf8'));
  const data = mpGameData(prepareGameData(raw));
  const db = new Db(config.dbPath);
  const auth = new Auth({
    supabaseUrl: config.supabaseUrl,
    supabaseJwtSecret: config.supabaseJwtSecret,
    allowGuests: config.allowGuests,
    guestSecret: config.guestSecret ?? null,
    fetch: overrides.fetch,
  });
  const gs = new GameServer({ data, db, config, log });
  // Guest tokens must survive restarts (or guests would lose their character).
  auth.guestSecret = config.guestSecret || db.meta('guestSecret');

  const cors = (req) => {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (config.origins.length && !config.origins.includes(origin)) return {};
    return { 'access-control-allow-origin': origin, vary: 'origin' };
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      let online = 0;
      for (const p of gs.players.values()) if (p.conn) online++;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) });
      res.end(JSON.stringify({
        ok: true, tick: gs.tick, players: online, bodies: gs.players.size - online, enemies: gs.enemies.size,
        projectiles: gs.projectiles.size, tickMs: Math.round(gs.stats.tickMs * 100) / 100, maxTickMs: Math.round(gs.stats.maxTickMs * 100) / 100,
        uptime: Math.round(process.uptime()),
      }));
      return;
    }
    if (url.pathname === '/info') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) });
      res.end(JSON.stringify(serverInfo(gs, auth, config)));
      return;
    }
    if (config.serveStatic && req.method === 'GET') {
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '').replaceAll('\\', '/');
      if (path === '' || path === '.') path = 'index.html';
      // Only the game's own files: never the server, the database or node_modules.
      if (path.includes('..') || !STATIC_FILES.has(path) && !STATIC_DIRS.some((d) => path.startsWith(d))) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      const file = join(root, path);
      try {
        let body = await readFile(file);
        // Tell the page it is served by a game server (its lobby then offers "this server").
        if (path === 'index.html') body = Buffer.from(body.toString('utf8').replace('</head>', '  <meta name="pixelgame-server" content="1">\n</head>'));
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Pixelgame server: see /health and /info');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const perIp = new Map();
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (config.origins.length && origin && !config.origins.includes(origin)) {
      log.warn(`[net] refused origin ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(gs, auth, config, ws, req, perIp));
  });

  // Daily backups (a consistent copy while the server runs), last 14 kept.
  let backupTimer = null;
  if (config.backupDir) {
    const backup = async () => {
      try {
        await mkdir(config.backupDir, { recursive: true });
        const file = join(config.backupDir, `pixelgame-${new Date().toISOString().slice(0, 10)}.db`);
        await unlink(file).catch(() => {});
        db.backup(file);
        const old = (await readdir(config.backupDir)).filter((f) => /^pixelgame-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
        for (const f of old.slice(0, Math.max(0, old.length - 14))) await unlink(join(config.backupDir, f));
        log.info(`[backup] wrote ${file}`);
      } catch (err) {
        log.error('[backup] failed', err);
      }
    };
    backupTimer = setInterval(backup, 24 * 60 * 60 * 1000);
    setTimeout(backup, 60 * 1000);
  }

  // Supabase pauses free projects after a week without requests: a small
  // request twice a day keeps the login service awake.
  let keepAlive = null;
  if (config.supabaseUrl && config.supabaseAnonKey) {
    const ping = () => fetch(`${config.supabaseUrl}/auth/v1/health`, { headers: { apikey: config.supabaseAnonKey }, signal: AbortSignal.timeout(10000) })
      .catch((err) => log.warn('[supabase] keep-alive failed', err.message));
    keepAlive = setInterval(ping, 12 * 60 * 60 * 1000);
    setTimeout(ping, 5000);
  }

  await new Promise((resolve) => http.listen(config.port, config.host, resolve));
  const port = http.address().port;
  gs.start();
  log.info(`[server] ${config.serverName} on :${port} — world seed ${gs.worldSeed}, guests ${auth.allowGuests ? 'on' : 'off'}, Supabase ${auth.supabaseEnabled ? 'on' : 'off'}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    gs.stop();
    for (const p of gs.players.values()) p.conn?.kick('Servern startar om, välkommen tillbaka om en stund');
    gs.saveAll();
    clearInterval(backupTimer);
    clearInterval(keepAlive);
    wss.close();
    await new Promise((resolve) => http.close(resolve));
    db.close();
  };
  return { gs, http, wss, port, db, auth, config, stop };
}

// Run directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // --dev: play locally right away (the game at http://localhost:8787/, guests on).
  const dev = process.argv.includes('--dev');
  if (dev) {
    process.env.ALLOW_GUESTS ??= '1';
    process.env.DB_PATH ??= 'server-data/dev.db';
  }
  const server = await startServer({
    serveStatic: dev || /^(1|true|yes)$/i.test(process.env.SERVE_STATIC ?? ''),
    // Local testing: everyone may use the admin commands (/tp, /give …).
    devAdmins: dev,
    backupDir: process.env.BACKUP_DIR ?? 'server-data/backups',
    trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ''),
    discordWebhook: process.env.DISCORD_WEBHOOK_URL ?? '',
  });
  const shutdown = async (sig) => {
    server.gs.log.info(`[server] ${sig}: saving and stopping`);
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    server.gs.log.error('[fatal]', err);
    server.gs.saveAll();
  });
}
