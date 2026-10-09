#!/usr/bin/env node
// The server manager: run your own Pixelgame server without the terminal.
//
//   Double-click Starta-server.bat (Windows), Starta-server.command (Mac) or
//   starta-server.sh (Linux), or run: npm run host
//
// A control panel opens in your browser (only on this computer): start and
// stop the server, the code and invitation link to send your friends, who is
// online (kick, ban, make admin, a new password for someone who forgot it),
// the settings (name, rules, shown in the server list or not, players in the
// same home network), backups and restoring them, a fresh world, and the log.
//
// It runs the same server as `npm run share` (the game server plus a free
// Cloudflare quick tunnel and a join code from the server list) in this
// process. Settings are kept in server-data/settings.json, the world in
// server-data/pixelgame.db. Closing the window saves everything and stops.
//
// Options: --panel-port 8790   --no-open (don't open the browser)

import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync, statSync, readdirSync,
} from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL_FILE = join(root, 'scripts', 'host-panel.html');
const LOG_KEEP = 400;
const MAX_BODY = 16 * 1024;

export const DEFAULT_SETTINGS = {
  name: 'Min Pixelgame-server',
  port: 8787,
  autoStart: true, // start the server as soon as the program opens
  tunnel: true, // reachable over the internet (Cloudflare quick tunnel + a join code)
  listed: false, // shown to everyone in the game's server list
  lan: false, // players in the same home network may connect directly
  maxPlayers: 20,
  worldSeed: '', // '' = a random world (only used when a new world is made)
  admins: [],
  rules: { hardcore: false, deathDrop: 50, newbieHours: 2, raidWindow: 'sat 18:00-21:00', clanMax: 8 },
};

// --- Settings --------------------------------------------------------------------------

