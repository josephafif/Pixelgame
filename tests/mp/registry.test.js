// The server list: the Edge Function that registers servers players host,
// npm run share's side of it, and the lobby's helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, normalizeUrl, newCode, sha256Hex, CODE_ALPHABET } from '../../supabase/functions/game-servers/logic.js';
import { registerServer } from '../../scripts/share.mjs';
import { normalizeCode, serverUrlFrom, wsUrl, serverKey } from '../../src/mp/registry.js';

const SECRET = 'a'.repeat(43);
const INFO = { name: 'Annas server', protocol: 1, players: 2, maxPlayers: 50 };

function post(body) {
  return new Request('https://x.supabase.co/functions/v1/game-servers', { method: 'POST', body: JSON.stringify(body) });
}

function fakeDb() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    db: {
      async get(code) {
        calls.push(['get', code]);
        return rows.get(code) ?? null;
      },
      async insert(row) {
        calls.push(['insert', row.code]);
        if (rows.has(row.code)) throw { status: 409, code: '23505' };
        rows.set(row.code, { ...row, official: false });
      },
      async update(code, fields) {
        calls.push(['update', code]);
        Object.assign(rows.get(code), fields);
      },
      async offline(code, hash, before) {
        const row = rows.get(code);
        if (row && row.secret_hash === hash && !row.official) Object.assign(row, { last_seen: before, players: 0 });
      },
      async cleanup() {},
    },
  };
}

const pixelgame = (info = INFO) => async (url) => {
  assert.equal(url, 'https://brave-otter-quiet-river.trycloudflare.com/info');
  return { ok: true, json: async () => info };
};

test('register: a running Pixelgame server gets a code, and keeps it with its secret', async () => {
  const db = fakeDb();
  const url = 'https://brave-otter-quiet-river.trycloudflare.com';
  const res = await handle(post({ action: 'register', url, secret: SECRET, listed: true }), { fetch: pixelgame(), db: db.db });
  assert.equal(res.status, 200);
  const { code, name } = await res.json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(name, 'Annas server');
  const row = db.rows.get(code);
  assert.equal(row.url, url);
  assert.equal(row.listed, true);
  assert.equal(row.players, 2);
  assert.equal(row.max_players, 50);
  assert.equal(row.secret_hash, await sha256Hex(SECRET), 'only the hash is stored');
  assert.ok(!('secret' in row));
  // Next start: a new tunnel address, the same code.
  const again = await handle(post({ action: 'register', url: `${url}/`, secret: SECRET, code }), { fetch: pixelgame(), db: db.db });
  assert.equal((await again.json()).code, code);
  // Someone else can't take the code over.
  const thief = await handle(post({ action: 'register', url, secret: 'b'.repeat(43), code }), { fetch: pixelgame(), db: db.db });
  assert.equal(thief.status, 403);
  // Stopping hides it (seen a day ago), but only its owner can do that.
  await handle(post({ action: 'offline', code, secret: 'b'.repeat(43) }), { fetch: pixelgame(), db: db.db });
  assert.equal(db.rows.get(code).players, 2);
  await handle(post({ action: 'offline', code, secret: SECRET }), { fetch: pixelgame(), db: db.db });
  assert.equal(db.rows.get(code).players, 0);
  assert.ok(Date.parse(db.rows.get(code).last_seen) < Date.now() - 23 * 3600 * 1000);
  // The official server's row can never be taken over, even with its hash.
  db.rows.set('PXGAME', { code: 'PXGAME', secret_hash: await sha256Hex(SECRET), official: true });
  const official = await handle(post({ action: 'register', url, secret: SECRET, code: 'PXGAME' }), { fetch: pixelgame(), db: db.db });
  assert.equal(official.status, 403);
});

