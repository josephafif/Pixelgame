// Clan bases on the server: the camp's buildings (src/net/mpbase.js). A
// building stands in the base as a structure; its level belongs to the clan
// and every member gets its bonuses (more health, attack and defense, a
// bigger bag and storage, cheaper research, pals that grow further …).
// Upgrades are paid from the clan vault, and from what you carry when the
// vault runs short.

import { COST_KEYS, buildingDef, maxLevel, wellPending } from '../src/game/base.js';
import { clanLevels, buildingOfStruct, BUILDING_SV, TOWN_LEVELS, baseStructId } from '../src/net/mpbase.js';
import { mpVirtualSave, mpInventorySizes } from '../src/net/mpsave.js';
import { canDo } from '../src/net/rules.js';
import * as players from './players.js';
import * as building from './building.js';
import * as clans from './clans.js';
import * as workers from './workers.js';

const RES_SV = { essence: 'essens', scrap: 'skrot', wood: 'trä', stone: 'sten', gold: 'guld', shards: 'stjärnskärvor' };
const FORGE_REACH = 3.4;
const TOWN_REACH = 6;

// --- Which buildings stand where -------------------------------------------------------------

function index(gs) {
  gs.basePlaced ??= new Map(); // clanId → Map(building id → structure)
  return gs.basePlaced;
}

/** A clan building was put up (or loaded): remember where it stands. */
export function attached(gs, st) {
  const id = buildingOfStruct(st.id);
  if (!id || !st.clanId) return;
  let m = index(gs).get(st.clanId);
  if (!m) index(gs).set(st.clanId, (m = new Map()));
  m.set(id, st);
}

/** … or taken down, or its clan is gone. */
export function detached(gs, st, clanId = st.clanId) {
  const id = buildingOfStruct(st.id);
  const m = id && clanId ? index(gs).get(clanId) : null;
  if (m?.get(id) === st) m.delete(id);
}

/** The clan's buildings that stand right now: Map(building id → structure). */
export function placed(gs, clanId) {
  return index(gs).get(clanId) ?? new Map();
}

export function clanBase(clan) {
  clan.base ??= {};
  clan.base.buildings ??= {};
  return clan.base;
}

/** Building levels that count for a clan ({} without buildings). */
export function levelsOfClan(gs, clan) {
  if (!clan) return {};
  return clanLevels(clanBase(clan), new Set(placed(gs, clan.id).keys()));
}

/** Building levels that count for player p (their clan's base). */
export function levelsFor(gs, p) {
  return levelsOfClan(gs, p.clanId ? gs.clans.get(p.clanId) : null);
}

/** Level of the building a structure is, for everyone to see. */
export function structureLevel(gs, st) {
  const id = buildingOfStruct(st.id);
  if (!id) return 0;
  const clan = st.clanId ? gs.clans.get(st.clanId) : null;
  return Math.max(1, clan?.base?.buildings?.[id] ?? 1);
}

/** Your own clan's building `id` within reach of p, or null. */
export function ownNear(gs, p, id, reach = FORGE_REACH) {
  if (!p.clanId) return null;
  const st = placed(gs, p.clanId).get(id);
  if (!st) return null;
  return (st.x + 0.5 - p.x) ** 2 + (st.y + 0.5 - p.y) ** 2 <= reach * reach ? st : null;
}

/** The forge p stands at: Fristaden's (common to rare weapons) or their clan's. */
export function forgeAt(gs, p) {
  if (ownNear(gs, p, 'forge')) return { town: false, level: levelsFor(gs, p).forge ?? 1 };
  const town = gs.data.base.buildings.find((b) => b.id === 'forge');
  if (town && (town.x - p.x) ** 2 + (town.y - p.y) ** 2 <= TOWN_REACH * TOWN_REACH) return { town: true, level: TOWN_LEVELS.forge };
  return null;
}

/** The single-player save's shape for p, with their clan's buildings (and the forge they stand at). */
export function saveFor(gs, p, forge = null) {
  const levels = levelsFor(gs, p);
  if (forge) levels.forge = forge.level;
  return mpVirtualSave(gs.data, gs.worldSeed, p.ch, p.inv, levels);
}

export function sizesFor(gs, p) {
  return mpInventorySizes(gs.data, levelsFor(gs, p));
}

// --- Paying ------------------------------------------------------------------------------------