function intIn(v, min, max, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} ska vara ett heltal mellan ${min} och ${max}`);
  return n;
}

/**
 * Checks settings from the panel (merged over `base`); throws a Swedish
 * message for the first thing that is wrong.
 */
export async function cleanSettings(input = {}, base = DEFAULT_SETTINGS) {
  const { parseRaidWindow } = await import('../src/net/rules.js');
  const s = { ...base, ...input, rules: { ...base.rules, ...(input.rules ?? {}) } };
  const name = String(s.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 40) throw new Error('Servernamnet ska vara 3–40 tecken');
  const seed = String(s.worldSeed ?? '').trim();
  if (seed && !/^\d{1,10}$/.test(seed)) throw new Error('Världsfröet ska vara ett tal (eller tomt för en slumpad värld)');
  if (seed && Number(seed) > 4294967295) throw new Error('Världsfröet är för stort (högst 4294967295)');
  const admins = (Array.isArray(s.admins) ? s.admins : String(s.admins ?? '').split(','))
    .map((a) => String(a).trim()).filter(Boolean);
  if (admins.length > 20 || admins.some((a) => a.length > 40)) throw new Error('För många eller för långa adminnamn');
  const raidWindow = String(s.rules.raidWindow ?? '').trim();
  try {
    parseRaidWindow(raidWindow);
  } catch {
    throw new Error('Raidfönstret ska se ut som "sat 18:00-21:00" (dag på engelska, flera med komma) eller vara tomt');
  }
  return {
    name,
    port: intIn(s.port, 1024, 65535, 'Porten'),
    autoStart: Boolean(s.autoStart),
    tunnel: Boolean(s.tunnel),
    listed: Boolean(s.listed),
    lan: Boolean(s.lan),
    maxPlayers: intIn(s.maxPlayers, 1, 200, 'Max antal spelare'),
    worldSeed: seed,
    admins: [...new Set(admins)],
    rules: {
      hardcore: Boolean(s.rules.hardcore),
      deathDrop: intIn(s.rules.deathDrop, 0, 100, 'Andelen som tappas vid död'),
      newbieHours: intIn(s.rules.newbieHours, 0, 48, 'Nybörjarskyddet'),
      raidWindow,
      clanMax: intIn(s.rules.clanMax, 2, 50, 'Max medlemmar per klan'),
    },
  };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Addresses other devices in this home network can reach this computer at. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

// --- The tunnel and the server list (the same as npm run share) ---------------------------

async function defaultTunnel() {
  const share = await import('./share.mjs');
  const { CONFIG } = await import('../src/config.js');
  const mp = CONFIG.mp ?? {};
  return {
    find: share.findCloudflared,
    run: share.runTunnel,
    register: share.registerServer,
    loadHost: share.loadHost,
    saveHost: share.saveHost,
    heartbeatMs: share.HEARTBEAT_MS,
    registry: mp.supabaseUrl && mp.supabaseAnonKey ? { supabaseUrl: mp.supabaseUrl, key: mp.supabaseAnonKey } : null,
    site: (mp.siteUrl ?? '').replace(/\/+$/, ''),
  };
}

// --- The manager -------------------------------------------------------------------------------

export class Host {
  /**
   * dataDir: where settings, the world and backups live. startServer and
   * tunnel can be swapped (tests); echo: also print the log to the console.
   */
  constructor({ dataDir = join(root, 'server-data'), startServer = null, tunnel = defaultTunnel, echo = true } = {}) {
    this.dataDir = dataDir;
    this.dbPath = join(dataDir, 'pixelgame.db');
    this.backupDir = join(dataDir, 'backups');
    this.settingsFile = join(dataDir, 'settings.json');
    this.startServerFn = startServer;
    this.tunnelFactory = tunnel;
    this.echo = echo;
    this.state = 'stopped'; // stopped | starting | running | stopping
    this.error = null;
    this.server = null;
    this.startedAt = 0;
    this.logs = [];
    this.logSeq = 0;
    this.tun = { status: 'off', url: null, code: null, message: null, port: null, handle: null };
    this.busy = Promise.resolve();
    this.log = {
      debug: () => {},
      info: (...a) => this.#push('info', a),
      warn: (...a) => this.#push('warn', a),
      error: (...a) => this.#push('error', a),
    };
    mkdirSync(dataDir, { recursive: true });
    this.settings = this.#loadSettings();
  }

  #loadSettings() {
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
      return { ...DEFAULT_SETTINGS, ...raw, rules: { ...DEFAULT_SETTINGS.rules, ...(raw.rules ?? {}) } };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  #saveSettings() {
    writeFileSync(this.settingsFile, `${JSON.stringify(this.settings, null, 2)}\n`);
  }

  #push(level, args) {
    const text = format(...args);
    this.logs.push({ seq: ++this.logSeq, t: Date.now(), level, text });
    if (this.logs.length > LOG_KEEP) this.logs.splice(0, this.logs.length - LOG_KEEP);
    if (this.echo) (level === 'error' ? console.error : console.log)(`  ${new Date().toLocaleTimeString('sv-SE')}  ${text}`);
  }

  /** Runs one start/stop/restart at a time. */
  #serial(fn) {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  // --- Start / stop --------------------------------------------------------------------------

  start() {
    return this.#serial(async () => {
      if (this.state === 'running') return;
      await this.#startServer();
      if (this.state === 'running') await this.#syncTunnel();
    });
  }

  stop() {
    return this.#serial(async () => {
      await this.#stopTunnel();
      await this.#stopServer();
    });
  }

  /** New settings take effect: the server restarts (the tunnel too only if it has to). */
  restart() {
    return this.#serial(async () => {
      await this.#stopServer();
      await this.#startServer();
      if (this.state === 'running') await this.#syncTunnel();
      else await this.#stopTunnel();
    });
  }

  async #startServer() {
    const s = this.settings;
    this.state = 'starting';
    this.error = null;
    try {
      const startServer = this.startServerFn ?? (await import('../server/index.js')).startServer;
      this.server = await startServer({
        port: s.port,
        // Only this computer (and the tunnel) unless players in the home network may come in.
        host: s.lan ? '0.0.0.0' : '127.0.0.1',
        serveStatic: true,
        trustProxy: s.tunnel ? 'loopback' : false,
        localAdmin: true,
        serverName: s.name,
        maxPlayers: s.maxPlayers,
        allowGuests: true,
        dbPath: this.dbPath,
        backupDir: this.backupDir,
        worldSeed: s.worldSeed ? Number(s.worldSeed) >>> 0 : null,
        admins: s.admins,
        log: this.log,
        rules: {
          hardcore: s.rules.hardcore,
          deathDrop: s.rules.deathDrop / 100,
          newbieSeconds: s.rules.newbieHours * 3600,
          raidWindow: s.rules.raidWindow,
          clanMax: s.rules.clanMax,
        },
      });
      this.startedAt = Date.now();
      this.state = 'running';
      this.log.info(`Servern är igång på port ${this.server.port}.`);
    } catch (err) {
      this.server = null;
      this.state = 'stopped';
      this.error = err.code === 'EADDRINUSE'
        ? `Port ${s.port} används redan (kör servern redan i ett annat fönster?). Stäng den, eller välj en annan port under Inställningar.`
        : `Servern startade inte: ${err.message}`;
      this.log.error(this.error);
    }
  }

  async #stopServer() {
    if (!this.server) {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopping';
    try {
      await this.server.stop();
      this.log.info('Servern är stoppad. Allt är sparat.');
    } catch (err) {
      this.log.error('Fel när servern stoppades:', err);
    }
    this.server = null;
    this.state = 'stopped';
  }

  /** Starts, keeps or stops the tunnel to match the settings (and tells the server list). */
  async #syncTunnel() {
    const s = this.settings;
    if (!s.tunnel) {
      await this.#stopTunnel();
      return;
    }
    if (this.tun.handle && this.tun.port === this.server.port) {
      if (this.tun.url) await this.#publish(this.tun.url);
      return;
    }
    await this.#stopTunnel();
    this.tunnel ??= await this.tunnelFactory();
    const t = this.tunnel;
    this.tun = { status: 'starting', url: null, code: null, message: 'Startar tunneln till Cloudflare…', port: this.server.port, handle: null };
    let bin;
    try {
      bin = await t.find();
    } catch (err) {
      this.tun.status = 'error';
      this.tun.message = `Kunde inte hämta Cloudflares tunnelprogram (${err.message}). Spelet fungerar ändå på den här datorn${s.lan ? ' och i ditt hemnätverk' : ''}.`;
      this.log.error(this.tun.message);
      return;
    }
    this.hostId ??= t.loadHost();
    this.tun.handle = t.run(bin, this.server.port, {
      onUrl: async (url) => {
        this.tun.url = url;
        this.tun.status = 'up';
        this.tun.message = null;
        this.log.info(`Tunneln är uppe: ${url}`);
        await this.#publish(url);
      },
      onDown: ({ code, everReady, wait }) => {
        this.tun.status = 'down';
        this.tun.url = null;
        this.tun.message = everReady
          ? `Tunneln stängdes. En ny startar om ${wait} s (koden fortsätter att fungera).`
          : `Tunneln startade inte (kod ${code}). Försöker igen om ${wait} s. Kontrollera internetanslutningen.`;
        this.log.warn(this.tun.message);
      },
    });
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.tun.url && this.#publish(this.tun.url), t.heartbeatMs);
    this.heartbeat.unref?.();
  }

  async #publish(url) {
    const t = this.tunnel;
    if (!t?.registry) return;
    try {
      const code = await t.register({ ...t.registry, url, host: this.hostId, listed: this.settings.listed });
      if (code && code !== this.hostId.code) {
        this.hostId.code = code;
        t.saveHost(this.hostId);
      }
      this.tun.code = code ?? this.hostId.code ?? null;
      if (this.tun.message?.startsWith('Serverlistan')) this.tun.message = null;
    } catch (err) {
      this.tun.message = `Serverlistan svarade inte (${err.message}). Vännerna kan använda tunnellänken direkt.`;
      this.log.warn(this.tun.message);
    }
  }

  async #stopTunnel() {
    clearInterval(this.heartbeat);
    const t = this.tunnel;
    if (this.tun.handle) {
      if (t?.registry && this.hostId?.code) {
        await t.register({ ...t.registry, url: this.tun.url, host: this.hostId, listed: this.settings.listed, action: 'offline' }).catch(() => {});
      }
      this.tun.handle.stop();
      this.log.info('Tunneln är stängd.');
    }
    this.tun = { status: 'off', url: null, code: null, message: null, port: null, handle: null };
  }

  /** Stops everything (closing the program). */
  async shutdown() {
    await this.stop();
  }

  // --- Settings ----------------------------------------------------------------------------------

  /** Saves new settings; a running server restarts to use them (admins apply at once). */
  async updateSettings(input) {
    const next = await cleanSettings(input, this.settings);
    const before = JSON.stringify({ ...this.settings, admins: [], autoStart: false });
    const after = JSON.stringify({ ...next, admins: [], autoStart: false });
    this.settings = next;
    this.#saveSettings();
    this.#applyAdmins();
    const restart = this.state === 'running' && before !== after;
    if (restart) {
      this.log.info('Nya inställningar: startar om servern.');
      await this.restart();
    }
    return { restart };
  }

  #applyAdmins() {
    const gs = this.server?.gs;
    if (!gs) return;
    this.server.config.admins = [...this.settings.admins];
    const names = new Set(this.settings.admins.map((a) => a.toLowerCase()));
    // The same test as when someone joins (server/game-server.js).
    for (const p of gs.players.values()) {
      p.isAdmin = Boolean(p.conn?.local) || names.has(p.name.toLowerCase()) || names.has(p.accountId.toLowerCase());
      p.meDirty = true;
    }
  }

  // --- Players and tools --------------------------------------------------------------------------

  #gs() {
    if (this.state !== 'running' || !this.server) throw new Error('Starta servern först');
    return this.server.gs;
  }

  #online(name) {
    const gs = this.#gs();
    const want = String(name ?? '').toLowerCase();
    return [...gs.players.values()].find((p) => p.name.toLowerCase() === want) ?? null;
  }

  kick(name, reason) {
    const p = this.#online(name);
    if (!p) throw new Error('Ingen sådan spelare online');
    p.conn?.kick(String(reason || 'Utsparkad av servervärden').slice(0, 120));
    this.log.warn(`Sparkade ut ${p.name}.`);
  }

  ban(name, hours = 24) {
    const gs = this.#gs();
    const acc = gs.db.accountByName(String(name ?? ''));
    if (!acc) throw new Error('Ingen spelare med det namnet');
    const h = Math.max(1, Math.min(24 * 365 * 10, Number(hours) || 24));
    gs.db.ban(acc.id, Date.now() + h * 3600 * 1000, 'Avstängd av servervärden');
    gs.byAccount.get(acc.id)?.conn?.kick('Avstängd');
    this.log.warn(`${acc.name} är avstängd i ${h} timmar.`);
    return acc.name;
  }

  unban(name) {
    const gs = this.#gs();
    const acc = gs.db.accountByName(String(name ?? ''));
    if (!acc) throw new Error('Ingen spelare med det namnet');
    gs.db.ban(acc.id, 0, null);
    this.log.info(`${acc.name} får spela igen.`);
    return acc.name;
  }

  announce(text) {
    const gs = this.#gs();
    const msg = String(text ?? '').trim().slice(0, 200);
    if (!msg) throw new Error('Skriv ett meddelande');
    gs.broadcast({ t: 'toast', text: msg, kind: 'boss' });
    gs.broadcast({ t: 'sys', text: `Servervärden: ${msg}` });
    this.log.info(`Meddelande till alla: ${msg}`);
  }

  saveNow() {
    this.#gs().saveAll();
    this.log.info('Allt sparat.');
  }

  async setPassword(name, password) {
    const gs = this.#gs();
    const { passwordProblem } = await import('../src/net/rules.js');
    const { hashPassword } = await import('../server/auth.js');
    const acc = gs.db.accountByName(String(name ?? ''));
    if (!acc) throw new Error('Ingen spelare med det namnet');
    if (!acc.id.startsWith('guest:')) throw new Error('Den spelaren loggar in med e-post, Google eller Discord');
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    gs.db.setPassword(acc.id, await hashPassword(password));
    this.log.info(`${acc.name} har fått ett nytt lösenord.`);
    return acc.name;
  }

  async setAdmin(name, on) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('Skriv ett namn');
    const rest = this.settings.admins.filter((a) => a.toLowerCase() !== n.toLowerCase());
    return this.updateSettings({ admins: on ? [...rest, n] : rest });
  }

  // --- Backups and worlds ----------------------------------------------------------------------------

  backups() {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = statSync(join(this.backupDir, f));
        return { file: f, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  }

  backupNow() {
    if (this.state !== 'running' || !this.server) throw new Error('Starta servern först (säkerhetskopian görs medan den kör)');
    mkdirSync(this.backupDir, { recursive: true });
    const file = `manuell-${stamp()}.db`;
    this.server.gs.saveAll();
    this.server.db.backup(join(this.backupDir, file));
    this.log.info(`Säkerhetskopia sparad: ${file}`);
    return file;
  }

  /** Moves the current world into the backups folder (kept, never deleted). */
  #setAside(prefix) {
    if (!existsSync(this.dbPath)) return null;
    mkdirSync(this.backupDir, { recursive: true });
    const file = `${prefix}-${stamp()}.db`;
    renameSync(this.dbPath, join(this.backupDir, file));
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(this.dbPath + ext)) renameSync(this.dbPath + ext, join(this.backupDir, file + ext));
    }
    return file;
  }

  /** A brand new world; the old one is kept among the backups. */
  newWorld() {
    return this.#serial(async () => {
      const was = this.state === 'running';
      await this.#stopServer();
      const kept = this.#setAside('gammal-varld');
      this.log.warn(`Ny värld skapas.${kept ? ` Den gamla finns kvar som ${kept}.` : ''}`);
      if (was) {
        await this.#startServer();
        if (this.state === 'running') await this.#syncTunnel();
      }
      return kept;
    });
  }

  /** Puts a backup back as the world (the current one is kept among the backups first). */
  restore(file) {
    const name = basename(String(file ?? ''));
    const src = join(this.backupDir, name);
    if (name !== file || !name.endsWith('.db') || !existsSync(src)) throw new Error('Ingen sådan säkerhetskopia');
    return this.#serial(async () => {
      const was = this.state === 'running';
      await this.#stopServer();
      const kept = this.#setAside('fore-aterstallning');
      copyFileSync(src, this.dbPath);
      this.log.warn(`Världen återställd från ${name}.${kept ? ` Den du hade sparades som ${kept}.` : ''}`);
      if (was) {
        await this.#startServer();
        if (this.state === 'running') await this.#syncTunnel();
      }
      return kept;
    });
  }

  // --- Status ----------------------------------------------------------------------------------------

  async status(since = 0) {
    const s = this.settings;
    const { inSafeZone, claimAt, PROTOCOL_VERSION } = await statusDeps();
    const out = {
      state: this.state,
      error: this.error,
      settings: s,
      uptime: this.state === 'running' ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      local: this.server ? `http://localhost:${this.server.port}` : null,
      lan: this.server && s.lan ? lanAddresses().map((a) => `http://${a}:${this.server.port}`) : [],
      tunnel: {
        on: s.tunnel, status: this.tun.status, url: this.tun.url, code: this.tun.code, message: this.tun.message,
        site: this.tunnel?.site ?? null, registry: Boolean(this.tunnel?.registry),
      },
      players: [],
      stats: null,
      backups: this.backups(),
      dataDir: this.dataDir,
      logs: this.logs.filter((l) => l.seq > since),
      logSeq: this.logSeq,
      protocol: PROTOCOL_VERSION,
    };
    if (out.tunnel.code && out.tunnel.site) out.tunnel.invite = `${out.tunnel.site}/?join=${out.tunnel.code}`;
    const gs = this.state === 'running' ? this.server?.gs : null;
    if (gs) {
      const claims = gs.claims();
      for (const p of gs.players.values()) {
        const clan = p.clanId ? gs.clans.get(p.clanId) : null;
        const c = claimAt(gs.rules, claims, Math.floor(p.x), Math.floor(p.y));
        out.players.push({
          name: p.name,
          level: p.ch.level,
          clan: clan?.tag ?? null,
          where: inSafeZone(gs.rules, p.x, p.y) ? 'Fristaden' : c ? (c.clanId === p.clanId ? 'Egen bas' : 'Annan klans mark') : 'Vildmarken',
          hp: Math.ceil(Math.max(0, p.hp)),
          maxHp: p.maxHp,
          dead: p.dead,
          away: !p.conn,
          admin: p.isAdmin,
          minutes: Math.floor((Date.now() - p.joinedAt) / 60000),
        });
      }
      out.players.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      let size = 0;
      try {
        size = statSync(this.dbPath).size;
      } catch {
        // not written yet
      }
      out.stats = {
        tickMs: Math.round(gs.stats.tickMs * 100) / 100,
        maxTickMs: Math.round(gs.stats.maxTickMs * 10) / 10,
        memoryMb: Math.round(process.memoryUsage().rss / 1e6),
        accounts: gs.db.get('SELECT COUNT(*) AS n FROM accounts')?.n ?? 0,
        clans: gs.clans.size,
        worldSeed: gs.worldSeed,
        dbMb: Math.round(size / 1e5) / 10,
      };
    }
    return out;
  }
}

