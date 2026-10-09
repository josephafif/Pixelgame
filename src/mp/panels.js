// Panels in multiplayer: the same inventory, forge, map and settings as
// single player, plus the clan panel, the player list and the rules, and a
// multiplayer pause menu (the world never pauses: it's shared).

import { h } from '../ui/dom.js';
import { icon, costChips } from '../ui/icons.js';
import { openModal, closeModal, isModalOpen, isModalLocked, replaceModalBody } from '../ui/modal.js';
import { BuildBar } from '../ui/build.js';
import { ROLE_SV, describeRaidWindow, parseRaidWindow } from '../net/rules.js';
import { MP_RESOURCE_KEYS } from '../net/mpsave.js';

const loaders = {
  inventory: () => import('../ui/inventory.js'),
  crafting: () => import('../ui/crafting.js'),
  map: () => import('../ui/map.js'),
  settings: () => import('../ui/settings.js'),
  pals: () => import('../ui/pals.js'),
  research: () => import('../ui/research.js'),
};

const DOCK = {
  'btn-inventory': 'inventory',
  'btn-map': 'map',
  'btn-forge': 'crafting',
  'btn-research': 'players',
  'btn-base': 'clan',
  'btn-build': 'build',
  'btn-menu': 'menu',
};

const RES_SV = { essence: 'Essens', scrap: 'Skrot', wood: 'Trä', stone: 'Sten', gold: 'Guld', shards: 'Stjärnskärvor' };

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
    // Multiplayer labels and icons on the dock: Research → Players, Camp → Clan.
    for (const [id, label, iconName] of [['btn-research', 'Spelare', 'players'], ['btn-base', 'Klan', 'flag'], ['btn-forge', 'Smedja', 'anvil']]) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.querySelector('img.icon')?.replaceWith(icon(iconName, 24));
    }
    this.buildBar = new BuildBar(game);
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
    // (R shows the players here; research is at Fristaden's library, or in the menu.)
    const alias = { base: 'clan', research: 'players', library: 'research' }[name];
    const target = alias === undefined ? name : alias;
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
      case 'town': return this.#town();
      case 'password': return this.#password();
      case 'crafting':
        if (!this.game.nearForge()) {
          this.game.toast('Smedjan finns i Fristaden: gå dit för att smida.', 'warn');
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
        item('flag', 'Klan', go('clan'), 'B'),
        item('players', 'Spelare', go('players'), 'R'),
        item('chat', 'Chatt', () => { closeModal(); this.app.mpHud?.openChat(); }, 'T'),
        item('hammer', 'Bygg', () => { closeModal(); g.toggleBuildMode(true); }, 'G'),
        item('book', 'Forskning', go('research')),
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

  /** Fristaden's Waystone from anywhere: home, and back to where you were. */
  #waystone() {
    const g = this.game;
    const left = Math.ceil(g.recallReadyIn());
    const home = g.zoneInfo().kind === 'safe' || g.zoneInfo().kind === 'own';
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

  // --- Clan ------------------------------------------------------------------------------

  #clan(refresh = false) {
    const g = this.game;
    const body = this.#clanBody();
    if (refresh) {
      replaceModalBody(body);
      return;
    }
    g.clanRequest('info');
    openModal({ title: 'Klan', icon: 'flag', body, className: 'wide mp-clan-panel', onClose: () => { this.open = null; } });
  }

  #clanBody() {
    const g = this.game;
    const clan = g.clan;
    const myRole = g.me?.clan?.role ?? null;
    const act = (op, args) => g.clanRequest(op, args);
    if (!clan) {
      const name = h('input', { type: 'text', maxlength: 20, placeholder: 'Klanens namn' });
      const tag = h('input', { type: 'text', maxlength: 4, placeholder: 'TAGG', style: { textTransform: 'uppercase', width: '6em' } });
      return h('div.mp-clan',
        g.invites.length ? h('section',
          h('h3', 'Inbjudningar'),
          g.invites.map((inv) => h('div.row',
            h('b', `[${inv.tag}] ${inv.name}`),
            h('button.btn-primary', { onclick: () => act('accept', { id: inv.id }) }, 'Gå med'),
            h('button', { onclick: () => act('decline', { id: inv.id }) }, 'Avböj')))) : null,
        h('section',
          h('h3', 'Grunda en klan'),
          h('p.small.muted', 'En klan delar bas, byggen och valv. Du kan vara ensam i din klan. Res sedan ett klanbanér ute i vildmarken: marken runt banéret blir er, och bara ni kan bygga där.'),
          h('div.row', h('label.field', h('span', 'Namn'), name), h('label.field', h('span', 'Tagg'), tag)),
          h('button.btn-primary', { onclick: () => act('create', { name: name.value.trim(), tag: tag.value.trim().toUpperCase() }) }, icon('flag', 20), 'Grunda klanen')));
    }
    const officer = myRole === 'officer' || myRole === 'leader';
    const leader = myRole === 'leader';
    const raid = clan.raid;
    const raidText = raid.raidable
      ? ({ online: 'Basen kan raidas nu (någon i klanen är online).', grace: 'Basen kan raidas en kort stund till (ni loggade nyss ut).', window: 'Raidfönstret är öppet: alla baser kan raidas.' }[raid.reason] ?? 'Basen kan raidas nu.')
      : 'Basen är skyddad just nu.';
    const invite = h('input', { type: 'text', maxlength: 16, placeholder: 'Spelarens namn' });
    const amount = (k) => h('input', { type: 'number', min: 0, step: 1, value: 0, 'data-res': k, style: { width: '5.5em' } });
    const fields = Object.fromEntries(MP_RESOURCE_KEYS.map((k) => [k, amount(k)]));
    const collect = () => Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, Number(el.value) || 0]).filter(([, n]) => n > 0));
    return h('div.mp-clan',
      h('header.mp-clan-head',
        h('h3', `[${clan.tag}] ${clan.name}`),
        h('span.small.muted', `${clan.members.length}/${clan.max} medlemmar · du är ${ROLE_SV[myRole] ?? 'medlem'}`)),
      h('section',
        h('h3', 'Bas'),
        clan.banner
          ? h('p', `Klanbanéret står vid (${clan.banner.x}, ${clan.banner.y}) · ${clan.banner.hp}/${clan.banner.maxHp} hp · ${clan.structures} byggen.`)
          : h('p', 'Inget klanbanér än. Gå ut i vildmarken (minst 40 rutor från Fristaden), tryck på Bygg och res banéret.'),
        h('p.small', raidText),
        h('p.small.muted', `Raidfönster: ${clan.raidWindow}. Skyddet startar ${g.rules?.raidGraceMinutes ?? 15} minuter efter att den sista i klanen loggat ut.`),
        clan.unpaid ? h('p.warn', 'Valvet räcker inte till underhållet: basen förfaller. Lägg trä och sten i valvet.') : null,
        h('p.small.muted', 'Underhåll per vecka: ', costChips(clan.upkeepPerWeek, clan.vault))),
      h('section',
        h('h3', 'Klanvalv'),
        h('p.small.muted', `Lägg i och ta ut vid banéret. Hälften av valvet kan aldrig tas av raiders.`),
        h('div.mp-vault', MP_RESOURCE_KEYS.map((k) => h('label.field.small', h('span', `${RES_SV[k]} (${clan.vault[k] ?? 0})`), fields[k]))),
        h('div.row',
          h('button', { onclick: () => act('deposit', { res: collect() }) }, 'Lägg i valvet'),
          officer ? h('button', { onclick: () => act('withdraw', { res: collect() }) }, 'Ta ut') : null)),
      h('section',
        h('h3', 'Medlemmar'),
        h('ul.mp-members', clan.members.map((m) => h('li',
          h('span.dot', { class: m.online ? 'on' : null }),
          h('b', m.name), h('span.small.muted', ` ${ROLE_SV[m.role] ?? m.role}`),
          leader && m.name !== g.myName ? h('span.mp-member-actions',
            m.role === 'member' ? h('button.small', { onclick: () => act('promote', { name: m.name }) }, 'Befordra') : null,
            m.role === 'officer' ? h('button.small', { onclick: () => act('demote', { name: m.name }) }, 'Degradera') : null,
            h('button.small', { onclick: () => confirm(`Göra ${m.name} till ledare?`) && act('transfer', { name: m.name }) }, 'Gör till ledare')) : null,
          officer && m.name !== g.myName && m.role !== 'leader' && (leader || m.role === 'member')
            ? h('button.small.btn-danger', { onclick: () => confirm(`Sparka ${m.name}?`) && act('kick', { name: m.name }) }, 'Sparka') : null))),
        clan.invited.length ? h('p.small.muted', `Inbjudna: ${clan.invited.join(', ')}`) : null,
        officer ? h('div.row', invite, h('button', { onclick: () => act('invite', { name: invite.value.trim() }) }, 'Bjud in')) : null),
      h('div.row',
        h('button', { onclick: () => confirm('Lämna klanen?') && act('leave') }, 'Lämna klanen'),
        leader ? h('button.btn-danger', { onclick: () => confirm('Upplösa klanen? Basen blir ägarlös och förfaller.') && act('disband') }, 'Upplös klanen') : null));
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
        h('li', `Fristaden (${r?.safeRadius ?? 24} rutor från mitten) är säker: ingen PvP, inga monster, inget byggande. Här finns smedjan, förrådet och härden.`),
        h('li', 'Ute i vildmarken kan andra spelare anfalla dig. Dör du där tappar du hälften av det du bär i en säck. Vapnen du har utrustade behåller du.'),
        h('li', `Nya spelare är skyddade i ${Math.round((r?.newbieSeconds ?? 7200) / 3600)} timmar eller tills de besegrat en boss. Den som anfaller en spelare tappar sitt skydd.`),
        h('li', 'Loggar du ut i vildmarken ligger din kropp kvar en halv minut. Logga ut i Fristaden för att vara säker.')),
      h('h3', 'Klanbaser och raider'),
      h('ul',
        h('li', 'Res ett klanbanér i vildmarken: marken runt det blir er klans.'),
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
            if (!confirm('Stänga av nybörjarskyddet för gott?')) return;
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