/** What the vault and your own pockets hold together falls short of `cost`: the first shortfall, or null. */
export function shortfall(clan, p, cost) {
  for (const k of COST_KEYS) {
    const need = cost[k] ?? 0;
    const have = (clan.vault[k] ?? 0) + (p.ch.resources[k] ?? 0);
    if (need > have) return `Det fattas ${need - have} ${RES_SV[k]} (valvet och det du bär räknas ihop)`;
  }
  return null;
}

/** Pays `cost` from the clan vault first, then from what p carries. Returns what came from where. */
export function pay(clan, p, cost) {
  const paid = { vault: {}, own: {} };
  for (const k of COST_KEYS) {
    const need = cost[k] ?? 0;
    if (!need) continue;
    const fromVault = Math.min(clan.vault[k] ?? 0, need);
    clan.vault[k] = (clan.vault[k] ?? 0) - fromVault;
    p.ch.resources[k] = (p.ch.resources[k] ?? 0) - (need - fromVault);
    if (fromVault) paid.vault[k] = fromVault;
    if (need - fromVault) paid.own[k] = need - fromVault;
  }
  return paid;
}

export function refund(clan, p, paid) {
  for (const [k, n] of Object.entries(paid.vault)) clan.vault[k] = (clan.vault[k] ?? 0) + n;
  for (const [k, n] of Object.entries(paid.own)) p.ch.resources[k] = (p.ch.resources[k] ?? 0) + n;
}

// --- Changes everyone in the clan should feel ---------------------------------------------------

/** Buildings changed: new bonuses for every member online, the clan panel, and the sprite for onlookers. */
export function changed(gs, clan, st = null) {
  workers.sync(gs, clan); // a lodge built, moved or upgraded
  for (const id of clan.members.keys()) {
    const m = gs.byAccount.get(id);
    if (!m) continue;
    players.recomputeStats(gs, m);
    players.markMe(m);
    if (m.conn) gs.send(m, { t: 'invsize', ...sizesFor(gs, m) });
  }
  if (st) gs.broadcastTile(st.x, st.y, { t: 'wd', k: 'st+', st: building.structurePayload(st, gs) });
  clans.sendClan(gs, clan);
}

// --- Requests -------------------------------------------------------------------------------------

/** { t: 'base', op: 'upgrade', id } → problem text or null. */
export function request(gs, p, msg) {
  const clan = p.clanId ? gs.clans.get(p.clanId) : null;
  if (!clan) return 'Gå med i eller grunda en klan först';
  const id = String(msg.id ?? '');
  if (msg.op === 'upgrade') return upgrade(gs, p, clan, id);
  if (msg.op === 'well') return collectWell(gs, p, clan);
  if (msg.op === 'hire' || msg.op === 'fire' || msg.op === 'role') return workers.request(gs, p, clan, msg);
  return 'Okänd begäran';
}

function upgrade(gs, p, clan, id) {
  const def = buildingDef(gs.data, id);
  if (!def || !BUILDING_SV[id]) return 'Okänd byggnad';
  const role = clan.members.get(p.accountId)?.role ?? 'member';
  if (!canDo(role, 'build')) return 'Du får inte bygga här';
  const st = placed(gs, clan.id).get(id);
  if (!st) return `Bygg ${BUILDING_SV[id].toLowerCase()} i er bas först (Bygg-menyn)`;
  const base = clanBase(clan);
  const level = Math.max(1, base.buildings[id] ?? 1);
  if (level >= maxLevel(def)) return 'Redan högsta nivån';
  const next = def.levels[level];
  if ((p.ch.level ?? 1) < (next.playerLevel ?? 1)) return `Kräver nivå ${next.playerLevel}`;
  if (next.boss && !Object.keys(p.ch.extra.bosses ?? {}).length) return 'Besegra en boss först';
  const cost = Object.fromEntries(COST_KEYS.filter((k) => next[k]).map((k) => [k, next[k]]));
  const short = shortfall(clan, p, cost);
  if (short) return short;
  const paid = pay(clan, p, cost);
  if (id === 'well') {
    // Bank what the well made at its old rate.
    bankWell(gs, clan);
  }
  base.buildings[id] = level + 1;
  try {
    gs.db.tx(() => {
      gs.db.saveClan(clan);
      players.persist(gs, p);
      gs.db.log(p.accountId, 'base-upgrade', null, { clan: clan.id, building: id, level: level + 1, paid });
    });
  } catch (err) {
    base.buildings[id] = level;
    refund(clan, p, paid);
    gs.log.error('[base] upgrade failed', err);
    return 'Kunde inte uppgradera';
  }
  changed(gs, clan, st);
  for (const mid of clan.members.keys()) {
    const m = gs.byAccount.get(mid);
    if (m?.conn) gs.toast(m, `${p.name} uppgraderade ${BUILDING_SV[id].toLowerCase()} till nivå ${level + 1}!`, 'level');
  }
  gs.event(st.x + 0.5, st.y + 0.5, { k: 'fx', fx: 'levelup', x: st.x + 0.5, y: st.y + 0.5 }, 30);
  return null;
}

