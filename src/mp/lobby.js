// Multiplayer lobby (from the main menu): log in, pick a server, play.
// Joining reloads the page in multiplayer mode (?mp=play) so the
// single-player game and the multiplayer one never share state.

import { CONFIG } from '../config.js';
import { h, clear, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openModal, closeModal, replaceModalBody } from '../ui/modal.js';
import { PROTOCOL_VERSION } from '../net/protocol.js';
import { MpAuth, configuredServers, customServers, addServer, removeServer, infoUrl, sameOriginServer, loginWithPassword } from './auth.js';
import {
  registryEnabled, listServers, findServer, normalizeCode, serverUrlFrom, serverKey, recentCodes, rememberCode,
} from './registry.js';
import { passwordProblem } from '../net/rules.js';

const JOIN_KEY = 'pg-mp-join';
// Keep ?debug=1 across the reloads (network overlay, test hooks).
const DEBUG = new URLSearchParams(location.search).has('debug') ? '&debug=1' : '';

function mpConfig() {
  return CONFIG.mp ?? { servers: [], supabaseUrl: '', supabaseAnonKey: '' };
}

export function makeAuth() {
  return new MpAuth(mpConfig());
}

function redirectUrl() {
  return `${location.origin}${location.pathname}?mp=auth`;
}

async function probe(server) {
  const t0 = performance.now();
  try {
    const res = await fetch(infoUrl(server.url), { cache: 'no-store', signal: AbortSignal.timeout?.(4000) });
    if (!res.ok) throw new Error(String(res.status));
    const info = await res.json();
    return { ok: true, ping: Math.round(performance.now() - t0), ...info };
  } catch {
    return { ok: false };
  }
}

