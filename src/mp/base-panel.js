// The clan panel in multiplayer: your base (the camp's buildings, built and
// upgraded together), the clan vault (one tap to put things in) and the
// members. Three tabs, short texts, big buttons: it has to work on a phone.

import { h, pixelCanvas } from '../ui/dom.js';
import { icon, costChips } from '../ui/icons.js';
import { closeModal, askConfirm } from '../ui/modal.js';
import { buildingSprite } from '../render/buildings.js';
import { buildingDef, maxLevel, COST_KEYS, TONIC } from '../game/base.js';
import { BASE_BUILDINGS, BUILDING_SV, baseStructId } from '../net/mpbase.js';
import { ROLE_SV, canDo } from '../net/rules.js';
import { workerLook, ROLE_NAMES_SV, WORKER_ROLES } from '../game/workers.js';
import { structureDef, upgradeDef, upgradeCost } from '../game/construction.js';
import { mpStructureLock } from '../net/mpbuild.js';
import { roundUp } from '../game/upkeep.js';
import { upkeepBox } from '../ui/upkeep-view.js';
import { workerPortrait } from '../render/workers-art.js';

const RES = [
  ['wood', 'Trä'], ['stone', 'Sten'], ['scrap', 'Skrot'], ['essence', 'Essens'], ['gold', 'Guld'], ['shards', 'Stjärnskärvor'],
];
const ICON = { wood: 'wood', stone: 'stone', scrap: 'scrap', essence: 'essence', gold: 'coin', shards: 'shard' };
const CATALYSTS_SV = { 2: 'azurkatalysator (upp till episka)', 4: 'violett katalysator (episka)', 5: 'gyllene katalysator (legendariska)' };

function bonusLevels(def, level) {
  return Math.max(0, level - (def.bonusFrom ?? 1) + 1);
}

/** What a building gives at a level, in Swedish. */
export function bonusSv(data, id, level) {
  const def = buildingDef(data, id);
  if (!def || level <= 0) return 'Inte byggd';
  const n = bonusLevels(def, level);
  const p = def.perLevel ?? {};
  switch (id) {
    case 'hearth': return n > 0 ? `+${p.maxHpPct * n} % hälsa · vila för full hälsa` : 'Vila här för full hälsa';
    case 'forge': {
      const cat = Object.entries(CATALYSTS_SV).filter(([lv]) => Number(lv) <= level).pop();
      return ['Vapen, hackor och båtar', n > 0 ? `−${p.craftDiscountPct * n} % pris` : null, n > 0 ? `+${p.craftLevel * n} vapennivå` : null, cat ? cat[1] : null].filter(Boolean).join(' · ');
    }
    case 'vault': return `+${p.storage * n} förrådsplatser · +${p.bag * n} i väskan`;
    case 'library': return `−${p.researchDiscountPct * n} % kostnad för forskning`;
    case 'training': return `+${p.attackPower * n} anfall · +${p.defense * n} försvar`;
    case 'well': return `${p.essencePerHour * n} essens i timmen`;
    case 'waystone': return ['', 'Res hem från var som helst', 'Res hem och tillbaka igen'][level] ?? '';
    case 'den': return `Kläck ägg · pals upp till nivå ${Math.min(data.pals?.maxLevel ?? 10, (p.palLevelCap ?? 2) * n)}`;
    case 'lodge': {
      const cap = (data.base.workers?.baseCap ?? 1) + level;
      const tier = Math.max(1, Math.min(4, level - 1));
      return `Plats för ${cap} arbetare · ${['', 'träd och sten', '+ kristaller', '+ obsidian', '+ järnmalm'][tier]}`;
    }
    case 'garden':
      return [`Läk ${((p.regenPct ?? 0) * n).toFixed(1)} % hälsa i sekunden utanför strid`, level >= 2 ? 'gyttjan gör er inte sjuka' : null, 'brygg lumentonikum']
        .filter(Boolean).join(' · ');
    default: return '';
  }
}

function pips(level, max) {
  return h('div.pips', { 'aria-label': `Nivå ${level} av ${max}` },
    Array.from({ length: max }, (_, i) => h('i', { class: i < level ? 'on' : null })));
}

function nextCost(def, level) {
  const next = def.levels[level];
  if (!next) return null;
  const cost = {};
  for (const k of COST_KEYS) if (next[k]) cost[k] = next[k];
  return { cost, playerLevel: next.playerLevel ?? 1, boss: Boolean(next.boss) };
}

