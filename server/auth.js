// Login tokens.
//
// Supabase: the browser logs in with Supabase Auth (e-mail link/code,
// Google, Discord) and sends its access token (a JWT) as the first message.
// We verify the signature ourselves: new projects sign with an asymmetric
// key published as JWKS (ES256/RS256); older ones with a shared secret
// (HS256, SUPABASE_JWT_SECRET). The account id is the token's `sub` — never
// anything the client says about itself.
//
// Guests: for local testing (and friends trying it out) the server can hand
// out its own signed guest tokens. Off by default when Supabase is set up.

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, randomBytes } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

export class AuthError extends Error {}

function parseJwt(token) {
  if (typeof token !== 'string' || token.length > 8192) throw new AuthError('Bad token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Bad token');
  let header;
  let payload;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch {
    throw new AuthError('Bad token');
  }
  return { header, payload, signed: `${parts[0]}.${parts[1]}`, sig: fromB64url(parts[2]) };
}

export class Auth {
  /**
   * @param {object} opts { supabaseUrl, supabaseJwtSecret, allowGuests, guestSecret, fetch }
   */
  constructor({ supabaseUrl = '', supabaseJwtSecret = '', allowGuests = false, guestSecret, fetch: fetchFn = globalThis.fetch } = {}) {
    this.supabaseUrl = supabaseUrl;
    this.jwtSecret = supabaseJwtSecret;
    this.allowGuests = allowGuests;
    this.guestSecret = guestSecret ?? randomBytes(32).toString('hex');
    this.fetch = fetchFn;
    this.jwks = null;
    this.jwksAt = 0;
  }

  get supabaseEnabled() {
    return Boolean(this.supabaseUrl || this.jwtSecret);
  }

  /** Verifies a token; returns { id, email, name, guest }. */
  async verify(token) {
    if (typeof token === 'string' && token.startsWith('guest.')) return this.#verifyGuest(token);
    if (!this.supabaseEnabled) throw new AuthError('This server only takes guests');
    const jwt = parseJwt(token);
    const { alg, kid } = jwt.header;
    let ok = false;
    if (alg === 'HS256') {
      if (!this.jwtSecret) throw new AuthError('Unsupported token');
      const mac = createHmac('sha256', this.jwtSecret).update(jwt.signed).digest();
      ok = mac.length === jwt.sig.length && timingSafeEqual(mac, jwt.sig);
    } else if (alg === 'ES256' || alg === 'RS256') {
      const jwk = await this.#key(kid);
      if (!jwk) throw new AuthError('Unknown signing key');
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      ok = alg === 'ES256'
        ? cryptoVerify('sha256', Buffer.from(jwt.signed), { key, dsaEncoding: 'ieee-p1363' }, jwt.sig)
        : cryptoVerify('sha256', Buffer.from(jwt.signed), key, jwt.sig);
    } else {
      throw new AuthError('Unsupported token');
    }
    if (!ok) throw new AuthError('Invalid token signature');
    const p = jwt.payload;
    const now = Math.floor(Date.now() / 1000);
    if (typeof p.exp !== 'number' || p.exp < now - 30) throw new AuthError('Token expired');
    if (p.aud && p.aud !== 'authenticated' && !(Array.isArray(p.aud) && p.aud.includes('authenticated'))) throw new AuthError('Wrong audience');
    if (this.supabaseUrl && p.iss && p.iss !== `${this.supabaseUrl}/auth/v1`) throw new AuthError('Wrong issuer');
    if (typeof p.sub !== 'string' || !p.sub) throw new AuthError('Token has no user');
    if (p.role && p.role !== 'authenticated') throw new AuthError('Not a user token');
    const meta = p.user_metadata ?? {};
    return {
      id: `sb:${p.sub}`,
      email: typeof p.email === 'string' ? p.email : null,
      name: typeof (meta.full_name ?? meta.name ?? meta.user_name) === 'string' ? (meta.full_name ?? meta.name ?? meta.user_name) : null,
      guest: false,
    };
  }

  async #key(kid) {
    const fresh = Date.now() - this.jwksAt < 10 * 60 * 1000;
    let key = fresh ? this.jwks?.find((k) => k.kid === kid) : null;
    if (key) return key;
    if (!this.supabaseUrl) return null;
    // Unknown key id: the project may have rotated keys, so fetch again
    // (at most every 30 seconds).
    if (Date.now() - this.jwksAt < 30 * 1000 && this.jwks) return this.jwks.find((k) => k.kid === kid) ?? null;
    const res = await this.fetch(`${this.supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) throw new AuthError(`Could not fetch signing keys (${res.status})`);
    const body = await res.json();
    this.jwks = Array.isArray(body.keys) ? body.keys : [];
    this.jwksAt = Date.now();
    key = this.jwks.find((k) => k.kid === kid) ?? (kid ? null : this.jwks[0]);
    return key ?? null;
  }

  // --- Guests ----------------------------------------------------------------------

  /** A new guest identity (kept by the browser, so a guest keeps their character). */
  issueGuest() {
    if (!this.allowGuests) throw new AuthError('Guests are not allowed on this server');
    const payload = { sub: randomBytes(12).toString('hex'), iat: Math.floor(Date.now() / 1000) };
    const body = b64url(JSON.stringify(payload));
    const sig = createHmac('sha256', this.guestSecret).update(body).digest('base64url');
    return `guest.${body}.${sig}`;
  }

  #verifyGuest(token) {
    if (!this.allowGuests) throw new AuthError('Guests are not allowed on this server');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('Bad guest token');
    const mac = createHmac('sha256', this.guestSecret).update(parts[1]).digest();
    const sig = fromB64url(parts[2]);
    if (mac.length !== sig.length || !timingSafeEqual(mac, sig)) throw new AuthError('Bad guest token');
    let payload;
    try {
      payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
      throw new AuthError('Bad guest token');
    }
    if (typeof payload.sub !== 'string' || !/^[0-9a-f]{24}$/.test(payload.sub)) throw new AuthError('Bad guest token');
    return { id: `guest:${payload.sub}`, email: null, name: null, guest: true };
  }
}