/** Opens the lobby (called from the main menu, or from a ?join=CODE / ?server=… link). */
export function openLobby(app, { message = null, joinCode = null, serverUrl = null } = {}) {
  const auth = makeAuth();
  const config = mpConfig();
  const local = sameOriginServer();
  if (serverUrl && !customServers().some((c) => c.url === serverUrl)) addServer(new URL(serverUrl).host, serverUrl);
  const state = {
    local: null, official: [], open: [], custom: customServers(),
    found: null, code: joinCode ?? '', codeError: null, codeBusy: false,
    infos: new Map(), error: message, busy: false, login: null, providers: {}, sent: null, email: '',
  };

  const probeAll = (list) => Promise.all(list.map(async (s) => {
    if (s.registry && !s.online) return;
    if (!state.infos.has(s.url)) {
      state.infos.set(s.url, await probe(s));
      rerender();
    }
  }));

  const refresh = async () => {
    const [registry, providers, localInfo] = await Promise.all([
      listServers(),
      auth.configured ? auth.providers() : {},
      local ? probe(local) : null,
    ]);
    state.providers = providers;
    if (localInfo?.ok) {
      state.local = local;
      state.infos.set(local.url, localInfo);
    }
    const official = configuredServers(config).filter((s) => s.official);
    for (const r of registry.filter((x) => x.official)) if (!official.some((o) => o.url === r.url)) official.push(r);
    state.official = official;
    state.open = registry.filter((x) => !x.official && !official.some((o) => o.url === x.url));
    state.custom = [...configuredServers(config).filter((s) => !s.official), ...customServers()];
    rerender();
    await probeAll([...state.official, ...state.open, ...state.custom]);
  };

  const join = (server, mode) => {
    const { name, url, code = null, official = false } = server;
    sessionStorage.setItem(JOIN_KEY, JSON.stringify({ server: { name, url, code, official, local: Boolean(server.local) }, mode }));
    location.href = `${location.pathname}?mp=play${DEBUG}`;
  };

  const lookUp = async (text) => {
    const code = normalizeCode(text);
    state.code = String(text ?? '');
    state.found = null;
    if (!code) {
      state.codeError = 'En kod har sex tecken, till exempel K7QX2M';
      rerender();
      return;
    }
    state.codeBusy = true;
    state.codeError = null;
    rerender();
    try {
      const server = await findServer(code);
      if (!server) state.codeError = `Ingen server har koden ${code}`;
      else {
        state.found = server;
        rememberCode(code, server.name);
      }
    } catch (err) {
      state.codeError = err.message;
    }
    state.codeBusy = false;
    rerender();
    if (state.found?.online) {
      state.infos.delete(state.found.url);
      await probeAll([state.found]);
    }
  };

  function accountSection() {
    if (!auth.configured) return null;
    const email = auth.email;
    if (email || auth.session) {
      return h('div.mp-account',
        h('p', 'Inloggad som ', h('b', email ?? 'ditt konto'), ' ',
          h('button.small', { onclick: () => { auth.signOut(); rerender(); } }, 'Logga ut')));
    }
    const p = state.providers ?? {};
    const emailOn = Boolean(config.emailLogin && p.email);
    if (!p.google && !p.discord && !emailOn) return null;
    const emailInput = h('input', { type: 'email', placeholder: 'din@epost.se', autocomplete: 'email', value: state.email ?? '' });
    const codeInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: '123456', maxlength: 10, autocomplete: 'one-time-code' });
    return h('div.mp-account',
      h('p.small.muted', 'Logga in med ett konto, så kan du spela med samma karaktär från alla dina enheter. Eller spela med namn och lösenord.'),
      h('div.mp-oauth',
        p.google ? h('button', { onclick: () => { location.href = auth.oauthUrl('google', redirectUrl()); } }, 'Logga in med Google') : null,
        p.discord ? h('button', { onclick: () => { location.href = auth.oauthUrl('discord', redirectUrl()); } }, 'Logga in med Discord') : null),
      emailOn ? h('div.mp-email',
        h('label.field', h('span', 'E-post'), emailInput),
        h('button.btn-primary', {
          disabled: state.busy,
          onclick: async () => {
            const value = emailInput.value.trim();
            if (!/^\S+@\S+\.\S+$/.test(value)) {
              state.error = 'Skriv en giltig e-postadress';
              rerender();
              return;
            }
            state.busy = true;
            state.email = value;
            try {
              await auth.sendEmail(value, redirectUrl());
              state.sent = value;
              state.error = null;
            } catch (err) {
              state.error = err.message;
            }
            state.busy = false;
            rerender();
          },
        }, 'Skicka inloggningsmejl')) : null,
      emailOn && state.sent ? h('div.mp-code',
        h('p.small', `Vi skickade ett mejl till ${state.sent}. Klicka på länken i det, eller skriv in koden här:`),
        h('label.field', h('span', 'Kod'), codeInput),
        h('button.btn-primary', {
          onclick: async () => {
            try {
              await auth.verifyCode(state.sent, codeInput.value);
              state.error = null;
              state.sent = null;
            } catch (err) {
              state.error = err.message;
            }
            rerender();
          },
        }, 'Logga in med koden')) : null);
  }

  function serverRow(s) {
    const info = state.infos.get(s.url);
    const offline = s.registry && !s.online;
    const status = offline ? h('span.muted', 'Inte igång just nu')
      : !info ? h('span.muted', 'Kollar…')
        : !info.ok ? h('span.warn', 'Svarar inte')
          : info.protocol !== PROTOCOL_VERSION ? h('span.warn', 'Annan version')
            : h('span', `${info.players}/${info.maxPlayers} spelare · ${info.ping} ms`);
    const ready = !offline && info?.ok && info.protocol === PROTOCOL_VERSION;
    // Your account's login token only ever goes to the official server: anyone can host the others.
    const accountOk = ready && s.official && info.supabase && auth.configured;
    const loggedIn = Boolean(auth.session);
    const key = serverKey(s);
    return h('div.mp-server',
      h('div.mp-server-head',
        h('b', info?.name ?? s.name),
        s.code && !s.official ? h('span.mp-code-tag', s.code) : null,
        s.local || s.code ? null : h('span.small.muted', s.url),
        status),
      ready && info.rules ? h('p.small.muted', `Raidfönster: ${info.rules.raidWindow}. Fristaden är säker, vildmarken är PvP.`) : null,
      offline ? h('p.small.muted', 'Be den som kör servern att starta den (npm run share). Koden är densamma nästa gång.') : null,
      h('div.row',
        accountOk && loggedIn ? h('button.btn-primary', { onclick: () => join(s, 'account') }, icon('players', 20), 'Spela') : null,
        ready && info.guests ? h(`button${accountOk && loggedIn ? '' : '.btn-primary'}`, { onclick: () => join(s, 'guest') },
          auth.guestToken(key) ? 'Fortsätt som gäst' : 'Spela som gäst') : null,
        ready && info.logins ? h('button', {
          'aria-expanded': String(state.login?.url === s.url),
          onclick: () => {
            state.login = state.login?.url === s.url ? null : { url: s.url, name: '', password: '', error: null };
            rerender();
            document.querySelector('.mp-login input')?.focus();
          },
        }, 'Logga in med namn') : null,
        s.custom ? h('button.btn-danger', { onclick: () => { removeServer(s.url); refresh(); } }, 'Ta bort') : null),
      ready && info.logins && state.login?.url === s.url ? loginForm(s) : null);
  }

  /** Name + password: your character from another link or device. */
  function loginForm(s) {
    const form = state.login;
    const name = h('input', { type: 'text', maxlength: 16, autocomplete: 'username', value: form.name, oninput: (e) => { form.name = e.target.value; } });
    const password = h('input', { type: 'password', maxlength: 64, autocomplete: 'current-password', value: form.password, oninput: (e) => { form.password = e.target.value; } });
    const submit = async () => {
      if (state.busy) return;
      if (form.name.trim().length < 3 || passwordProblem(form.password)) {
        form.error = 'Skriv ditt namn och ditt lösenord';
        rerender();
        return;
      }
      state.busy = true;
      try {
        const res = await loginWithPassword(s.url, form.name.trim(), form.password);
        auth.setGuestToken(serverKey(s), res.token);
        join(s, 'guest');
        return;
      } catch (err) {
        form.error = err.message;
        form.password = '';
      } finally {
        state.busy = false;
      }
      rerender();
    };
    for (const input of [name, password]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
    }
    return h('div.mp-login',
      h('p.small.muted', 'Har du spelat här förut, från en annan enhet? Logga in med namnet och lösenordet du valde.'),
      form.error ? h('p.warn', form.error) : null,
      h('div.mp-login-fields',
        h('label.field', h('span', 'Namn'), name),
        h('label.field', h('span', 'Lösenord'), password),
        h('button.btn-primary', { disabled: state.busy, onclick: submit }, 'Logga in')));
  }

  function friendsSection() {
    const input = h('input', {
      type: 'text', maxlength: 9, placeholder: 'K7QX2M', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
      value: state.code, 'aria-label': 'Serverns kod', oninput: (e) => { state.code = e.target.value; },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') lookUp(input.value);
    });
    const recent = recentCodes().filter((r) => r.code !== state.found?.code);
    const registry = registryEnabled();
    return h('section.mp-friends',
      h('h3', 'Spela på en väns server'),
      registry ? h('div.mp-join',
        h('label.field', h('span', 'Kod'), input),
        h('button.btn-primary', { disabled: state.codeBusy, onclick: () => lookUp(input.value) }, state.codeBusy ? 'Letar…' : 'Gå med')) : null,
      state.codeError ? h('p.warn', state.codeError) : null,
      state.found ? serverRow(state.found) : null,
      registry && recent.length ? h('div.mp-recent',
        h('span.small.muted', 'Senast:'),
        recent.map((r) => h('button.small', { onclick: () => lookUp(r.code) }, `${r.name || r.code} (${r.code})`))) : null,
      hostSection());
  }

  function hostSection() {
    const repo = config.repoUrl || 'https://github.com/josephafif/Pixelgame';
    return h('details.mp-host',
      h('summary', 'Starta en egen server'),
      h('p.small', 'Du kan köra en egen server på din dator, gratis och utan konto. Dina vänner går med här med en kod.'),
      h('ol.small',
        h('li', 'Installera Node.js 22 eller nyare från ', h('a', { href: 'https://nodejs.org', target: '_blank', rel: 'noopener' }, 'nodejs.org'), '.'),
        h('li', 'Hämta spelet från ', h('a', { href: repo, target: '_blank', rel: 'noopener' }, 'GitHub'), ' (Code → Download ZIP) och packa upp det.'),
        h('li', 'Öppna en terminal i mappen och kör ', h('code', 'npm install'), ' och sedan ', h('code', 'npm run share'), '.'),
        h('li', 'Du får en kod och en länk. Skicka dem till dina vänner. Koden är densamma varje gång du startar.')),
      h('p.small.muted', 'Vill du att alla ska se servern i listan här? Starta med ', h('code', 'npm run share -- --public'), '. Din dator måste vara på medan ni spelar.'));
  }

  function addSection() {
    const url = h('input', { type: 'text', placeholder: 'spel.example.se eller wss://spel.example.se/ws' });
    return h('details.mp-add',
      h('summary', 'Lägg till en server med adress'),
      h('label.field', h('span', 'Adress'), url),
      h('button', {
        onclick: () => {
          const v = serverUrlFrom(url.value);
          if (!v) {
            state.error = 'Skriv serverns adress, till exempel spel.example.se';
            rerender();
            return;
          }
          addServer(new URL(v).host, v);
          state.infos.delete(v);
          refresh();
        },
      }, 'Lägg till'));
  }

  function build() {
    const official = state.local ? [] : state.official;
    return h('div.mp-lobby',
      state.error ? h('p.warn', state.error) : null,
      state.local ? h('section', h('h3', 'Den här servern'), serverRow(state.local)) : null,
      official.length ? h('section.mp-official',
        h('h3', 'Officiell server'),
        accountSection(),
        official.map(serverRow)) : null,
      friendsSection(),
      state.open.length ? h('section', h('h3', 'Öppna servrar'), state.open.map(serverRow)) : null,
      state.custom.length ? h('section', h('h3', 'Dina servrar'), state.custom.map(serverRow)) : null,
      addSection(),
      h('section.mp-rules',
        h('h3', 'Så funkar det'),
        h('ul.small',
          h('li', 'En egen multiplayer-karaktär. Den sparas på servern, inte i din singleplayer-värld.'),
          h('li', 'Fristaden i mitten är säker. Ute i vildmarken kan spelare slåss.'),
          h('li', 'Nya spelare är skyddade de första två timmarna (eller tills de besegrat en boss).'),
          h('li', 'Bilda en klan, res ett klanbanér i vildmarken och bygg er bas tillsammans.'),
          h('li', 'En bas kan bara anfallas när någon i klanen är online, kort efter att ni loggat ut, eller under serverns raidfönster.'))));
  }

  function rerender() {
    replaceModalBody(build());
  }

  openModal({ title: 'Multiplayer', icon: 'players', body: build(), className: 'wide mp-lobby-panel' });
  refresh();
  if (joinCode) lookUp(joinCode);
}