function short(wallet, cost) {
  return COST_KEYS.some((k) => (wallet[k] ?? 0) < (cost[k] ?? 0));
}

// --- Tabs ---------------------------------------------------------------------------------------

export function clanPanelBody(game, panels, state) {
  const clan = game.clan;
  if (!clan) return noClan(game);
  const myRole = game.me?.clan?.role ?? 'member';
  const tabs = [['base', 'Bas', 'home'], ['vault', 'Valv', 'chest'], ['workers', 'Arbetare', 'pickaxe'], ['members', 'Medlemmar', 'players']];
  const raid = clan.raid;
  const head = h('header.mp-clan-head',
    h('h3', `[${clan.tag}] ${clan.name}`),
    h('span.small.muted', `${clan.members.length}/${clan.max} · ${ROLE_SV[myRole] ?? 'Medlem'}`),
    clan.banner ? h(`span.chip.${raid.raidable ? 'warn' : 'ok'}`, raid.raidable ? 'Kan raidas nu' : 'Skyddad') : null);
  const bar = h('div.tabs', { role: 'tablist' }, tabs.map(([id, label, ic]) => h('button.tab', {
    role: 'tab', 'aria-selected': String(state.tab === id), class: state.tab === id ? 'active' : null,
    onclick: () => panels.clanTab(id),
  }, icon(ic, 20), h('span', label))));
  let body;
  if (state.tab === 'vault') body = vaultTab(game, myRole);
  else if (state.tab === 'workers') body = workersTab(game, panels, myRole);
  else if (state.tab === 'members') body = membersTab(game, panels, myRole);
  else body = baseTab(game, panels, state);
  return h('div.mp-clan', head, bar, clan.unpaid ? h('p.warn.small', icon('skull', 16), ' Valvet räcker inte till underhållet: basen förfaller. Lägg i trä och sten.') : null, body);
}

// --- Base: the buildings ---------------------------------------------------------------------------------

function baseTab(game, panels, state) {
  const { data } = game;
  const clan = game.clan;
  const b = clan.base ?? { levels: {}, placed: {}, well: 0 };
  const wallet = game.buildWallet({ kind: 'building' });
  const me = game.me ?? {};
  const bossBeaten = Object.keys(me.bosses ?? {}).length > 0;
  const build = (id) => {
    closeModal();
    game.toggleBuildMode(true);
    game.selectStructure(baseStructId(id));
  };
  if (!clan.banner) {
    return h('section.mp-base-empty',
      h('p', 'Er klan har ingen bas än. Gå ut i vildmarken, minst 40 rutor från Fristaden, och res ett klanbanér. Marken runt det blir er, och där bygger ni smedja, förråd och allt annat.'),
      h('button.btn-primary', { onclick: () => { closeModal(); game.toggleBuildMode(true); game.selectStructure('banner'); } }, icon('flag', 20), 'Res klanbanéret'));
  }
  const card = (id) => {
    const def = buildingDef(data, id);
    const placedAt = b.placed?.[id];
    const level = b.levels?.[id] ?? 0;
    const max = maxLevel(def);
    const art = pixelCanvas(buildingSprite(id, placedAt ? level : 0));
    art.style.width = '48px';
    art.style.height = '54px';
    const actions = [];
    let status;
    if (!placedAt) {
      const first = nextCost(def, 0);
      const free = level > 0;
      const lock = !free && (me.level ?? 1) < first.playerLevel ? `Kräver nivå ${first.playerLevel}` : null;
      status = free ? `Riven · nivå ${level} sparad` : 'Inte byggd';
      actions.push(free ? null : h('span.bcost', costChips(first.cost, wallet)));
      actions.push(h(`button${!lock && (free || !short(wallet, first.cost)) ? '.btn-primary' : ''}`, {
        disabled: Boolean(lock), onclick: () => build(id),
      }, icon('hammer', 18), lock ?? (free ? 'Bygg igen (gratis)' : 'Bygg')));
    } else {
      status = `Nivå ${level} / ${max}`;
      const next = nextCost(def, level);
      if (next) {
        const why = (me.level ?? 1) < next.playerLevel ? `Kräver nivå ${next.playerLevel}`
          : next.boss && !bossBeaten ? 'Kräver en boss' : null;
        const poor = short(wallet, next.cost);
        actions.push(h('span.bcost', costChips(next.cost, wallet)));
        actions.push(h(`button${!why && !poor ? '.btn-primary' : ''}`, {
          disabled: Boolean(why) || poor, onclick: () => game.upgradeBuilding(id),
        }, icon('up', 18), why ?? 'Uppgradera'));
      } else {
        actions.push(h('span.badge', 'Högsta nivån'));
      }
      actions.push(...useButtons(game, panels, id, b));
    }
    const next = placedAt ? nextCost(def, level) : null;
    return h('article.bcard', {
      class: [state.focus === id ? 'focus' : null, placedAt ? null : 'unbuilt'].filter(Boolean).join(' ') || null,
      'data-building': id,
    },
    h('div.bcard-top',
      h('div.bcard-art', art),
      h('div',
        h('h3', BUILDING_SV[id]),
        pips(placedAt ? level : 0, max),
        h('div.small.muted', status))),
    h('div.now', icon('star', 14), ' ', placedAt ? bonusSv(data, id, level) : bonusSv(data, id, Math.max(1, level))),
    next ? h('div.next', icon('up', 14), ' ', bonusSv(data, id, level + 1)) : null,
    h('div.row', actions.filter(Boolean)));
  };
  return h('section',
    h('div.mp-wallet',
      h('span.small.muted', 'Valvet + det du bär:'),
      ['scrap', 'essence', 'wood', 'stone'].map((k) => h('span.cost', { title: k }, icon(ICON[k], 18), String(Math.floor(wallet[k] ?? 0))))),
    h('div.base-grid.mp-base-grid', BASE_BUILDINGS.map(card)),
    h('p.small.muted', 'Byggnaderna byggs med Bygg-menyn på er mark. Alla i klanen får deras bonusar. Uppgraderingar betalas ur valvet (och resten av det du bär).'),
    fortify(game, wallet));
}

