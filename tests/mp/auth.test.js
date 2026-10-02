import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { Auth } from '../../server/auth.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function hs256(payload, secret) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);

test('guest tokens are signed and can not be forged', async () => {
  const auth = new Auth({ allowGuests: true, guestSecret: 'x'.repeat(32) });
  const token = auth.issueGuest();
  const who = await auth.verify(token);
  assert.equal(who.guest, true);
  assert.match(who.id, /^guest:[0-9a-f]{24}$/);
  const [p, body] = token.split('.').slice(0, 2);
  await assert.rejects(auth.verify(`${p}.${body}.AAAA`));
  const other = new Auth({ allowGuests: true, guestSecret: 'y'.repeat(32) });
  await assert.rejects(other.verify(token));
  const closed = new Auth({ allowGuests: false, guestSecret: 'x'.repeat(32) });
  await assert.rejects(closed.verify(token));
});

test('Supabase HS256 tokens: valid, expired, tampered', async () => {
  const secret = 'super-secret-jwt-key-for-tests-only';
  const auth = new Auth({ supabaseUrl: 'https://abc.supabase.co', supabaseJwtSecret: secret });
  const good = hs256({ sub: 'user-1', aud: 'authenticated', role: 'authenticated', exp: now() + 600, iss: 'https://abc.supabase.co/auth/v1', email: 'a@b.se' }, secret);
  const who = await auth.verify(good);
  assert.equal(who.id, 'sb:user-1');
  assert.equal(who.email, 'a@b.se');
  await assert.rejects(auth.verify(hs256({ sub: 'u', aud: 'authenticated', exp: now() - 3600 }, secret)), /expired/);
  await assert.rejects(auth.verify(hs256({ sub: 'u', aud: 'authenticated', exp: now() + 60 }, 'wrong')), /signature/);
  await assert.rejects(auth.verify(hs256({ sub: 'u', aud: 'authenticated', exp: now() + 60, iss: 'https://evil.example/auth/v1' }, secret)), /issuer/);
  await assert.rejects(auth.verify(hs256({ sub: 'u', aud: 'authenticated', role: 'service_role', exp: now() + 60 }, secret)));
  await assert.rejects(auth.verify('not.a.token'));
});

test('Supabase ES256 tokens are checked against the published keys (JWKS)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig' };
  let fetched = 0;
  const fetchStub = async (url) => {
    fetched++;
    assert.equal(url, 'https://abc.supabase.co/auth/v1/.well-known/jwks.json');
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  const auth = new Auth({ supabaseUrl: 'https://abc.supabase.co', fetch: fetchStub });
  const make = (payload, key = privateKey, kid = 'key-1') => {
    const head = b64({ alg: 'ES256', typ: 'JWT', kid });
    const body = b64(payload);
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  const payload = { sub: 'user-2', aud: 'authenticated', role: 'authenticated', exp: now() + 600, iss: 'https://abc.supabase.co/auth/v1' };
  assert.equal((await auth.verify(make(payload))).id, 'sb:user-2');
  assert.equal((await auth.verify(make(payload))).id, 'sb:user-2');
  assert.equal(fetched, 1, 'keys are cached');
  const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  await assert.rejects(auth.verify(make(payload, stranger)), /signature/);
  await assert.rejects(auth.verify(make(payload, privateKey, 'unknown')));
});

test('Supabase RS256 tokens work too', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256', use: 'sig' };
  const auth = new Auth({ supabaseUrl: 'https://abc.supabase.co', fetch: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) });
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'rsa-1' });
  const body = b64({ sub: 'user-3', aud: 'authenticated', exp: now() + 600 });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  assert.equal((await auth.verify(`${head}.${body}.${sig}`)).id, 'sb:user-3');
  await assert.rejects(auth.verify(`${head}.${body}.${sig.slice(0, -4)}AAAA`), /signature/);
});

