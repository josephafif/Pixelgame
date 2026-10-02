// Multiplayer login. Supabase Auth over plain HTTPS (no SDK needed):
// e-mail (a magic link, or the 6-digit code from the same e-mail — the code
// works best in an installed app), Google and Discord. Sessions are kept in
// localStorage and refreshed before they expire.
//
// Servers that allow guests hand out their own guest token; it is kept per
// server so a guest keeps their character.

const SESSION_KEY = 'pg-mp-session';
const GUEST_PREFIX = 'pg-mp-guest:';

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: the login just won't be remembered.
  }
}

/** Reads the e-mail out of a JWT (for "logged in as …"). */
function claims(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch {
    return {};
  }
}

export class MpAuth {
  constructor({ supabaseUrl = '', supabaseAnonKey = '' } = {}) {
    this.url = supabaseUrl.replace(/\/+$/, '');
    this.key = supabaseAnonKey;
  }

  get configured() {
    return Boolean(this.url && this.key);
  }

  get session() {
    return read(SESSION_KEY);
  }

  get email() {
    const s = this.session;
    return s ? s.email ?? claims(s.access_token).email ?? null : null;
  }

  #store(body) {
    const c = claims(body.access_token);
    const session = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at ?? (c.exp ? c.exp : Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600)),
      email: body.user?.email ?? c.email ?? null,
    };
    write(SESSION_KEY, session);
    return session;
  }

  async #post(path, body) {
    const res = await fetch(`${this.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: this.key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.msg ?? json.error_description ?? json.message ?? `Fel ${res.status}`);
    return json;
  }

  /** Sends the login e-mail (a link and, if the template has it, a code). */
  async sendEmail(email, redirectTo) {
    if (!this.configured) throw new Error('Inloggning med e-post är inte inställd');
    await fetch(`${this.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      headers: { apikey: this.key, 'content-type': 'application/json' },
      body: JSON.stringify({ email, create_user: true }),
    }).then(async (res) => {
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.msg ?? json.error_description ?? `Fel ${res.status}`);
      }
    });
  }

  /** Logs in with the 6-digit code from the e-mail. */
  async verifyCode(email, code) {
    const body = await this.#post('verify', { type: 'email', email, token: String(code).trim() });
    return this.#store(body);
  }

  /** Where to send the browser for Google/Discord. */
  oauthUrl(provider, redirectTo) {
    return `${this.url}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(redirectTo)}`;
  }

  /**
   * After a login redirect the tokens are in the URL fragment
   * (#access_token=…&refresh_token=…). Stores them and cleans the URL.
   */
  consumeRedirect() {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const error = params.get('error_description');
    if (error) {
      history.replaceState(null, '', location.pathname + location.search);
      throw new Error(error);
    }
    const access = params.get('access_token');
    if (!access) return null;
    const session = this.#store({
      access_token: access,
      refresh_token: params.get('refresh_token'),
      expires_at: Number(params.get('expires_at')) || undefined,
      expires_in: params.get('expires_in'),
    });
    history.replaceState(null, '', location.pathname + location.search);
    return session;
  }

  /** A valid access token (refreshed when it is about to expire), or null. */
  async token() {
    let s = this.session;
    if (!s) return null;
    if (s.expires_at - Date.now() / 1000 < 120) {
      try {
        s = this.#store(await this.#post('token?grant_type=refresh_token', { refresh_token: s.refresh_token }));
      } catch {
        write(SESSION_KEY, null);
        return null;
      }
    }
    return s.access_token;
  }

  signOut() {
    const s = this.session;
    write(SESSION_KEY, null);
    if (s && this.configured) {
      fetch(`${this.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.key, authorization: `Bearer ${s.access_token}` } }).catch(() => {});
    }
  }

  // --- Guests ---------------------------------------------------------------------

  guestToken(serverUrl) {
    return read(GUEST_PREFIX + serverUrl);
  }

  setGuestToken(serverUrl, token) {
    write(GUEST_PREFIX + serverUrl, token);
  }
}

/** The servers to show: configured ones, ones the player added, and this site's own. */
export function serverList(config) {
  const out = [...(config.servers ?? [])];
  for (const s of read('pg-mp-servers') ?? []) if (!out.some((o) => o.url === s.url)) out.push({ ...s, custom: true });
  return out;
}

export function addServer(name, url) {
  const list = read('pg-mp-servers') ?? [];
  if (!list.some((s) => s.url === url)) list.push({ name, url });
  write('pg-mp-servers', list);
}

export function removeServer(url) {
  write('pg-mp-servers', (read('pg-mp-servers') ?? []).filter((s) => s.url !== url));
}

/** http(s) URL of a server's info endpoint from its WebSocket URL. */
export function infoUrl(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = `${u.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '')}/info`;
  u.search = '';
  return u.toString();
}

/** This page's own server (when the game is served by the game server, e.g. `npm run mp`). */
export function sameOriginServer() {
  if (!/^https?:$/.test(location.protocol)) return null;
  if (!document.querySelector('meta[name="pixelgame-server"]')) return null;
  return { name: 'Den här servern', url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, local: true };
}
