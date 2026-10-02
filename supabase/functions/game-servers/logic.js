// The game-servers Edge Function's logic, kept free of Deno so tests can run
// it in Node. A player's own server (`npm run share`) registers here:
//
//   POST { action: 'register', url, secret, code?, listed }  → { ok, code }
//   POST { action: 'offline', code, secret }                 → { ok }
//
// `secret` stays with the host and proves it owns its code; only its hash is
// stored. Before a server is listed, its /info must answer like a Pixelgame
// server, so the list can't be filled with other sites.

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_BODY = 2048;

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, apikey, authorization, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

export function newCode(bytes = crypto.getRandomValues(new Uint8Array(6))) {
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** https://host[:port] of a public server, or null. */
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '/ws') return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null; // a name with a dot (no IPs, no localhost)
  if (/^\d+(\.\d+)+$/.test(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return null;
  return `https://${host}${u.port ? `:${u.port}` : ''}`;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : 0);

/** The server's own /info, if it answers like a Pixelgame server. */
export async function probe(fetchFn, url) {
  try {
    const res = await fetchFn(`${url}/info`, { signal: AbortSignal.timeout(6000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const info = await res.json();
    if (!Number.isInteger(info?.protocol) || info.protocol < 1 || info.protocol > 1000) return null;
    const name = typeof info.name === 'string' ? info.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
    if (!name) return null;
    return { name, protocol: info.protocol, players: int(info.players, 1000), maxPlayers: int(info.maxPlayers, 1000) };
  } catch {
    return null;
  }
}

/**
 * @param {Request} req
 * @param {{ fetch: typeof fetch, rpc: (name: string, args: object) => Promise<any> }} deps
 *   rpc throws { status, code } when the database says no.
 */
export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  const text = await req.text();
  if (text.length > MAX_BODY) return reply(413, { ok: false, error: 'Too large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { ok: false, error: 'Bad JSON' });
  }
  const secret = String(body?.secret ?? '');
  if (!SECRET_RE.test(secret)) return reply(400, { ok: false, error: 'Bad secret' });
  const given = body.code ? String(body.code).toUpperCase() : null;
  if (given && !CODE_RE.test(given)) return reply(400, { ok: false, error: 'Bad code' });
  const secretHash = await sha256Hex(secret);

  if (body.action === 'offline') {
    if (!given) return reply(400, { ok: false, error: 'Bad code' });
    await deps.rpc('game_server_offline', { p_code: given, p_secret_hash: secretHash });
    return reply(200, { ok: true });
  }
  if (body.action !== 'register') return reply(400, { ok: false, error: 'Unknown action' });
  const url = normalizeUrl(body.url);
  if (!url) return reply(400, { ok: false, error: 'The address must be https://name.domain' });
  const info = await probe(deps.fetch, url);
  if (!info) return reply(422, { ok: false, error: 'The server does not answer like a Pixelgame server' });
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = given ?? newCode();
    try {
      await deps.rpc('upsert_game_server', {
        p_code: code, p_secret_hash: secretHash, p_url: url, p_name: info.name, p_listed: Boolean(body.listed),
        p_players: info.players, p_max_players: info.maxPlayers, p_protocol: info.protocol,
      });
      return reply(200, { ok: true, code, name: info.name });
    } catch (err) {
      // A new random code that happens to be taken: draw another.
      const taken = err?.code === '42501' || err?.code === '23505';
      if (taken && !given) continue;
      if (err?.code === '42501') return reply(403, { ok: false, error: 'That code belongs to another server' });
      throw err;
    }
  }
  return reply(503, { ok: false, error: 'Try again' });
}
