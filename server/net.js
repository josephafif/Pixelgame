// WebSocket connections: login handshake, message size and rate limits,
// and routing to the game. Anything malformed gets the connection closed.

import { PROTOCOL_VERSION, decodeInput, MSG } from '../src/net/protocol.js';
import { TICK_RATE } from '../src/net/movement.js';
import { playerNameProblem, passwordProblem, describeRaidWindow } from '../src/net/rules.js';
import { AuthError, hashPassword } from './auth.js';
import * as players from './players.js';
import * as commands from './commands.js';
import * as clans from './clans.js';
import * as abilities from './abilities.js';

const MAX_TEXT = 8 * 1024;
const MAX_BINARY = 256;
const AUTH_TIMEOUT_MS = 10000;
const NAME_TIMEOUT_MS = 10 * 60 * 1000; // picking a name and a password takes a while

/** Token bucket: `rate` per second, bursts up to `burst`. */
class Bucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = Date.now();
  }

  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export class Connection {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
    this.closed = false;
    this.binary = new Bucket(TICK_RATE * 2, TICK_RATE * 3);
    this.text = new Bucket(15, 40);
    this.strikes = 0;
  }

  get bufferedAmount() {
    return this.ws.bufferedAmount;
  }

  sendJson(msg) {
    if (this.closed || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(buf) {
    if (this.closed || this.ws.readyState !== 1) return;
    this.ws.send(buf, { binary: true });
  }

  /** A JSON message that is already a string (shared by many receivers). */
  sendText(text) {
    if (this.closed || this.ws.readyState !== 1) return;
    this.ws.send(text);
  }

  /** Holds writes until uncork(): a tick's messages leave in one packet. */
  cork() {
    this.ws._socket?.cork?.();
  }

  uncork() {
    this.ws._socket?.uncork?.();
  }

  kick(reason) {
    if (this.closed) return;
    this.sendJson({ t: 'kick', reason });
    this.closed = true;
    try {
      this.ws.close(4000, String(reason).slice(0, 100));
    } catch {
      this.ws.terminate();
    }
  }

  /** Misbehaviour: a few strikes and you're out. */
  strike(gs, why) {
    this.strikes++;
    gs.log.warn(`[net] ${this.ip} ${this.player?.name ?? '?'}: ${why}`);
    if (this.strikes >= 5) this.kick('För många ogiltiga meddelanden');
  }
}

/** The player's real address (behind Cloudflare Tunnel or Caddy it is in a header). */
export function clientIp(req, config) {
  // trustProxy 'loopback': only a tunnel on this computer adds the address
  // headers (players in the same home network connect directly).
  const trusted = config.trustProxy === 'loopback' ? isLoopback(req.socket.remoteAddress) : Boolean(config.trustProxy);
  const forwarded = trusted ? (req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) : '';
  return forwarded || req.socket.remoteAddress || '?';
}

function isLoopback(addr) {
  return /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(addr ?? '');
}

/**
 * Someone at the server's own computer (http://localhost), not through a
 * tunnel or proxy: they always add headers a visitor can't remove (cf-ray,
 * x-forwarded-for) and never send a localhost Host.
 */
export function isLocalRequest(req) {
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const hd = req.headers;
  if (hd['cf-ray'] || hd['cf-connecting-ip'] || hd['x-forwarded-for'] || hd['x-real-ip'] || hd.forwarded) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(hd.host ?? ''));
}

export function serverInfo(gs, auth, config) {
  let online = 0;
  for (const p of gs.players.values()) if (p.conn) online++;
  return {
    name: config.serverName,
    protocol: PROTOCOL_VERSION,
    players: online,
    maxPlayers: config.maxPlayers,
    guests: auth.allowGuests,
    // Guests can log in again with name + password (POST /login).
    logins: auth.allowGuests,
    supabase: auth.supabaseEnabled,
    rules: {
      safeRadius: gs.rules.safeRadius,
      claimRadius: gs.rules.claimRadius,
      raidWindow: describeRaidWindow(gs.raidWindows),
      raidGraceMinutes: gs.rules.raidGraceMinutes,
      clanMax: gs.rules.clanMax,
      hardcore: gs.rules.hardcore,
    },
  };
}

/**
 * Wires one WebSocket. First message must be
 *   { t: 'auth', v: PROTOCOL_VERSION, token }   (token 'guest' asks for a guest identity)
 * then, for a brand-new account, { t: 'create', name }.
 */