let deps = null;
async function statusDeps() {
  if (!deps) {
    const rules = await import('../src/net/rules.js');
    const protocol = await import('../src/net/protocol.js');
    deps = { inSafeZone: rules.inSafeZone, claimAt: rules.claimAt, PROTOCOL_VERSION: protocol.PROTOCOL_VERSION };
  }
  return deps;
}

// --- The control panel (a small web page, only on this computer) ------------------------------------

/** The panel's key (kept so a bookmark keeps working). */
export function panelKey(dataDir) {
  const file = join(dataDir, 'panel.json');
  try {
    const { key } = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof key === 'string' && key.length >= 32) return key;
  } catch {
    // first time
  }
  const key = randomBytes(24).toString('base64url');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ key }, null, 2)}\n`);
  return key;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function sameKey(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new Error('För stor begäran');
  }
  return raw ? JSON.parse(raw) : {};
}

/**
 * Serves the panel at http://localhost:<port>/ and its API. Only requests
 * from this computer with the right key are obeyed (and never from another
 * web page: the Host and Origin must be this panel's own).
 */
export async function startPanel(host, { port = 8790, key, onQuit = () => {} } = {}) {
  const html = readFileSync(PANEL_FILE);
  const font = readFileSync(join(root, 'fonts', 'pixelify-sans-400.woff2'));
  const icon = readFileSync(join(root, 'icons', 'icon-128.png'));
  const actions = {
    start: () => host.start(),
    stop: () => host.stop(),
    restart: () => host.restart(),
    settings: (b) => host.updateSettings(b.settings ?? {}),
    kick: (b) => host.kick(b.name, b.reason),
    ban: (b) => ({ name: host.ban(b.name, b.hours) }),
    unban: (b) => ({ name: host.unban(b.name) }),
    announce: (b) => host.announce(b.text),
    save: () => host.saveNow(),
    backup: () => ({ file: host.backupNow() }),
    password: async (b) => ({ name: await host.setPassword(b.name, b.password) }),
    admin: (b) => host.setAdmin(b.name, Boolean(b.on)),
    newworld: (b) => {
      if (b.confirm !== 'NY VÄRLD') throw new Error('Skriv NY VÄRLD för att bekräfta');
      return host.newWorld().then((kept) => ({ kept }));
    },
    restore: (b) => host.restore(b.file).then((kept) => ({ kept })),
    quit: async () => {
      setTimeout(onQuit, 100);
    },
  };
  const srv = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...extra,
      });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    // Another site pointing its name at this computer (DNS rebinding) gets nothing.
    if (!LOCAL_HOST.test(String(req.headers.host ?? ''))) {
      send(403, { ok: false, error: 'Bara från den här datorn' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      send(200, html, 'text/html; charset=utf-8', {
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/font.woff2') return send(200, font, 'font/woff2');
    if (req.method === 'GET' && url.pathname === '/icon.png') return send(200, icon, 'image/png');
    if (!url.pathname.startsWith('/api/')) return send(404, { ok: false, error: 'Finns inte' });
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}`) || !sameKey(req.headers['x-host-key'], key)) {
      send(403, { ok: false, error: 'Fel nyckel: öppna länken som visas i serverfönstret' });
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        send(200, { ok: true, ...(await host.status(Number(url.searchParams.get('since')) || 0)) });
        return;
      }
      const action = actions[url.pathname.slice(5)];
      if (req.method !== 'POST' || !action) return send(404, { ok: false, error: 'Okänd åtgärd' });
      const body = await readJson(req);
      const result = await action(body);
      send(200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (err) {
      send(400, { ok: false, error: err.message });
    }
  });
  let bound = 0;
  for (let p = port; p < port + 20; p++) {
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(p, '127.0.0.1', () => {
          srv.off('error', reject);
          resolve();
        });
      });
      bound = srv.address().port;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || port === 0) throw err;
    }
  }
  return { port: bound, close: () => new Promise((resolve) => srv.close(resolve)), http: srv };
}