test('register: only addresses that answer like a Pixelgame server, and only public https names', async () => {
  const db = fakeDb();
  const reg = (url, fetchFn) => handle(post({ action: 'register', url, secret: SECRET }), { fetch: fetchFn, db: db.db });
  const notPixelgame = async () => ({ ok: true, json: async () => ({ hello: 'world' }) });
  assert.equal((await reg('https://brave-otter-quiet-river.trycloudflare.com', notPixelgame)).status, 422);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await reg('https://brave-otter-quiet-river.trycloudflare.com', down)).status, 422);
  for (const bad of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://example.com/path', 'https://u:p@example.com', 'ftp://x.y', 'nonsense']) {
    assert.equal((await reg(bad, pixelgame())).status, 400, bad);
  }
  assert.equal(db.rows.size, 0);
  // Bad secrets and codes are refused before anything else.
  assert.equal((await handle(post({ action: 'register', url: 'https://a.b', secret: 'short' }), { fetch: pixelgame(), db: db.db })).status, 400);
  assert.equal((await handle(post({ action: 'register', url: 'https://a.b', secret: SECRET, code: 'NOPE!' }), { fetch: pixelgame(), db: db.db })).status, 400);
  assert.equal((await handle(new Request('https://x/', { method: 'GET' }), { fetch: pixelgame(), db: db.db })).status, 405);
  assert.equal((await handle(new Request('https://x/', { method: 'OPTIONS' }), { fetch: pixelgame(), db: db.db })).status, 204);
});

test('codes and addresses', () => {
  assert.equal(normalizeUrl('https://Brave-Otter.trycloudflare.com/ws'), 'https://brave-otter.trycloudflare.com');
  assert.equal(normalizeUrl('https://spel.example.se:8443'), 'https://spel.example.se:8443');
  assert.equal(newCode(new Uint8Array([0, 1, 2, 31, 32, 255])), 'ABC9A9');
  assert.ok([...newCode()].every((c) => CODE_ALPHABET.includes(c)));
  // The lobby side.
  assert.equal(normalizeCode(' k7q-x2m '), 'K7QX2M');
  assert.equal(normalizeCode('K7QX2'), null);
  assert.equal(normalizeCode('K7QX2O'), null, 'no O (looks like 0)');
  assert.equal(serverUrlFrom('brave-otter.trycloudflare.com'), 'wss://brave-otter.trycloudflare.com/ws');
  assert.equal(serverUrlFrom('https://spel.example.se/'), 'wss://spel.example.se/ws');
  assert.equal(serverUrlFrom('ws://localhost:8787/ws'), 'ws://localhost:8787/ws');
  assert.equal(serverUrlFrom('javascript:alert(1)'), null);
  assert.equal(wsUrl('https://brave-otter.trycloudflare.com'), 'wss://brave-otter.trycloudflare.com/ws');
  assert.equal(serverKey({ code: 'K7QX2M', url: 'wss://a.b/ws' }), 'code:K7QX2M', 'guest logins follow the code, not the changing address');
  assert.equal(serverKey({ url: 'wss://a.b/ws' }), 'wss://a.b/ws');
});

test('npm run share registers through the Edge Function with its code and secret', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, code: 'K7QX2M' }) };
  };
  const host = { secret: SECRET, code: 'K7QX2M' };
  const code = await registerServer({ supabaseUrl: 'https://x.supabase.co/', key: 'sb_publishable_x', url: 'https://a-b.trycloudflare.com', host, listed: true, fetchFn });
  assert.equal(code, 'K7QX2M');
  assert.equal(seen[0].url, 'https://x.supabase.co/functions/v1/game-servers');
  assert.equal(seen[0].init.headers.apikey, 'sb_publishable_x');
  assert.deepEqual(seen[0].body, { action: 'register', url: 'https://a-b.trycloudflare.com', secret: SECRET, code: 'K7QX2M', listed: true });
  const failing = async () => ({ ok: false, status: 422, json: async () => ({ ok: false, error: 'The server does not answer like a Pixelgame server' }) });
  await assert.rejects(registerServer({ supabaseUrl: 'https://x.supabase.co', key: 'k', url: 'https://a-b.trycloudflare.com', host, fetchFn: failing }), /Pixelgame server/);
});
