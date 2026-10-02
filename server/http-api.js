// The server's small HTTP API, the same on Node and on Cloudflare:
//   GET  /health   how the world is doing (for uptime monitors)
//   GET  /info     name, players and rules (the lobby shows these)
//   POST /login    name + password → a guest token for that character
// Each runtime turns its own request into { method, path, origin, ip, text() }
// and writes back the { status, headers, body } it gets.

import { AuthError, LoginGuard, checkPassword, DUMMY_HASH } from './auth.js';
import { serverInfo } from './net.js';

const MAX_LOGIN_BODY = 1024;

export function createApi(gs, auth, config, log) {
  const guard = new LoginGuard();
  const startedAt = Date.now();

  const cors = (origin) => {
    if (!origin) return {};
    if (config.origins.length && !config.origins.includes(origin)) return {};
    return { 'access-control-allow-origin': origin, vary: 'origin' };
  };
  const json = (status, body, origin) => ({
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) },
    body: JSON.stringify(body),
  });

  async function login(req) {
    const reply = (status, body) => json(status, body, req.origin);
    if (!auth.allowGuests) return reply(403, { ok: false, error: 'Den här servern använder inloggning med konto' });
    const raw = await req.text();
    if (raw.length > MAX_LOGIN_BODY) return reply(413, { ok: false, error: 'För stort' });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { ok: false, error: 'Ogiltig förfrågan' });
    }
    const name = String(body?.name ?? '').trim().slice(0, 32);
    const password = String(body?.password ?? '').slice(0, 64);
    const wait = guard.check(req.ip, name);
    if (wait) return reply(429, { ok: false, error: wait });
    const account = name ? gs.db.accountByName(name) : null;
    guard.busy++;
    let ok = false;
    try {
      // Unknown names cost as much time as wrong passwords (no name probing by timing).
      ok = await checkPassword(password, account?.pass_hash ?? DUMMY_HASH)
        && Boolean(account?.pass_hash) && account.id.startsWith('guest:');
    } finally {
      guard.busy--;
    }
    if (!ok) {
      guard.fail(req.ip, name);
      log.info(`[login] failed for "${name}" from ${req.ip}`);
      return reply(401, { ok: false, error: 'Fel namn eller lösenord' });
    }
    guard.succeed(req.ip, name);
    try {
      return reply(200, { ok: true, name: account.name, token: auth.guestTokenFor(account.id) });
    } catch (err) {
      return reply(403, { ok: false, error: err instanceof AuthError ? err.message : 'Kunde inte logga in' });
    }
  }

  /** Answers an API request, or returns null when the path isn't the API's. */
  return async function api(req, extraHealth = {}) {
    if (req.path === '/health') {
      let online = 0;
      for (const p of gs.players.values()) if (p.conn) online++;
      return json(200, {
        ok: true, tick: gs.tick, players: online, bodies: gs.players.size - online, enemies: gs.enemies.size,
        projectiles: gs.projectiles.size, tickMs: Math.round(gs.stats.tickMs * 100) / 100, maxTickMs: Math.round(gs.stats.maxTickMs * 100) / 100,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        ...extraHealth,
      }, req.origin);
    }
    if (req.path === '/info') return json(200, serverInfo(gs, auth, config), req.origin);
    if (req.path === '/login') {
      if (req.method === 'OPTIONS') {
        return {
          status: 204,
          headers: { ...cors(req.origin), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' },
          body: null,
        };
      }
      if (req.method !== 'POST') return { status: 405, headers: { allow: 'POST' }, body: null };
      try {
        return await login(req);
      } catch (err) {
        log.error('[login]', err);
        return { status: 500, headers: {}, body: null };
      }
    }
    return null;
  };
}
