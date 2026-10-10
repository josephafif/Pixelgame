// Panels in multiplayer: the same inventory, forge, map and settings as
// single player, plus the clan panel, the player list and the rules, and a
// multiplayer pause menu (the world never pauses: it's shared).

import { h, pixelCanvas } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openModal, closeModal, isModalOpen, isModalLocked, replaceModalBody, askConfirm } from '../ui/modal.js';
import { BuildBar } from '../ui/build.js';
import { describeRaidWindow, parseRaidWindow } from '../net/rules.js';
import { clanPanelBody } from './base-panel.js';
import { horseSprite } from '../render/horses.js';
import { MAX_HORSES } from '../game/horses.js';

const loaders = {
  inventory: () => import('../ui/inventory.js'),
  crafting: () => import('../ui/crafting.js'),
  map: () => import('../ui/map.js'),
  settings: () => import('../ui/settings.js'),
  pals: () => import('../ui/pals.js'),
  research: () => import('../ui/research.js'),
  market: () => import('../ui/market.js'),
};

const DOCK = {
  'btn-inventory': 'inventory',
  'btn-map': 'map',
  'btn-forge': 'crafting',
  'btn-research': 'research',
  'btn-base': 'clan',
  'btn-build': 'build',
  'btn-menu': 'menu',
};