/** Förstärk: uppgradera alla murar (grindar, torn …) av ett slag på en gång. */
function fortify(game, wallet) {
  const { data } = game;
  const clanId = game.clan?.id;
  const counts = new Map();
  for (const st of game.structById?.values() ?? []) {
    if (st.clanId === clanId && st.def?.upgradesTo) counts.set(st.id, (counts.get(st.id) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const level = game.save.player.level;
  const rows = [...counts].map(([id, n]) => {
    const from = structureDef(data, id);
    const to = upgradeDef(data, from);
    const each = upgradeCost(data, from, to);
    const lock = mpStructureLock(to, level);
    const affordable = Math.min(n, ...Object.entries(each).map(([k, c]) => Math.floor((wallet[k] ?? 0) / c)));
    return h('div.fortify-row',
      h('span', h('b', `${n} × ${from.name}`), ' → ', to.name),
      h('span.bcost', costChips(each, wallet), h('span.small.muted', ' styck')),
      lock ? h('span.small.req', icon('lock', 14), ' ', lock)
        : h('button.small', { disabled: affordable < 1, onclick: () => game.fortify(id) }, icon('up', 16), affordable >= n ? 'Förstärk alla' : `Förstärk ${Math.max(0, affordable)}`));
  });
  return h('section.fortify',
    h('h3', 'Förstärk basen'),
    h('p.small.muted', 'Uppgradera på plats: trä → sten → armerad mur, järngrindar, ballistor och järnspikar. Betalas ur valvet och det du bär. Eller använd Uppgradera-verktyget i byggläget (U).'),
    rows);
}

function useButtons(game, panels, id, b) {
  const btn = (ic, label, onclick, disabled = false) => h('button', { onclick, disabled }, icon(ic, 18), label);
  switch (id) {
    case 'forge': return [btn('anvil', 'Smid', () => panels.show('crafting'))];
    case 'vault': return [btn('bag', 'Förråd', () => panels.show('inventory', { tab: 'storage' })), btn('chest', 'Valv', () => panels.clanTab('vault'))];
    case 'lodge': return [btn('players', `Arbetare (${game.clan?.workers?.length ?? 0})`, () => panels.clanTab('workers'))];
    case 'library': return [btn('book', 'Forska', () => panels.show('research'))];
    case 'den': return [btn('pal', 'Pals', () => panels.show('pals'))];
    case 'well': {
      const n = Math.floor(b.well ?? 0);
      return [btn('essence', n > 0 ? `Hämta ${n}` : 'Fylls…', () => game.collectWell(), n <= 0)];
    }
    case 'garden': {
      // Lumen Tonic, paid with your own Lumen Spores.
      const left = Math.max(0, Math.ceil((game.tonicUntil ?? 0) - game.time));
      const have = Math.floor(game.save.resources.spores ?? 0);
      return [btn('spores', left > 0 ? `Tonikum: ${Math.ceil(left / 60)} min kvar` : `Brygg lumentonikum (${TONIC.cost.spores} sporer, du har ${have})`,
        () => game.brewTonic(), have < TONIC.cost.spores)];
    }
    case 'waystone': {
      const left = Math.ceil(game.recallReadyIn());
      const out = [btn('portal', left > 0 ? `Res hem (${left} s)` : 'Res hem', () => { closeModal(); game.recall(); }, left > 0)];
      if (game.me?.recallFrom && (b.levels?.waystone ?? 0) >= 2) out.push(btn('portal', 'Tillbaka', () => { closeModal(); game.recallBack(); }));
      return out;
    }
    default: return [];
  }
}

// --- The vault: one tap to put things in -----------------------------------------------------------------

function vaultTab(game, role) {
  const clan = game.clan;
  const mine = game.save.resources;
  const officer = canDo(role, 'withdraw');
  const send = (op, k, n) => {
    if (n > 0) game.clanRequest(op, { res: { [k]: n } });
  };
  const everything = () => {
    const res = {};
    for (const k of ['wood', 'stone', 'scrap', 'essence']) if ((mine[k] ?? 0) > 0) res[k] = Math.floor(mine[k]);
    if (Object.keys(res).length) game.clanRequest('deposit', { res });
  };
  const row = ([k, name]) => {
    const own = Math.floor(mine[k] ?? 0);
    const vault = Math.floor(clan.vault[k] ?? 0);
    return h('div.vault-row',
      h('span.vault-res', icon(ICON[k], 22), h('b', name)),
      h('span.vault-num', h('small', 'Du'), h('b', String(own))),
      h('span.vault-num', h('small', 'Valv'), h('b', String(vault))),
      h('span.vault-btns',
        h('button.small', { disabled: own < 1, onclick: () => send('deposit', k, Math.min(own, 10)) }, '+10'),
        h('button.small', { disabled: own < 1, onclick: () => send('deposit', k, Math.min(own, 100)) }, '+100'),
        h('button.small.btn-primary', { disabled: own < 1, onclick: () => send('deposit', k, own) }, 'Allt'),
        officer ? h('button.small', { disabled: vault < 1, onclick: () => send('withdraw', k, Math.min(vault, 100)), title: 'Ta ut 100' }, '−100') : null,
        officer ? h('button.small', { disabled: vault < 1, onclick: () => send('withdraw', k, vault), title: 'Ta ut allt' }, 'Ta ut') : null));
  };
  return h('section.mp-vault-tab',
    h('div.row',
      h('button.btn-primary', { onclick: everything }, icon('chest', 20), 'Lägg i allt trä, sten, skrot och essens'),
      h('span.small.muted', 'Valvet nås på er mark.')),
    h('div.vault-rows', RES.map(row)),
    clan.upkeep
      ? upkeepBox({ perDay: clan.upkeep.perDay, counts: clan.upkeep.counts, vault: clan.vault, unpaid: clan.unpaid, lang: 'sv',
        note: 'Dras ur valvet en gång i timmen. Räcker det inte förfaller murarna och arbetarna slutar. Hälften av valvet kan aldrig tas av raiders.' })
      : h('p.small.muted', 'Underhåll per vecka: ', costChips(clan.upkeepPerWeek, clan.vault), ' · Hälften av valvet kan aldrig tas av raiders.'),
    officer ? null : h('p.small.muted', 'Bara ledare och officerare kan ta ut ur valvet.'));
}

// --- Workers: hired at the lodge, they fill the vault ------------------------------------------------------

const TIER_SV = ['', 'träd och sten', 'kristaller också', 'obsidian också', 'järnmalm också'];

function workersTab(game, panels, role) {
  const clan = game.clan;
  const { data } = game;
  const lodge = clan.lodge;
  if (!lodge) {
    return h('section.workers',
      h('p', 'Bygg en arbetarstuga i er bas för att anställa arbetare. De hugger träd och bryter sten ute i vildmarken och bär hem allt till klanvalvet, mot en daglig lön.'),
      h('button.btn-primary', { onclick: () => { closeModal(); game.toggleBuildMode(true); game.selectStructure(baseStructId('lodge')); } }, icon('hammer', 20), 'Bygg arbetarstugan'));
  }
  const may = canDo(role, 'build');
  const wallet = game.buildWallet({ kind: 'building' });
  const poor = COST_KEYS.some((k) => (wallet[k] ?? 0) < (lodge.hire[k] ?? 0));
  const act = (op, args) => game.request({ t: 'base', op, ...args });
  const wage = roundUp(Object.fromEntries(Object.entries(game.rules.upkeepPerWorker ?? {}).map(([k, v]) => [k, v / 7])));
  const row = (rec) => {
    const look = workerLook(clan.id, rec.id);
    const live = game.workers?.find((w) => w.clanId === clan.id && w.id === rec.id);
    const art = pixelCanvas(workerPortrait(look));
    art.style.width = '30px';
    art.style.height = '36px';
    const doing = !live ? 'Ute i världen' : live.angry ? 'Arg!' : live.idle ? (clan.unpaid ? 'Strejkar: ingen lön' : 'Vilar vid stugan')
      : live.carrying ? `Bär hem ${live.carrying === 'wood' ? 'trä' : 'sten'}` : live.moving ? 'På väg' : 'Arbetar';
    return h('div.worker-row', { 'data-worker': rec.id },
      art,
      h('div.worker-info', h('b', look.name), h('span.small.muted', `${ROLE_NAMES_SV[rec.role]} · ${doing}`)),
      h('span.spacer'),
      may ? h('div.worker-roles', WORKER_ROLES.map((r) => h(`button.small${rec.role === r ? '.btn-primary' : ''}`, {
        'aria-pressed': String(rec.role === r), onclick: () => act('role', { id: rec.id, role: r }),
      }, icon(r === 'wood' ? 'wood' : 'stone', 16), ROLE_NAMES_SV[r]))) : null,
      may ? h('button.small.btn-danger', {
        onclick: async () => await askConfirm({ title: `Säga upp ${look.name}?`, text: 'Arbetaren lämnar er bas för gott. En ny kostar fullt pris.', ok: 'Säg upp', cancel: 'Avbryt', danger: true }) && act('fire', { id: rec.id }),
      }, 'Säg upp') : null);
  };
  return h('section.workers',
    h('p.small.muted', `Arbetarstuga nivå ${lodge.level}: plats för ${lodge.cap}. De arbetar med ${TIER_SV[lodge.tier]} utanför er mark, medan någon i klanen är online.`),
    h('div.row.worker-wage', h('span.small', 'Lön per arbetare och dygn:'), costChips(wage), h('span.small.muted', '(ur valvet)')),
    clan.unpaid ? h('p.warn.small', icon('skull', 16), ' Underhållet betalas inte, så arbetarna har slutat. Lägg in förråd i valvet.') : null,
    h('div.worker-list', clan.workers.length ? clan.workers.map(row) : h('p.muted', 'Inga arbetare än.')),
    clan.workers.length < lodge.cap
      ? h('section.worker-hire',
        h('h3', `Anställ (${clan.workers.length} / ${lodge.cap})`),
        h('div.row', costChips(lodge.hire, wallet), h('span.small.muted', 'ur valvet och det du bär')),
        may ? h('div.row',
          h('button.btn-primary', { disabled: poor, onclick: () => act('hire', { role: 'wood' }) }, icon('wood', 20), 'Anställ skogshuggare'),
          h('button.btn-primary', { disabled: poor, onclick: () => act('hire', { role: 'stone' }) }, icon('stone', 20), 'Anställ gruvarbetare'))
          : h('p.small.muted', 'Du får inte anställa.'))
      : h('p.small.muted', lodge.level < 5 ? 'Stugan är full. Uppgradera den för att få plats med en till.' : 'Stugan är full.'),
    h('p.small.muted', 'Akta dig: en arbetare du slår blir arg på dig, och en som dör är borta. Andra klaner kan bara skada dem när er bas kan raidas.'));
}

// --- Members --------------------------------------------------------------------------------------------

/** An in-game yes/no question, in Swedish. */
function ask(title, text, ok, danger = false) {
  return askConfirm({ title, text, ok, cancel: 'Avbryt', danger });
}

function membersTab(game, panels, myRole) {
  const clan = game.clan;
  const act = (op, args) => game.clanRequest(op, args);
  const officer = canDo(myRole, 'invite');
  const leader = myRole === 'leader';
  const invite = h('input', { type: 'text', maxlength: 16, placeholder: 'Spelarens namn' });
  invite.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') act('invite', { name: invite.value.trim() });
  });
  const spawn = game.me?.spawnAt ?? 'banner';
  return h('section',
    h('ul.mp-members', clan.members.map((m) => h('li',
      h('span.dot', { class: m.online ? 'on' : null }),
      h('b', m.name), h('span.small.muted', ` ${ROLE_SV[m.role] ?? m.role}`),
      leader && m.name !== game.myName ? h('span.mp-member-actions',
        m.role === 'member' ? h('button.small', { onclick: () => act('promote', { name: m.name }) }, 'Befordra') : null,
        m.role === 'officer' ? h('button.small', { onclick: () => act('demote', { name: m.name }) }, 'Degradera') : null,
        h('button.small', { onclick: async () => await ask(`Göra ${m.name} till ledare?`, 'Du blir själv officer.', 'Gör till ledare') && act('transfer', { name: m.name }) }, 'Gör till ledare')) : null,
      officer && m.name !== game.myName && m.role !== 'leader' && (leader || m.role === 'member')
        ? h('button.small.btn-danger', { onclick: async () => await ask(`Sparka ${m.name}?`, `${m.name} åker ur klanen och kan inte längre bygga i er bas.`, 'Sparka', true) && act('kick', { name: m.name }) }, 'Sparka') : null))),
    clan.invited.length ? h('p.small.muted', `Inbjudna: ${clan.invited.join(', ')}`) : null,
    officer ? h('div.row', invite, h('button', { onclick: () => act('invite', { name: invite.value.trim() }) }, 'Bjud in')) : null,
    h('div.row',
      h('span.small', 'Återuppstå vid:'),
      ['banner', 'town'].map((at) => h(`button.small${spawn === at ? '.btn-primary' : ''}`, {
        onclick: async () => {
          const res = await game.request({ t: 'spawnAt', at });
          if (res.ok && game.me) game.me.spawnAt = at;
          panels.clanTab('members');
        },
      }, at === 'banner' ? 'Banéret' : 'Fristaden'))),
    h('p.small.muted', `Raidfönster: ${clan.raidWindow}. Er bas kan bara anfallas när någon i klanen är online, en kort stund efter att ni loggat ut, eller under raidfönstret.`),
    h('div.row',
      h('button', { onclick: async () => await ask('Lämna klanen?', 'Du förlorar klanens bonusar och kan inte bygga i basen längre.', 'Lämna', true) && act('leave') }, 'Lämna klanen'),
      leader ? h('button.btn-danger', { onclick: async () => await ask('Upplösa klanen?', 'Basen blir ägarlös och förfaller.', 'Upplös', true) && act('disband') }, 'Upplös klanen') : null));
}

// --- No clan yet --------------------------------------------------------------------------------------------

function noClan(game) {
  const act = (op, args) => game.clanRequest(op, args);
  const name = h('input', { type: 'text', maxlength: 20, placeholder: 'Klanens namn' });
  const tag = h('input', { type: 'text', maxlength: 4, placeholder: 'TAGG', style: { textTransform: 'uppercase', width: '6em' } });
  for (const el of [name, tag]) el.addEventListener('keydown', (e) => e.stopPropagation());
  return h('div.mp-clan',
    game.invites.length ? h('section',
      h('h3', 'Inbjudningar'),
      game.invites.map((inv) => h('div.row',
        h('b', `[${inv.tag}] ${inv.name}`),
        h('button.btn-primary', { onclick: () => act('accept', { id: inv.id }) }, 'Gå med'),
        h('button', { onclick: () => act('decline', { id: inv.id }) }, 'Avböj')))) : null,
    h('section',
      h('h3', 'Din egen bas'),
      h('p.small.muted', 'Grunda en klan (du kan vara ensam), res ett banér i vildmarken och bygg din bas: smedja, förråd, bibliotek, brunn, djurhus och mer.'),
      h('div.row', h('label.field', h('span', 'Namn'), name), h('label.field', h('span', 'Tagg'), tag)),
      h('button.btn-primary', { onclick: () => act('create', { name: name.value.trim(), tag: tag.value.trim().toUpperCase() }) }, icon('flag', 20), 'Grunda klanen')));
}