/** ?mp=auth: back from Google/Discord/the e-mail link. */
export function handleAuthRedirect(app) {
  const auth = makeAuth();
  let message = null;
  try {
    auth.consumeRedirect();
  } catch (err) {
    message = `Inloggningen misslyckades: ${err.message}`;
  }
  history.replaceState(null, '', location.pathname);
  setTimeout(() => openLobby(app, { message }), 400);
}

/**
 * A new character's name. Guests also pick a password: guest identities
 * live in the browser, per address, so the password is how you get your
 * character back on a new link or another device.
 */
function namePrompt(msg, send, { guest = false, last = {}, hosted = false } = {}) {
  const input = h('input', { type: 'text', maxlength: 16, value: last.name ?? msg.suggestion ?? '', autocomplete: 'username', autofocus: true });
  const password = guest ? h('input', { type: 'password', maxlength: 64, autocomplete: 'new-password', value: last.password ?? '' }) : null;
  const error = h('p.warn', { hidden: !msg.error }, msg.error ?? '');
  const submit = () => {
    const name = input.value.trim();
    const pw = password?.value ?? '';
    const problem = password ? passwordProblem(pw) : null;
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      password.focus();
      return;
    }
    send(name, pw || undefined);
  };
  for (const el of [input, password]) {
    el?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }
  openModal({
    title: 'Välj ditt namn',
    locked: true,
    className: 'tutorial-panel',
    body: h('div.mp-name',
      h('p', 'Så här ser andra spelare dig. Du kan inte byta senare.'),
      error,
      h('label.field', h('span', 'Namn (3–16 tecken)'), input),
      password ? h('label.field', h('span', 'Lösenord (minst 4 tecken)'), password) : null,
      password ? h('p.small.muted', 'Med namnet och lösenordet kommer du tillbaka till din karaktär från en ny länk eller en annan enhet.') : null,
      password && hosted ? h('p.small.warn', 'Servern körs av en spelare. Använd inte ett lösenord som du har någon annanstans.') : null,
      h('button.btn-primary', { onclick: submit }, 'Börja spela')),
  });
}

