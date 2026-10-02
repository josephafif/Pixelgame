// Edge Function: register servers that players host themselves (see logic.js).
// Deploy without JWT checks (the host's secret is the authorization):
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

async function rpc(name: string, args: Record<string, unknown>) {
  const key = secretKey();
  const headers: Record<string, string> = { apikey: key, 'content-type': 'application/json' };
  // Legacy keys are JWTs and go in Authorization too; new secret keys must not.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw { status: res.status, code: body.code, message: body.message };
  }
  return res.status === 204 ? null : res.json();
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req, { fetch, rpc });
  } catch (err) {
    console.error('game-servers', err);
    return new Response(JSON.stringify({ ok: false, error: 'Server error' }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } });
  }
});
