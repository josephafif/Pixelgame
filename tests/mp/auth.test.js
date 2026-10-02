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