function connectingModal(name) {
  openModal({
    title: 'Ansluter',
    locked: true,
    className: 'tutorial-panel',
    body: h('div.mp-connecting', h('p', `Ansluter till ${name}…`), h('div.splash-progress', h('div', { style: { width: '60%' } }))),
  });
}

function goMenu() {
  location.href = DEBUG ? `${location.pathname}?debug=1` : location.pathname;
}

function failModal(title, text, { retry = true } = {}) {
  openModal({
    title,
    locked: true,
    className: 'tutorial-panel',
    body: h('div.mp-fail',
      h('p', text),
      h('div.row',
        retry ? h('button.btn-primary', { onclick: () => location.reload() }, 'Anslut igen') : null,
        h('button', { onclick: goMenu }, 'Till huvudmenyn'))),
  });
}

/** ?mp=play: connect and start playing. */
export async function startMultiplayer(app) {
  const game = app.game;
  let join = null;
  try {
    join = JSON.parse(sessionStorage.getItem(JOIN_KEY) ?? 'null');
  } catch {
    join = null;
  }
  if (!join?.server?.url) {
    goMenu();
    return;
  }
  const auth = makeAuth();
  let token = null;
  const key = serverKey(join.server);
  if (join.mode === 'guest') token = auth.guestToken(key) ?? 'guest';
  else token = await auth.token();
  if (!token) {
    failModal('Logga in igen', 'Din inloggning har gått ut. Logga in i Multiplayer-menyn igen.', { retry: false });
    return;
  }
  connectingModal(join.server.name);
  game.on('disconnect', (info) => {
    const reason = info.reason || 'Anslutningen till servern bröts.';
    if (reason === 'update' || /uppdaterats/.test(reason)) failModal('Ny version', 'Spelet har uppdaterats. Ladda om sidan för att fortsätta.');
    else failModal('Frånkopplad', reason);
  });
  const last = {};
  try {
    await game.connect(join.server, token, {
      onGuestToken: (t) => auth.setGuestToken(key, t),
      onNeedName: (msg, send) => namePrompt(msg, (name, password) => {
        last.name = name;
        last.password = password;
        connectingModal(join.server.name);
        send(name, password);
      }, { guest: join.mode === 'guest', last, hosted: !join.server.official }),
    });
  } catch (err) {
    failModal('Kunde inte ansluta', err.message);
    return;
  }
  closeModal(true);
  $('#hud')?.removeAttribute('hidden');
  document.body.classList.add('mp');
  app.started = true;
  app.input.reset();
  game.start();
  const { MpHud } = await import('./hud-extra.js');
  app.mpHud = new MpHud(game, app);
  game.toast(`Välkommen till ${join.server.name}, ${game.myName}!`, 'component');
  if (!game.me || game.me.level <= 1) {
    game.schedule(2.5, () => game.toast('Du är i Fristaden (säker). Smedjan, förrådet och härden finns här. Pilen visar vägen till närmaste boss.', 'info'));
  }
  void clear;
}
