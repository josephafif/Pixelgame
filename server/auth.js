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
// A guest can give their character a password; then they can log in again
// with name + password from any address or device (the browser forgets the
// guest token when the address changes, as it does with `npm run share`).

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, randomBytes, scrypt } from 'node:crypto';

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
    return this.guestTokenFor(`guest:${randomBytes(12).toString('hex')}`);
  }

  /** A guest token for an existing guest account (after logging in with a password). */
  guestTokenFor(accountId) {
    if (!this.allowGuests) throw new AuthError('Guests are not allowed on this server');
    const sub = /^guest:([0-9a-f]{24})$/.exec(accountId)?.[1];
    if (!sub) throw new AuthError('Not a guest account');
    const payload = { sub, iat: Math.floor(Date.now() / 1000) };
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

// --- Passwords -------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password, salt, len, opts) {
  return new Promise((resolve, reject) => scrypt(password, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Checked against when the name has no password, so a miss takes as long as a hit. */
export const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${'A'.repeat(22)}$${'A'.repeat(43)}`;

/** Slow, salted hash (scrypt, off the main thread so the game keeps ticking). */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password).normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(key)}`;
}

export async function checkPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const want = fromB64url(parts[5]);
  const key = await scryptAsync(String(password).normalize('NFKC'), fromB64url(parts[4]), want.length, { N, r, p, maxmem: SCRYPT.maxmem });
  return key.length === want.length && timingSafeEqual(key, want);
}

/**
 * Slows down password guessing: a few wrong tries from one address (or on
 * one name) and logins from there pause for a while. Also caps how many
 * slow hashes run at once.
 */
export class LoginGuard {
  constructor({ maxFails = 6, windowMs = 15 * 60 * 1000, maxBusy = 4 } = {}) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
    this.maxBusy = maxBusy;
    this.busy = 0;
    this.fails = new Map();
  }

  #entry(key, now) {
    const e = this.fails.get(key);
    if (!e || now - e.first > this.windowMs) return null;
    return e;
  }

  /** Null when a try is allowed, else a reason to give the player. */
  check(ip, name, now = Date.now()) {
    for (const key of [`ip:${ip}`, `name:${String(name).toLowerCase()}`]) {
      const e = this.#entry(key, now);
      if (e && e.count >= this.maxFails) {
        const minutes = Math.max(1, Math.ceil((e.first + this.windowMs - now) / 60000));
        return `För många felaktiga försök. Vänta ${minutes} min och försök igen.`;
      }
    }
    if (this.busy >= this.maxBusy) return 'Servern är upptagen, försök igen om en stund.';
    return null;
  }

  fail(ip, name, now = Date.now()) {
    if (this.fails.size > 5000) {
      for (const [k, e] of this.fails) if (now - e.first > this.windowMs) this.fails.delete(k);
    }
    for (const key of [`ip:${ip}`, `name:${String(name).toLowerCase()}`]) {
      const e = this.#entry(key, now) ?? { first: now, count: 0 };
      e.count++;
      this.fails.set(key, e);
    }
  }

  succeed(ip, name) {
    this.fails.delete(`ip:${ip}`);
    this.fails.delete(`name:${String(name).toLowerCase()}`);
  }
}
