// Multiplayer lobby (from the main menu): log in, pick a server, play.
// Joining reloads the page in multiplayer mode (?mp=play) so the
// single-player game and the multiplayer one never share state.

import { CONFIG } from '../config.js';
import { h, clear, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openModal, closeModal, replaceModalBody } from '../ui/modal.js';
import { PROTOCOL_VERSION } from '../net/protocol.js';
import { MpAuth, serverList, addServer, removeServer, infoUrl, sameOriginServer } from './auth.js';

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

/** Opens the lobby (called from the main menu). */
export function openLobby(app, { message = null } = {}) {
  const auth = makeAuth();
  const local = sameOriginServer();
  const state = { servers: [], infos: new Map(), sent: null, error: message, busy: false };

  const refreshServers = async () => {
    const list = serverList(mpConfig());
    // The page's own origin hosts a server when you play with `npm run mp`.
    if (local && !list.some((s) => s.url === local.url)) {
      const info = await probe(local);
      if (info.ok) {
        list.unshift(local);
        state.infos.set(local.url, info);
      }
    }
    state.servers = list;
    rerender();
    await Promise.all(list.map(async (s) => {
      if (!state.infos.has(s.url)) {
        state.infos.set(s.url, await probe(s));
        rerender();
      }
    }));
  };

  const join = (server, mode) => {
    sessionStorage.setItem(JOIN_KEY, JSON.stringify({ server: { name: server.name, url: server.url }, mode }));
    location.href = `${location.pathname}?mp=play${DEBUG}`;
  };

  function accountSection() {
    if (!auth.configured) {
      return h('section.mp-account',
        h('h3', 'Konto'),
        h('p.small.muted', 'Inloggning med konto är inte inställd för den här versionen av spelet. Du kan spela som gäst på servrar som tillåter det.'));
    }
    const email = auth.email;
    if (email || auth.session) {
      return h('section.mp-account',
        h('h3', 'Konto'),
        h('p', 'Inloggad som ', h('b', email ?? 'ditt konto')),
        h('button', { onclick: () => { auth.signOut(); rerender(); } }, 'Logga ut'));
    }
    const emailInput = h('input', { type: 'email', placeholder: 'din@epost.se', autocomplete: 'email', value: state.email ?? '' });
    const codeInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: '123456', maxlength: 10, autocomplete: 'one-time-code' });
    return h('section.mp-account',
      h('h3', 'Logga in'),
      h('p.small.muted', 'Ditt multiplayer-konto: din karaktär och dina vapen sparas på servern. Din singleplayer-värld påverkas inte.'),
      h('div.mp-oauth',
        h('button', { onclick: () => { location.href = auth.oauthUrl('google', redirectUrl()); } }, 'Logga in med Google'),
        h('button', { onclick: () => { location.href = auth.oauthUrl('discord', redirectUrl()); } }, 'Logga in med Discord')),
      h('div.mp-email',
        h('label.field', h('span', 'E-post'), emailInput),
        h('button.btn-primary', {
          disabled: state.busy,
          onclick: async () => {
            const email = emailInput.value.trim();
            if (!/^\S+@\S+\.\S+$/.test(email)) {
              state.error = 'Skriv en giltig e-postadress';
              rerender();
              return;
            }
            state.busy = true;
            state.email = email;
            try {
              await auth.sendEmail(email, redirectUrl());
              state.sent = email;
              state.error = null;
            } catch (err) {
              state.error = err.message;
            }
            state.busy = false;
            rerender();
          },
        }, 'Skicka inloggningsmejl')),
      state.sent ? h('div.mp-code',
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
    const loggedIn = Boolean(auth.session);
    const status = !info ? h('span.muted', 'Kollar…')
      : !info.ok ? h('span.warn', 'Svarar inte')
        : info.protocol !== PROTOCOL_VERSION ? h('span.warn', 'Annan version')
          : h('span', `${info.players}/${info.maxPlayers} spelare · ${info.ping} ms`);
    const ready = info?.ok && info.protocol === PROTOCOL_VERSION;
    return h('div.mp-server',
      h('div.mp-server-head',
        h('b', info?.name ?? s.name),
        h('span.small.muted', s.url),
        status),
      ready && info.rules ? h('p.small.muted', `Raidfönster: ${info.rules.raidWindow}. Fristaden är säker, vildmarken är PvP.`) : null,
      h('div.row',
        ready && info.supabase ? h('button.btn-primary', {
          disabled: !loggedIn,
          title: loggedIn ? null : 'Logga in först',
          onclick: () => join(s, 'account'),
        }, icon('players', 20), loggedIn ? 'Spela' : 'Logga in för att spela') : null,
        ready && info.guests ? h(`button${info.supabase ? '' : '.btn-primary'}`, { onclick: () => join(s, 'guest') }, 'Spela som gäst') : null,
        s.custom ? h('button.btn-danger', { onclick: () => { removeServer(s.url); refreshServers(); } }, 'Ta bort') : null));
  }

  function addSection() {
    const url = h('input', { type: 'url', placeholder: 'wss://spel.example.se/ws' });
    return h('details.mp-add',
      h('summary', 'Lägg till en server'),
      h('label.field', h('span', 'Adress'), url),
      h('button', {
        onclick: () => {
          const v = url.value.trim();
          if (!/^wss?:\/\/.+/.test(v)) {
            state.error = 'Adressen ska börja med wss:// (eller ws:// lokalt)';
            rerender();
            return;
          }
          addServer(new URL(v).host, v);
          state.infos.delete(v);
          refreshServers();
        },
      }, 'Lägg till'));
  }

  function build() {
    return h('div.mp-lobby',
      state.error ? h('p.warn', state.error) : null,
      accountSection(),
      h('section',
        h('h3', 'Servrar'),
        state.servers.length ? state.servers.map(serverRow) : h('p.small.muted', 'Inga servrar inställda än. Lägg till en adress nedan, eller starta en egen (se docs/MULTIPLAYER-SETUP.md).'),
        addSection()),
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
  refreshServers();
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

function namePrompt(msg, send) {
  const input = h('input', { type: 'text', maxlength: 16, value: msg.suggestion ?? '', autocomplete: 'nickname', autofocus: true });
  const submit = () => send(input.value.trim());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  openModal({
    title: 'Välj ditt namn',
    locked: true,
    className: 'tutorial-panel',
    body: h('div.mp-name',
      h('p', 'Så här ser andra spelare dig. Du kan inte byta senare.'),
      msg.error ? h('p.warn', msg.error) : null,
      h('label.field', h('span', 'Namn (3–16 tecken)'), input),
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
  if (join.mode === 'guest') token = auth.guestToken(join.server.url) ?? 'guest';
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
  try {
    await game.connect(join.server, token, {
      onGuestToken: (t) => auth.setGuestToken(join.server.url, t),
      onNeedName: (msg, send) => namePrompt(msg, (name) => {
        connectingModal(join.server.name);
        send(name);
      }),
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