// --- The Essence Well ----------------------------------------------------------------------------------

function wellSave(gs, clan) {
  const base = clanBase(clan);
  return { base: { buildings: levelsOfClan(gs, clan), wellAt: base.wellAt ?? Date.now() } };
}

export function wellNow(gs, clan) {
  return wellPending(gs.data, wellSave(gs, clan));
}

/** Keeps what the well has made so far (before its rate changes). */
function bankWell(gs, clan) {
  const base = clanBase(clan);
  base.wellStore = (base.wellStore ?? 0) + wellNow(gs, clan);
  base.wellAt = Date.now();
}

function collectWell(gs, p, clan) {
  const st = ownNear(gs, p, 'well');
  if (!st) return 'Gå fram till er essensbrunn';
  const base = clanBase(clan);
  const n = wellNow(gs, clan) + (base.wellStore ?? 0);
  if (n <= 0) return 'Brunnen fylls fortfarande';
  base.wellAt = Date.now();
  base.wellStore = 0;
  p.ch.resources.essence = (p.ch.resources.essence ?? 0) + n;
  gs.db.tx(() => {
    gs.db.saveClan(clan);
    players.persist(gs, p);
  });
  players.markMe(p);
  clans.sendClan(gs, clan);
  gs.toast(p, `Du hämtade ${n} essens ur brunnen.`, 'component');
  gs.event(st.x + 0.5, st.y + 0.5, { k: 'fx', fx: 'holy', x: st.x + 0.5, y: st.y + 0.2 }, 24);
  return null;
}

// --- Walking up to a building -----------------------------------------------------------------------

/** The clan building (anyone's) closest to p within reach, or null. */
export function buildingNear(gs, p, reach = 1.9) {
  let best = null;
  let bestD = reach * reach;
  const tx = Math.floor(p.x);
  const ty = Math.floor(p.y);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const st = gs.world.structureAt(tx + dx, ty + dy);
      if (!st || st.def?.kind !== 'building') continue;
      const d = (st.x + 0.5 - p.x) ** 2 + (st.y + 0.5 - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
  }
  return best;
}

/** Use (E) at a clan building. Returns true when handled. */
export function use(gs, p, st) {
  const id = buildingOfStruct(st.id);
  if (!p.clanId || st.clanId !== p.clanId) {
    const tag = st.clanId ? gs.clans.get(st.clanId)?.tag : null;
    gs.toast(p, tag ? `Det här är [${tag}]s ${BUILDING_SV[id].toLowerCase()}.` : 'En övergiven byggnad.', 'warn');
    return true;
  }
  switch (id) {
    case 'forge':
      gs.send(p, { t: 'ui', panel: 'crafting' });
      break;
    case 'vault':
      gs.send(p, { t: 'ui', panel: 'storage' });
      break;
    case 'library':
      gs.send(p, { t: 'ui', panel: 'library' });
      break;
    case 'den':
      gs.send(p, { t: 'ui', panel: 'pals' });
      break;
    case 'lodge':
      gs.send(p, { t: 'ui', panel: { name: 'clan', tab: 'workers' } });
      break;
    case 'well': {
      const problem = collectWell(gs, p, gs.clans.get(p.clanId));
      if (problem) gs.toast(p, problem, 'info');
      break;
    }
    case 'hearth':
      p.hp = p.maxHp;
      gs.toast(p, 'Du vilar vid härden: full hälsa.', 'component');
      gs.send(p, { t: 'ui', panel: { name: 'base', focus: 'hearth' } });
      break;
    default:
      gs.send(p, { t: 'ui', panel: { name: 'base', focus: id } });
      break;
  }
  return true;
}

export { baseStructId };