test('HS256 without the project secret: Supabase is asked whose token it is', async () => {
  const token = hs256({ sub: 'user-4', aud: 'authenticated', exp: now() + 600 }, 'unknown-secret');
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, key: init.headers.apikey });
    return init.headers.authorization === `Bearer ${token}`
      ? { ok: true, status: 200, json: async () => ({ id: 'user-4' }) }
      : { ok: false, status: 401, json: async () => ({}) };
  };
  const auth = new Auth({ supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: 'sb_publishable_x', fetch: fetchStub });
  assert.equal((await auth.verify(token)).id, 'sb:user-4');
  assert.deepEqual(calls[0], { url: 'https://abc.supabase.co/auth/v1/user', auth: `Bearer ${token}`, key: 'sb_publishable_x' });
  const forged = hs256({ sub: 'user-4', aud: 'authenticated', exp: now() + 600 }, 'attacker');
  await assert.rejects(auth.verify(forged), /signature/);
  // Without a key to ask with, an HS256 token can't be checked at all.
  await assert.rejects(new Auth({ supabaseUrl: 'https://abc.supabase.co' }).verify(token), /Unsupported/);
});

test('passwords: salted scrypt hashes, checked in constant time', async () => {
  const { hashPassword, checkPassword, DUMMY_HASH } = await import('../../server/auth.js');
  const a = await hashPassword('hemligt');
  const b = await hashPassword('hemligt');
  assert.notEqual(a, b, 'a new salt every time');
  assert.equal(await checkPassword('hemligt', a), true);
  assert.equal(await checkPassword('Hemligt', a), false);
  assert.equal(await checkPassword('hemligt', null), false);
  assert.equal(await checkPassword('hemligt', 'garbage'), false);
  assert.equal(await checkPassword('', DUMMY_HASH), false);
});

test('login guard: wrong passwords from one address or on one name pause logins', async () => {
  const { LoginGuard } = await import('../../server/auth.js');
  const g = new LoginGuard({ maxFails: 3, windowMs: 60000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) {
    assert.equal(g.check('1.1.1.1', 'Anna', t0), null);
    g.fail('1.1.1.1', 'Anna', t0);
  }
  assert.match(g.check('1.1.1.1', 'Bertil', t0), /Vänta 1 min/);
  assert.match(g.check('2.2.2.2', 'anna', t0), /För många/, 'the name is paused for everyone');
  assert.equal(g.check('2.2.2.2', 'Bertil', t0), null);
  assert.equal(g.check('1.1.1.1', 'Anna', t0 + 61000), null, 'the pause ends');
  g.busy = 4;
  assert.match(g.check('3.3.3.3', 'Cilla', t0), /upptagen/);
});

test('guest tokens for an existing guest account', async () => {
  const auth = new Auth({ allowGuests: true, guestSecret: 'x'.repeat(32) });
  const id = 'guest:0123456789abcdef01234567';
  assert.equal((await auth.verify(auth.guestTokenFor(id))).id, id);
  assert.throws(() => auth.guestTokenFor('sb:user-1'), /Not a guest/);
  assert.throws(() => new Auth({ allowGuests: false }).guestTokenFor(id), /not allowed/);
});

test('local requests: only the server computer itself, never through a tunnel', async () => {
  const { isLocalRequest } = await import('../../server/net.js');
  const req = (addr, headers) => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:8787' })), true);
  assert.equal(isLocalRequest(req('::1', { host: '[::1]:8787' })), true);
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1', { host: '127.0.0.1:8787' })), true);
  assert.equal(isLocalRequest(req('192.168.1.5', { host: 'localhost:8787' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'brave-otter.trycloudflare.com' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:8787', 'cf-ray': '8a1b' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:8787', 'cf-connecting-ip': '1.2.3.4' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:8787', 'x-forwarded-for': '1.2.3.4' })), false);
});

test('npm run share: the right cloudflared for each computer, and the link in its log', async () => {
  const { cloudflaredAsset, tunnelUrl } = await import('../../scripts/share.mjs');
  assert.equal(cloudflaredAsset('win32', 'x64').file, 'cloudflared-windows-amd64.exe');
  assert.equal(cloudflaredAsset('win32', 'arm64').file, 'cloudflared-windows-amd64.exe');
  assert.equal(cloudflaredAsset('darwin', 'arm64').file, 'cloudflared-darwin-arm64.tgz');
  assert.equal(cloudflaredAsset('darwin', 'x64').tgz, true);
  assert.equal(cloudflaredAsset('linux', 'arm64').file, 'cloudflared-linux-arm64');
  assert.equal(cloudflaredAsset('freebsd', 'x64'), null);
  assert.equal(tunnelUrl('2026-10-02T12:00:00Z INF |  https://brave-otter-quiet-river.trycloudflare.com      |'), 'https://brave-otter-quiet-river.trycloudflare.com');
  assert.equal(tunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null);
});
