// The server registry in Supabase (see supabase/migrations): the official
// server, servers players host and list publicly, and any hosted server by
// its join code. Servers hosted with `npm run share` keep their code even
// though their address changes every time they start.

import { CONFIG } from '../config.js';

const RECENT_KEY = 'pg-mp-codes';
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

function cfg() {
  return CONFIG.mp ?? {};
}

export function registryEnabled() {
  return Boolean(cfg().supabaseUrl && cfg().supabaseAnonKey);
}

async function rpc(name, args = {}) {
  const { supabaseUrl, supabaseAnonKey: key } = cfg();
  const headers = { apikey: key, 'content-type': 'application/json' };
  // Legacy anon keys are JWTs and also go in Authorization; publishable keys must not.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store', signal: AbortSignal.timeout?.(6000),
  });
  if (res.status === 404) throw new Error('Serverlistan är inte uppsatt än');
  if (!res.ok) throw new Error(`Serverlistan svarade ${res.status}`);
  return res.json();
}

/** wss://host/ws for a server's https://host (or ws:// for plain http, when testing locally). */
export function wsUrl(httpUrl) {
  const u = new URL(httpUrl);
  return `${u.protocol === 'http:' ? 'ws' : 'wss'}://${u.host}/ws`;
}

function fromRow(r) {
  return {
    name: r.name, url: wsUrl(r.url), code: r.code, official: Boolean(r.official), online: Boolean(r.online), registry: true,
  };
}

/** The official server(s) and the public servers that are running now. Empty if the list can't be reached. */
export async function listServers() {
  if (!registryEnabled()) return [];
  try {
    const rows = await rpc('list_game_servers');
    return Array.isArray(rows) ? rows.map(fromRow) : [];
  } catch {
    return [];
  }
}

/** A server by its join code, or null. Throws when the list can't be reached. */
export async function findServer(code) {
  if (!registryEnabled()) throw new Error('Koder fungerar inte i den här versionen av spelet');
  const rows = await rpc('find_game_server', { p_code: code });
  return Array.isArray(rows) && rows[0] ? fromRow(rows[0]) : null;
}

/** "k7q x2m" → "K7QX2M", or null if it can't be a code. */
export function normalizeCode(text) {
  const code = String(text ?? '').toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

/** A server address in any form people paste (host, https://host, wss://host/ws) → its WebSocket URL. */
export function serverUrlFrom(text) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!['https:', 'http:', 'wss:', 'ws:'].includes(u.protocol) || !u.hostname) return null;
    const secure = u.protocol === 'https:' || u.protocol === 'wss:';
    return `${secure ? 'wss' : 'ws'}://${u.host}/ws`;
  } catch {
    return null;
  }
}

/** Where a guest's token for this server is kept: by code when it has one (its address may change). */
export function serverKey(server) {
  return server.code ? `code:${server.code}` : server.url;
}

// --- Codes you have used ---------------------------------------------------------------

export function recentCodes() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((r) => normalizeCode(r?.code)) : [];
  } catch {
    return [];
  }
}

export function rememberCode(code, name) {
  const list = [{ code, name: String(name ?? '').slice(0, 40) }, ...recentCodes().filter((r) => r.code !== code)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // private mode
  }
}

export function forgetCode(code) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentCodes().filter((r) => r.code !== code)));
  } catch {
    // private mode
  }
}