export class MpPanels {
  constructor(game, app) {
    this.game = game;
    this.app = app;
    this.open = null;
    game.on('ui', (cmd) => this.command(cmd));
    for (const [id, name] of Object.entries(DOCK)) {
      const btn = document.getElementById(id);
      btn?.addEventListener('click', () => {
        btn.blur();
        this.command(name);
      });
    }
    // Multiplayer labels on the dock (the same buttons as single player).
    for (const [id, label, iconName] of [['btn-research', 'Forskning', 'book'], ['btn-base', 'Bas och klan', 'home'], ['btn-forge', 'Smedja', 'anvil'], ['btn-inventory', 'Väska', 'bag'], ['btn-map', 'Karta', 'map'], ['btn-build', 'Bygg', 'hammer'], ['btn-menu', 'Meny', 'gear']]) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.querySelector('img.icon')?.replaceWith(icon(iconName, 24));
    }
    this.buildBar = new BuildBar(game);
    this.clanState = { tab: 'base', focus: null };
    // Your role arrives with your own state, the clan's with the clan.
    const refresh = () => {
      if (this.open === 'clan' && isModalOpen()) this.#clan(true);
    };
    game.on('clan', refresh);
    game.on('me', refresh);
  }

  prefetch() {
    const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
    idle(() => Object.values(loaders).forEach((load) => load().catch(() => {})));
  }

  command(cmd) {
    if (!this.app.started || this.game.discoveryOpen || isModalLocked()) return;
    const { name, ...arg } = typeof cmd === 'string' ? { name: cmd } : cmd;
    if (name === 'back') {
      closeModal();
      return;
    }
    if (name === 'build') {
      if (isModalOpen()) closeModal(true);
      this.game.toggleBuildMode();
      return;
    }
    if (name === 'chat') {
      this.app.mpHud?.openChat();
      return;
    }
    if (name === 'menu' && this.game.build.active && !isModalOpen()) {
      this.game.toggleBuildMode(false);
      return;
    }
    if (name === 'base') {
      // At a building in your base: the base tab, with that building.
      this.clanState = { tab: 'base', focus: arg.focus ?? null };
      this.show('clan');
      return;
    }
    if (name === 'clan' && arg.tab) {
      // Straight to a tab (the lodge opens the workers).
      this.clanState = { tab: arg.tab, focus: null };
      this.show('clan');
      return;
    }
    const alias = { library: 'research', storage: 'inventory' }[name];
    const target = alias === undefined ? name : alias;
    if (name === 'storage') arg.tab = 'storage';
    if (isModalOpen() && this.open === target && !Object.keys(arg).length) {
      closeModal();
      return;
    }
    this.show(target, arg);
  }

  async show(name, arg = {}) {
    if (this.game.discoveryOpen || isModalLocked()) return;
    if (typeof arg === 'string') arg = { tab: arg };
    this.open = name;
    switch (name) {
      case 'menu': return this.#menu();
      case 'clan': return this.#clan();
      case 'players': return this.#players();
      case 'horses': return this.#horses();
      case 'town': return this.#town();
      case 'password': return this.#password();
      case 'crafting':
        if (!this.game.nearForge()) {
          this.game.toast('Gå till en smedja: i Fristaden (upp till sällsynta vapen) eller i er bas.', 'warn');
          return undefined;
        }
        break;
      default:
        break;
    }
    const load = loaders[name];
    if (!load) return undefined;
    try {
      const mod = await load();
      mod.open(this.game, this.app, arg);
    } catch (err) {
      console.error(err);
      this.game.toast(`Kunde inte öppna ${name}: ${err.message}`, 'warn');
    }
    return undefined;
  }

  #menu() {
    const g = this.game;
    const go = (name, arg) => () => this.show(name, arg);
    const item = (iconName, label, onclick, key) => h('button', { onclick }, icon(iconName, 24), h('span', label), key ? h('kbd', key) : null);
    const body = h('div.menu',
      this.app.updateReady ? h('button.btn-primary', { onclick: () => this.app.applyUpdate() }, 'Uppdatering finns: installera nu') : null,
      h('button.btn-primary', { onclick: () => { closeModal(); this.app.enterFullscreen?.(); }, autofocus: true }, 'Fortsätt'),
      h('div.menu-grid',
        item('bag', 'Väska', go('inventory'), 'I'),
        item('map', 'Karta', go('map'), 'M'),
        item('anvil', 'Smedja', go('crafting'), 'C'),
        item('home', 'Bas och klan', go('clan'), 'B'),
        item('book', 'Forskning', go('research'), 'R'),
        item('hammer', 'Bygg', () => { closeModal(); g.toggleBuildMode(true); }, 'G'),
        item('pal', 'Pals', go('pals'), 'H'),
        item('horse', 'Hästar', go('horses')),
        item('chat', 'Chatt', () => { closeModal(); this.app.mpHud?.openChat(); }, 'T'),
        item('players', 'Spelare online', go('players')),
        item('book', 'Regler', go('town'))),
      this.#waystone(),
      h('div.menu-grid',
        item('gear', 'Inställningar', go('settings')),
        g.account?.guest ? item('lock', g.account.password ? 'Byt lösenord' : 'Välj lösenord', go('password')) : null,
        item('portal', 'Lämna servern', () => {
          g.disconnect();
          location.href = location.pathname;
        })),
      h('p.menu-foot', `${g.server?.name ?? ''} · ${g.myName ?? ''} · ${Math.round(g.conn?.rtt ?? 0)} ms`));
    openModal({ title: 'Meny', body, className: 'menu-panel', onClose: () => { this.open = null; } });
  }

  /** Your base's Waystone from anywhere: home, and back to where you were. */
  #waystone() {
    const g = this.game;
    if (!g.clan?.base?.placed?.waystone) return null;
    const left = Math.ceil(g.recallReadyIn());
    const home = g.zoneInfo().kind === 'own';
    const back = g.me?.recallFrom;
    const buttons = [];
    if (!home) {
      buttons.push(h('button', {
        disabled: left > 0,
        onclick: () => {
          closeModal();
          g.recall();
        },
      }, icon('portal', 24), h('span', left > 0 ? `Res hem (${left} s)` : 'Res hem med vägstenen')));
    }
    if (back && home) {
      buttons.push(h('button', {
        onclick: () => {
          closeModal();
          g.recallBack();
        },
      }, icon('portal', 24), h('span', 'Tillbaka genom vägstenen')));
    }
    return buttons.length ? h('div.menu-grid', buttons) : null;
  }

  // --- Horses --------------------------------------------------------------------------------

  /** Your horses: where each one is, and letting one go. */
  #horses() {
    const g = this.game;
    const build = () => {
      const st = g.save.horses ?? { owned: [], riding: null };
      if (!st.owned.length) {
        return h('div.horse-list',
          h('p', 'Du har inga hästar än.'),
          h('p.small.muted', 'Vilda hästar betar här och där i vildmarken, långt från Fristaden (inte lätta att hitta). Gå fram till en och tryck Använd för att rida den: då är den din. Till häst är du snabbare, tål mer och hoppar över träd och stenar. Lämna hästen på er klans mark så stannar den där.'));
      }
      return h('div.horse-list',
        h('h3', `Dina hästar (${st.owned.length} / ${MAX_HORSES})`),
        h('p.small.muted', 'På er klans mark stannar en häst för alltid. Ute i vildmarken springer den iväg om du är borta länge.'),
        st.owned.map((rec) => {
          const art = pixelCanvas(horseSprite(rec.breed, 0, true));
          art.style.width = '45px';
          art.style.height = '36px';
          const where = rec.id === st.riding ? 'Du rider den' : rec.stabled ? 'I er bas' : 'Ute i världen';
          return h('div.horse-row',
            art,
            h('div',
              h('b', rec.name),
              h('div.small.muted', `${g.describeHorse(rec)} · ${where}`)),
            h('span.spacer'),
            rec.id === st.riding ? null : h('button', {
              onclick: async () => {
                if (await g.releaseHorse(rec.id)) replaceModalBody(build());
              },
            }, 'Släpp fri'));
        }));
    };
    const off = g.on('riding', () => {
      if (this.open === 'horses' && isModalOpen()) replaceModalBody(build());
    });
    openModal({ title: 'Hästar', icon: 'horse', body: build(), className: 'horses-panel', onDispose: off, onClose: () => { this.open = null; } });
  }

  // --- Password (guests) -----------------------------------------------------------------

  #password() {
    const g = this.game;
    const input = h('input', { type: 'password', maxlength: 64, autocomplete: 'new-password' });
    const save = async () => {
      const res = await g.setPassword(input.value);
      if (!res.ok) return;
      closeModal();
      g.toast('Lösenordet är sparat. Logga in med ditt namn och lösenordet nästa gång.', 'component');
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') save();
    });
    const body = h('div.mp-name',
      h('p', g.account?.password
        ? 'Byt lösenordet du loggar in med.'
        : 'Din karaktär har inget lösenord än. Välj ett, så kan du logga in med ditt namn från en ny länk eller en annan enhet.'),
      h('p.small.muted', `Ditt namn: ${g.myName ?? ''}`),
      h('label.field', h('span', 'Nytt lösenord (minst 4 tecken)'), input),
      h('button.btn-primary', { onclick: save }, 'Spara'));
    openModal({ title: 'Lösenord', icon: 'lock', body, className: 'tutorial-panel', onClose: () => { this.open = null; } });
    input.focus();
  }

  // --- Clan and base ------------------------------------------------------------------------

  #clan(refresh = false) {
    const g = this.game;
    if (!g.clan && !refresh) this.clanState.tab = 'base';
    const body = clanPanelBody(g, this, this.clanState);
    if (refresh) {
      replaceModalBody(body);
      return;
    }
    g.clanRequest('info');
    openModal({ title: g.clan ? 'Bas och klan' : 'Klan', icon: 'home', body, className: 'wide mp-clan-panel', onClose: () => { this.open = null; } });
    if (this.clanState.focus) {
      requestAnimationFrame(() => document.querySelector(`.bcard[data-building="${this.clanState.focus}"]`)?.scrollIntoView({ block: 'nearest' }));
    }
  }

  /** Switches the clan panel's tab. */
  clanTab(tab) {
    this.clanState = { tab, focus: null };
    if (this.open === 'clan' && isModalOpen()) this.#clan(true);
  }

  // --- Players ------------------------------------------------------------------------

  #players() {
    const g = this.game;
    const body = h('div.mp-players', h('p.muted', 'Hämtar…'));
    const off = g.on('who', (list) => {
      replaceModalBody(h('div.mp-players',
        h('p.small.muted', `${list.length} spelare online på ${g.server?.name ?? 'servern'}.`),
        h('ul', list.map((p) => h('li', h('b', p.tag ? `[${p.tag}] ${p.name}` : p.name), h('span.small.muted', ` nivå ${p.level}`))))));
    });
    g.request({ t: 'who' });
    openModal({ title: 'Spelare', icon: 'players', body, className: 'tutorial-panel', onDispose: off, onClose: () => { this.open = null; } });
  }

  // --- Rules / town -----------------------------------------------------------------------

  #town() {
    const g = this.game;
    const r = g.rules;
    const me = g.me ?? {};
    const windowText = r ? describeRaidWindow(parseRaidWindow(r.raidWindow)) : '';
    const spawn = me.spawnAt ?? 'banner';
    const body = h('div.tutorial',
      h('h3', 'Fristaden och vildmarken'),
      h('ul',
        h('li', `Fristaden (${r?.safeRadius ?? 24} rutor från mitten) är säker: ingen PvP, inga monster, inget byggande. Här finns en enkel smedja (upp till sällsynta vapen) och handlare.`),
        h('li', 'Ute i vildmarken kan andra spelare anfalla dig. Dör du där tappar du hälften av det du bär i en säck. Vapnen du har utrustade behåller du.'),
        h('li', `Nya spelare är skyddade i ${Math.round((r?.newbieSeconds ?? 7200) / 3600)} timmar eller tills de besegrat en boss. Den som anfaller en spelare tappar sitt skydd.`),
        h('li', 'Loggar du ut i vildmarken ligger din kropp kvar en halv minut. Logga ut i Fristaden för att vara säker.')),
      h('h3', 'Klanbaser och raider'),
      h('ul',
        h('li', 'Res ett klanbanér i vildmarken: marken runt det blir er klans. Där bygger ni smedja, förråd, bibliotek, brunn, djurhus, vägsten, härd och träningsplats.'),
        h('li', `Andra kan bara skada er bas när någon i klanen är online, ${r?.raidGraceMinutes ?? 15} minuter efter att den sista loggat ut, eller under raidfönstret (${windowText}).`),
        h('li', 'Fäller någon ert banér tar de hälften av valvet. Bygg ett nytt banér för att ta tillbaka marken.')),
      h('h3', 'Dina val'),
      h('div.row',
        h('span', 'Återuppstå vid: '),
        ['banner', 'town'].map((at) => h(`button${spawn === at ? '.btn-primary' : ''}`, {
          onclick: async () => {
            const res = await g.request({ t: 'spawnAt', at });
            if (res.ok && g.me) g.me.spawnAt = at;
            this.#town();
          },
        }, at === 'banner' ? 'Klanbanéret' : 'Fristaden'))),
      me.newbie ? h('div.row',
        h('span.small', 'Du har nybörjarskydd.'),
        h('button.btn-danger', {
          onclick: async () => {
            if (!await askConfirm({ title: 'Stänga av skyddet?', text: 'Stänga av nybörjarskyddet för gott? Andra spelare kan då anfalla dig i vildmarken.', ok: 'Stäng av', cancel: 'Avbryt', danger: true })) return;
            const res = await g.request({ t: 'pvp' });
            if (res.ok && g.me) g.me.newbie = false;
            this.#town();
          },
        }, 'Jag vill slåss nu')) : null,
      h('p.small.muted', `Nivå ${me.level ?? 1} · ${me.kills ?? 0} monster · ${me.pvpKills ?? 0} spelare besegrade · ${me.deaths ?? 0} dödsfall`),
      h('button.btn-primary', { onclick: () => closeModal() }, 'Stäng'));
    openModal({ title: 'Regler', icon: 'book', body, className: 'tutorial-panel', onClose: () => { this.open = null; } });
  }
}