// --- Main -------------------------------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url.replaceAll('&', '^&')]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser to open: the link is printed
  }
}

function box(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  console.log(['', `  ┌${'─'.repeat(width)}┐`, ...lines.map((l) => `  │  ${l.padEnd(width - 4)}  │`), `  └${'─'.repeat(width)}┘`, ''].join('\n'));
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.log(['', `  Servern behöver Node.js 22.5 eller nyare (du har ${process.versions.node}).`,
      '  Hämta den senaste LTS-versionen på https://nodejs.org och starta sedan igen.', ''].join('\n'));
    process.exit(1);
  }
  try {
    await import('ws');
  } catch {
    console.log('\n  Kör först: npm install --omit=dev\n');
    process.exit(1);
  }
  const host = new Host();
  const key = panelKey(host.dataDir);
  let quitting = false;
  const quit = async (why) => {
    if (quitting) return;
    quitting = true;
    console.log(`\n  Stänger (${why}): sparar alla spelare…`);
    await host.shutdown();
    await panel?.close();
    console.log('  Klart. Välkommen tillbaka!');
    process.exit(0);
  };
  const panel = await startPanel(host, { port: Number(arg('panel-port', 8790)), key, onQuit: () => quit('från panelen') });
  const url = `http://localhost:${panel.port}/#key=${key}`;
  box([
    'Pixelgame · Serverhanteraren',
    '',
    'Kontrollpanelen öppnas i din webbläsare. Om den inte gör det:',
    url,
    '',
    'Låt det här fönstret vara öppet medan ni spelar.',
    'Stäng av: knappen i panelen, Ctrl+C eller stäng fönstret (allt sparas).',
  ]);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => quit(sig === 'SIGINT' ? 'Ctrl+C' : sig));
  process.on('uncaughtException', (err) => {
    console.error('[fatal]', err);
    host.server?.gs.saveAll();
  });
  if (!process.argv.includes('--no-open')) openBrowser(url);
  if (host.settings.autoStart) await host.start();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