export function handleConnection(gs, auth, config, ws, req, perIp) {
  const ip = clientIp(req, config);
  const count = (perIp.get(ip) ?? 0) + 1;
  perIp.set(ip, count);
  const conn = new Connection(ws, ip);
  conn.local = isLocalRequest(req);
  const release = () => {
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  };
  if (count > (config.maxPerIp ?? 8)) {
    conn.kick('För många anslutningar från din adress');
    release();
    return;
  }
  let stage = 'auth';
  let identity = null;
  let busy = false;
  let timer = setTimeout(() => {
    if (stage !== 'play') conn.kick('Inloggningen tog för lång tid');
  }, config.authTimeoutMs ?? AUTH_TIMEOUT_MS);

  const enter = (account) => {
    let online = 0;
    for (const p of gs.players.values()) if (p.conn) online++;
    if (online >= config.maxPlayers && !gs.byAccount.get(account.id)) {
      conn.kick(`Servern är full (${config.maxPlayers} spelare)`);
      return;
    }
    const p = gs.join(account, conn);
    conn.player = p;
    stage = 'play';
    clearTimeout(timer);
    conn.sendJson({
      t: 'welcome',
      id: p.id,
      name: p.name,
      tick: gs.tick,
      tickRate: TICK_RATE,
      inputEvery: config.inputEvery ?? 1,
      seed: gs.worldSeed,
      gen: gs.worldGen,
      legacy: [...gs.legacy],
      rules: gs.rules,
      server: serverInfo(gs, auth, config),
      x: p.x,
      y: p.y,
      time: Date.now(),
      account: { guest: identity.guest, password: Boolean(account.pass_hash) },
      spentAltars: [...gs.marks.values()].filter((m) => m.kind === 'altar').map((m) => m.key),
    });
    conn.sendJson(players.inventoryPayload(gs, p));
    conn.sendJson(players.mePayload(gs, p));
    conn.sendJson(abilities.cooldownPayload(p));
    conn.sendJson({ t: 'claims', claims: gs.claims() });
    const clan = gs.clanOf(p.accountId);
    if (clan) conn.sendJson(clans.clanPayload(gs, clan));
    clans.sendInvites(gs, p);
    if (p.dead) conn.sendJson({ t: 'died', by: null, respawnIn: Math.max(0, (p.respawnAt - Date.now()) / 1000) });
    gs.log.info(`[join] ${p.name} (${account.id.slice(0, 12)}…) from ${ip}`);
  };

  const onAuth = async (msg) => {
    if (msg.t !== 'auth') return conn.kick('Logga in först');
    if (msg.v !== PROTOCOL_VERSION) {
      conn.sendJson({ t: 'kick', reason: 'update', need: PROTOCOL_VERSION });
      return conn.kick('Spelet har uppdaterats: ladda om sidan');
    }
    let token = msg.token;
    if (token === 'guest') {
      try {
        token = auth.issueGuest();
      } catch (err) {
        return conn.kick(err.message);
      }
      conn.sendJson({ t: 'guest', token });
    }
    try {
      identity = await auth.verify(token);
    } catch (err) {
      if (err instanceof AuthError) return conn.kick(`Inloggningen misslyckades: ${err.message}`);
      gs.log.error('[auth]', err);
      return conn.kick('Inloggningen misslyckades');
    }
    if (conn.closed) return undefined;
    const account = gs.db.account(identity.id);
    if (account?.banned_until > Date.now()) {
      return conn.kick(`Du är avstängd${account.ban_reason ? `: ${account.ban_reason}` : ''}`);
    }
    if (!account) {
      stage = 'create';
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stage !== 'play') conn.kick('Det tog för lång tid att välja namn');
      }, NAME_TIMEOUT_MS);
      conn.sendJson({ t: 'need-name', suggestion: identity.name ? identity.name.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 16) : '' });
      return undefined;
    }
    enter({ ...account, email: identity.email });
    return undefined;
  };

  const onCreate = async (msg) => {
    if (msg.t !== 'create') return conn.kick('Välj ett namn först');
    const name = String(msg.name ?? '').trim();
    const problem = playerNameProblem(name);
    if (problem) return conn.sendJson({ t: 'need-name', error: problem });
    if (gs.db.accountByName(name)) return conn.sendJson({ t: 'need-name', error: 'Namnet är upptaget' });
    // Guests may pick a password, to log in again from another address or device.
    let passHash = null;
    if (identity.guest && msg.password) {
      const pwProblem = passwordProblem(msg.password);
      if (pwProblem) return conn.sendJson({ t: 'need-name', error: pwProblem });
      passHash = await hashPassword(msg.password);
      if (conn.closed) return undefined;
    }
    let account;
    try {
      account = gs.db.createAccount({ id: identity.id, name, email: identity.email, passHash });
    } catch {
      return conn.sendJson({ t: 'need-name', error: 'Namnet är upptaget' });
    }
    enter({ ...account, email: identity.email });
    return undefined;
  };

  ws.on('message', async (data, isBinary) => {
    if (conn.closed) return;
    try {
      if (isBinary) {
        if (stage !== 'play') return conn.kick('Logga in först');
        if (data.length > MAX_BINARY) return conn.strike(gs, 'binary too big');
        if (!conn.binary.take()) return undefined; // flood: dropped (the server only simulates in real time anyway)
        if (data[0] !== MSG.INPUT) return conn.strike(gs, 'unknown binary');
        const frames = decodeInput(data);
        players.receiveInput(gs, conn.player, frames);
        return undefined;
      }
      if (data.length > MAX_TEXT) return conn.strike(gs, 'text too big');
      if (!conn.text.take()) return conn.strike(gs, 'rate limit');
      const msg = JSON.parse(data.toString('utf8'));
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return conn.strike(gs, 'bad message');
      if (stage === 'create' && msg.t === 'ping') {
        // Keeps the connection alive while a new player picks a name.
        conn.sendJson({ t: 'pong', c: msg.c, s: Date.now(), tick: gs.tick });
        return undefined;
      }
      if (stage === 'auth' || stage === 'create') {
        if (busy) return undefined;
        busy = true;
        try {
          await (stage === 'auth' ? onAuth(msg) : onCreate(msg));
        } finally {
          busy = false;
        }
        return undefined;
      }
      let problem = commands.handle(gs, conn.player, msg);
      if (problem instanceof Promise) problem = await problem;
      if (conn.closed) return undefined;
      if (msg.rid !== undefined) conn.sendJson({ t: 'res', rid: msg.rid, ok: !problem, error: problem ?? undefined });
      else if (problem) conn.sendJson({ t: 'toast', text: problem, kind: 'warn' });
    } catch (err) {
      conn.strike(gs, `error: ${err.message}`);
    }
    return undefined;
  });

  ws.on('close', () => {
    conn.closed = true;
    clearTimeout(timer);
    release();
    if (conn.player && conn.player.conn === conn) {
      gs.log.info(`[leave] ${conn.player.name}`);
      gs.disconnect(conn.player);
    }
  });
  ws.on('error', () => {});
}
