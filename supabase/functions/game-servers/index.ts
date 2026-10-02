// Edge Function: register servers that players host themselves (see logic.js).
// It writes public.game_servers with the project's secret key; nobody else
// can. Deploy without JWT checks (the host's own secret is the authorization):
//   supabase functions deploy game-servers --no-verify-jwt

import { handle, CORS } from './logic.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch {
    // fall back to the legacy key
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

/** A PostgREST call on the game_servers table with the secret key. */
async function rest(method: string, query: string, body?: unknown) {
  const key = secretKey();
  const headers: Record<string, string> = { apikey: key, 'content-type': 'application/json', prefer: 'return=minimal' };
  // Legacy keys are JWTs and go in Authorization too; new secret keys must not.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/game_servers${query}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { status: res.status, code: err.code, message: err.message };
  }
  return method === 'GET' ? res.json() : null;
}

const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

const db = {
  async get(code: string) {
    const rows = await rest('GET', `?select=code,secret_hash,official&code=${eq(code)}`);
    return rows[0] ?? null;
  },
  insert: (row: Record<string, unknown>) => rest('POST', '', row),
  update: (code: string, fields: Record<string, unknown>) => rest('PATCH', `?code=${eq(code)}`, fields),
  offline: (code: string, hash: string, before: string) =>
    rest('PATCH', `?code=${eq(code)}&secret_hash=${eq(hash)}&official=is.false`, { last_seen: before, players: 0 }),
  cleanup: (before: string) => rest('DELETE', `?official=is.false&last_seen=lt.${encodeURIComponent(before)}`),
};

Deno.serve(async (req: Request) => {
  try {
    return await handle(req, { fetch, db });
  } catch (err) {
    console.error('game-servers', err);
    return new Response(JSON.stringify({ ok: false, error: 'Server error' }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
  }
});
