// Soldiers, squads and territories in multiplayer. The rules and the way a
// soldier walks and fights are single player's (src/game/army.js and
// territory.js); here the server runs them for every clan and decides.
//
// - Soldiers are clan workers trained at the clan's Training Grounds (the
//   roster in clan.base.workers, with a soldier's role). Squads live in
//   clan.base.army. Soldiers stand by the Training Grounds until a squad
//   gets an order. Near players they walk and fight for real; far from
//   everyone their march is simple and fights are decided as a whole.
// - Territories belong to clans. One state per square (gs.terr.map), saved
//   in meta 'territories'. A flag is taken by a clan standing at it with
//   nobody else there and no monsters about; a clan's square can only be
//   taken while that clan's base can be raided. Every square pays its clan
//   vault every hour.
// - Outposts near players stand in the world (palisade and flag); the
//   clients place them too, the same way (src/mp/outposts.js).
// - NPC factions (src/game/factions.js) hold land too: their bases are
//   outposts with their troops (and towers), their strategic AI runs here
//   for everyone and is saved in meta 'factions'. Their armies march as a
//   whole far from players; close to one they walk the land for real.

import {
  isSoldier, roleDef, roleTitle, trainProblem, startTraining, finishTraining, gearUpgrade, soldierStats, soldierPower,
  addXp, ensureArmy, createSquad, assignSoldier, pruneSquads, squadOf, makeOrder, postFor, stepSoldier, hurtSoldier,
  squadHealth, stanceParams, STANCES, barracksCap, soldierCount, workerCount, makeSoldier, problemSv,
} from '../src/game/army.js';
import {
  territoryConfig, territoryAt, parseKey, outpostFor, defendersFor, outpostLevel, monsterPower, abstractBattle,
  stepCapture, incomeFor, frontier, defenseFactor, placeOutpost, removeOutpost, outpostDormant,
} from '../src/game/territory.js';
import {
  createFactions, factionById, troopsFor, troopPower, stepFactions, loseToOthers, takeFor, factionConfig, factionSquares,
  armyArrives, factionRef, genitiveSv,
} from '../src/game/factions.js';
import { canDo } from '../src/net/rules.js';
import { workerStats } from '../src/game/workers.js';
import * as base from './base.js';
import * as clans from './clans.js';
import * as combat from './combat.js';
import * as enemies from './enemies.js';
import * as workers from './workers.js';

const LIVE = 64;
const ACTIVATE = 70;
const DEACTIVATE = 92;
const CLEARED_FOR = 12 * 60 * 1000;
const HOUR = 3600 * 1000;
const NEUTRAL_COLOR = '#b8b8c8';
const ARMY_LIVE = 56; // a faction's army closer than this to a player walks the land for real
const ARMY_GONE = 84;
const CLAN_COLORS = ['#3fa86a', '#3f6fd8', '#c8364a', '#e0a030', '#9a5cff', '#3fb0b0', '#e86a2a', '#ff7ad8'];

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** A clan's colour on maps and flags (the same for everyone). */
export function clanColor(clanId) {
  let h = 0;
  for (const ch of String(clanId ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CLAN_COLORS[h % CLAN_COLORS.length];
}

function state(gs) {
  if (!gs.terr) {
    gs.terr = { map: new Map(), active: new Map(), dirty: true, sendT: 0, saveT: 0, slowT: 0, checkT: 0 };
    try {
      for (const [key, e] of JSON.parse(gs.db.meta('territories') ?? '[]')) {
        gs.terr.map.set(key, { owner: e.owner ?? null, since: e.since ?? 0, cleared: e.cleared ?? 0, capture: e.owner ? 1 : 0, by: null, attackedUntil: 0 });
      }
    } catch (err) {
      gs.log?.warn?.('[army] territories unreadable', err.message);
    }
  }
  return gs.terr;
}

function entry(gs, key) {
  const t = state(gs);
  let e = t.map.get(key);
  if (!e) t.map.set(key, (e = { owner: null, since: 0, cleared: 0, capture: 0, by: null, attackedUntil: 0 }));
  return e;
}

function save(gs) {
  const t = state(gs);
  const list = [...t.map].filter(([, e]) => e.owner || e.cleared > Date.now()).map(([k, e]) => [k, { owner: e.owner, since: e.since, cleared: e.cleared }]);
  gs.db.setMeta('territories', JSON.stringify(list));
}

function changed(gs) {
  state(gs).dirty = true;
}

export function site(gs, key) {
  const { tx, ty } = parseKey(key);
  return outpostFor(gs.world, gs.data, tx, ty);
}

export function ownedBy(gs, clanId) {
  return [...state(gs).map].filter(([, e]) => e.owner === clanId).map(([k]) => k);
}

export function armyOf(clan) {
  const b = base.clanBase(clan);
  b.army = ensureArmy(b.army);
  return b.army;
}

function roster(clan) {
  const b = base.clanBase(clan);
  b.workers ??= [];
  return b.workers;
}

function levels(gs, clan) {
  const lv = base.levelsOfClan(gs, clan);
  return { training: lv.training ?? 0, forge: lv.forge ?? 0 };
}

/** Where a clan's soldiers stand without orders: by its Training Grounds (or its banner). */
function homeOf(gs, clan) {
  const st = base.placed(gs, clan.id).get('training') ?? base.placed(gs, clan.id).get('lodge');
  if (st) return { x: st.x + 0.5, y: st.y + 2.2 };
  return { x: 0.5, y: 3 };
}

function soldiersOf(gs, clanId) {
  const out = [];
  for (const w of gs.workers?.values() ?? []) if (w.clanId === clanId && isSoldier(gs.data, w.role) && !w.dead) out.push(w);
  return out;
}

function toClan(gs, clan, text, kind = 'info') {
  for (const id of clan.members.keys()) {
    const m = gs.byAccount.get(id);
    if (m?.conn) gs.toast(m, text, kind);
  }
}

// --- Every tick ------------------------------------------------------------------------------------

export function update(gs, dt) {
  const t = state(gs);
  // (A server can do without outposts: config.outposts = false.)
  const on = gs.config?.outposts !== false;
  const fx = on && gs.config?.factions !== false ? factions(gs) : null;
  t.checkT -= dt;
  if (t.checkT <= 0 && on) {
    t.checkT = 0.5;
    outposts(gs);
    if (fx) liveArmies(gs);
  }
  stepSoldiers(gs, dt);
  if (on) capture(gs, dt);
  if (fx) {
    stepFactions(fx, factionCtx(gs), dt);
    towers(gs, dt);
    t.factionT = (t.factionT ?? 0) - dt;
    if (t.factionT <= 0) {
      t.factionT = 2;
      fx.lastAt = Date.now();
      asleep(gs);
      // Armies on the march show on everyone's map.
      if (fx.armies.length || t.hadArmies) t.dirty = true;
      t.hadArmies = fx.armies.length > 0;
    }
  }
  t.slowT -= dt;
  if (t.slowT <= 0) {
    t.slowT = 1;
    for (const clan of gs.clans.values()) {
      if (!clan.base?.workers?.length && !ownedBy(gs, clan.id).length) continue;
      training(gs, clan);
      pruneSquads(gs.data, armyOf(clan), roster(clan));
      cautious(gs, clan);
      abstract(gs, clan);
      raids(gs, clan);
      income(gs, clan);
      sendSquads(gs, clan);
    }
  }
  t.sendT -= dt;
  if (t.dirty && t.sendT <= 0) {
    t.sendT = 1;
    t.dirty = false;
    gs.broadcast(territoryPayload(gs));
  }
  t.saveT -= dt;
  if (t.saveT <= 0) {
    t.saveT = 20;
    save(gs);
    if (fx) saveFactions(gs);
  }
}

/**
 * Every territory someone holds or is taking, for the clients' maps:
 * { t: 'terr', list, factions, armies } (a faction's land has owner 'f:<id>'
 * and its base's tier).
 */
export function territoryPayload(gs) {
  const list = [];
  const fx = gs.factions;
  for (const [key, e] of state(gs).map) {
    const attacked = e.attackedUntil > gs.time;
    if (!e.owner && !(e.capture > 0) && !attacked) continue;
    if (!e.owner && fx?.owned[key]) continue; // (sent below, with the faction)
    const clan = e.owner ? gs.clans.get(e.owner) : null;
    list.push({
      key, owner: e.owner, tag: clan?.tag ?? null, color: e.owner ? clanColor(e.owner) : null,
      cap: Math.round((e.capture ?? 0) * 100) / 100, by: e.by ?? null, att: attacked ? 1 : 0,
    });
  }
  if (!fx) return { t: 'terr', list };
  for (const [key, fe] of Object.entries(fx.owned)) {
    const f = factionById(fx, fe.faction);
    const e = state(gs).map.get(key);
    list.push({
      key, owner: factionRef(fe.faction), tag: f?.sv ?? f?.name ?? '?', color: f?.color ?? '#c8364a', base: fe.tier,
      cap: Math.round((e?.capture ?? 0) * 100) / 100, by: e?.by ?? null, att: 0,
    });
  }
  return {
    t: 'terr', list,
    factions: fx.list.map((f) => {
      const seat = factionSeat(gs, f);
      return {
        id: f.id, name: f.sv ?? f.name, color: f.color, personality: f.personality, quality: f.quality, alive: f.alive,
        squares: factionSquares(fx, f.id).length, at: seat,
      };
    }),
    armies: fx.armies.map((a) => {
      const to = site(gs, a.to);
      return {
        id: a.id, f: a.faction, x: Math.round(a.x * 10) / 10, y: Math.round(a.y * 10) / 10, to: a.to,
        toX: to?.x ?? a.x, toY: to?.y ?? a.y, troops: a.troops,
      };
    }),
  };
}

/** Where a clan's squads are and what they do, for its members' maps (every second while it has some). */
function sendSquads(gs, clan) {
  const army = armyOf(clan);
  if (!army.squads.length) return;
  const soldiers = soldiersOf(gs, clan.id);
  const list = army.squads.map((sq) => {
    const m = soldiers.filter((w) => sq.members.includes(w.id));
    if (!m.length) return { id: sq.id, n: 0 };
    return {
      id: sq.id, n: m.length, x: Math.round((m.reduce((a, w) => a + w.x, 0) / m.length) * 10) / 10, y: Math.round((m.reduce((a, w) => a + w.y, 0) / m.length) * 10) / 10,
      hp: Math.round(squadHealth(m) * 100) / 100, fight: m.some((w) => w.state === 'fight') ? 1 : 0, march: m.some((w) => w.state === 'march') ? 1 : 0,
      soldiers: m.map((w) => [w.id, Math.ceil(Math.max(0, w.hp)), Math.ceil(w.maxHp)]),
    };
  });
  for (const id of clan.members.keys()) {
    const p = gs.byAccount.get(id);
    if (p?.conn) gs.send(p, { t: 'squads', list });
  }
}

function training(gs, clan) {
  let done = false;
  for (const rec of roster(clan)) {
    if (!finishTraining(rec, Date.now())) continue;
    done = true;
    const look = workers.lookOf(clan, rec.id);
    toClan(gs, clan, `${look.name} är färdigtränad: nu ${roleDef(gs.data, rec.role)?.sv?.toLowerCase() ?? 'soldat'}! Sätt hen i en trupp på strategikartan (N).`, 'level');
  }
  if (done) {
    clan.dirty = true;
    gs.db.saveClan(clan);
    workers.sync(gs, clan);
    clans.sendClan(gs, clan);
  }
}

function stepSoldiers(gs, dt) {
  if (!gs.workers?.size) return;
  const ctxs = new Map();
  for (const w of gs.workers.values()) {
    if (w.dead || !isSoldier(gs.data, w.role)) continue;
    const clan = gs.clans.get(w.clanId);
    if (!clan) continue;
    let ctx = ctxs.get(clan.id);
    if (!ctx) ctxs.set(clan.id, (ctx = soldierCtx(gs, clan)));
    gs.world.gateFilter = (s) => Boolean(s.clanId) && s.clanId === clan.id;
    stepSoldier(w, ctx, dt);
    gs.world.gateFilter = null;
  }
}

function soldierCtx(gs, clan) {
  const army = armyOf(clan);
  const lv = levels(gs, clan);
  const home = homeOf(gs, clan);
  const list = roster(clan);
  return {
    world: gs.world, time: gs.time,
    stats: (s) => {
      const rec = list.find((r) => r.id === s.id);
      if (!rec) return null;
      const key = `${rec.role}|${rec.gear}|${rec.rank}|${lv.training}`;
      if (s.statsKey !== key) {
        s.statsKey = key;
        s.stats = soldierStats(gs.data, rec, Math.max(1, lv.training));
        const was = s.maxHp;
        s.maxHp = s.stats.hp;
        if (!was || s.hp > s.maxHp) s.hp = s.maxHp;
        else s.hp = Math.min(s.maxHp, s.hp + Math.max(0, s.maxHp - was));
      }
      return s.stats;
    },
    post: (s) => postOf(gs, clan, army, s, home),
    stance: (s) => squadOf(army, s.id)?.stance ?? 'defensive',
    foes: (x, y, r) => [...gs.enemiesNear(x, y, r)].filter((e) => !e.dead && !e.submerged && (e.x - x) ** 2 + (e.y - y) ** 2 <= r * r),
    hit: (s, foe, dmg) => {
      combat.damageEnemy(gs, foe, dmg, { canCrit: false, depth: 1, source: 'soldier', fromX: s.x, fromY: s.y, knockback: 0.3 });
      gs.event(s.x, s.y, { k: 'wswing', id: s.eid }, 24);
      soldierHit(gs, s, foe);
    },
    shoot: (s, foe, dmg) => {
      const pr = combat.spawnProjectile(gs, {
        x: s.x, y: s.y - 0.3, angle: Math.atan2(foe.y - s.y, foe.x - s.x), speed: 13, damage: dmg, range: (s.stats?.reach ?? 6) + 2,
        sprite: 'arrow', size: 2, color: '#e8d8b0', kind: 'shot', source: 'soldier',
      });
      if (pr) {
        // Like a turned shot: it hurts monsters, never players.
        pr.turned = true;
        pr.soldier = s.eid;
      }
    },
    repairTarget: (s, post) => repairTarget(gs, clan, s, post),
    repair: (s, st, amount) => {
      st.hp = Math.min(st.def.hp, st.hp + amount);
      gs.event(st.x + 0.5, st.y + 0.5, { k: 'fx', fx: 'text', x: st.x + 0.5, y: st.y - 0.2, text: `+${Math.round(amount)}`, color: '#8ef0a0' }, 20);
    },
    live: (s) => {
      for (const p of gs.playersNear(s.x, s.y, LIVE)) if (!p.dead) return true;
      return false;
    },
  };
}

function postOf(gs, clan, army, s, home) {
  const squad = squadOf(army, s.id);
  if (squad) {
    const leader = squad.order.kind === 'follow' ? gs.byAccount.get(squad.order.leader) : null;
    return postFor(squad, squad.members.indexOf(s.id), { home, leader: leader && !leader.dead ? leader : null, clock: gs.time });
  }
  const free = soldiersOf(gs, clan.id).filter((x) => !squadOf(army, x.id));
  return postFor(null, Math.max(0, free.indexOf(s)), { home });
}

function repairTarget(gs, clan, s, post) {
  s.repairScanT = (s.repairScanT ?? 0) - 1;
  if (s.repairScanT > 0 && s.repairSt && !s.repairSt.dead && s.repairSt.hp < s.repairSt.def.hp) return s.repairSt;
  s.repairScanT = 30;
  let best = null;
  let bestD = 12 * 12;
  for (const st of gs.structures.values()) {
    if (st.clanId !== clan.id || st.dead || st.hp >= st.def.hp || st.def.kind === 'building') continue;
    const d = (st.x + 0.5 - post.x) ** 2 + (st.y + 0.5 - post.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  s.repairSt = best;
  return best;
}

/** A soldier's blow or arrow landed (combat.js calls this for arrows). */
export function soldierHit(gs, s, e) {
  if (typeof s === 'number') s = gs.workers?.get(s);
  if (!s || s.dead) return;
  if (!e.dead) {
    e.brawl = s.eid;
    return;
  }
  const clan = gs.clans.get(s.clanId);
  const rec = clan ? roster(clan).find((r) => r.id === s.id) : null;
  if (rec && addXp(gs.data, rec, e.boss ? 30 : e.elite ? 8 : 3)) {
    clan.dirty = true;
    gs.event(s.x, s.y, { k: 'fx', fx: 'text', x: s.x, y: s.y - 1.1, text: 'GRAD UPP', color: '#ffd24a' }, 24);
  }
}

/** A monster's blow on a soldier (enemies.js). */
export function hurt(gs, s, damage) {
  if (!s || s.dead) return;
  const dmg = Math.max(1, Math.round(damage));
  gs.event(s.x, s.y, { k: 'npchurt', id: s.eid, n: dmg }, 24);
  if (hurtSoldier(s, dmg)) fell(gs, s);
}

function fell(gs, s) {
  const clan = gs.clans.get(s.clanId);
  gs.event(s.x, s.y, { k: 'kill', id: s.eid, x: s.x, y: s.y, r: s.r }, 24);
  if (!clan) return;
  workers.remove(gs, clan, s, `${s.name} stupade i strid.`);
}

/** The soldier a monster fights (enemies.js): the one hitting it, or for an outpost's guards any soldier close by. */
export function soldierFoe(gs, e, dt) {
  const b = e.brawl ? gs.workers?.get(e.brawl) : null;
  if (b && !b.dead && !b.ghost && dist2(b, e) < 14 * 14) return b;
  e.brawl = 0;
  if (!(e.outpost || e.raid || e.army) || !gs.workers?.size) return null;
  e.brawlScanT = (e.brawlScanT ?? 0) - dt;
  if (e.brawlScanT > 0) return null;
  e.brawlScanT = 0.5;
  const sight = e.def.sight ?? 7;
  let best = null;
  let bestD = sight * sight;
  for (const s of gs.workers.values()) {
    if (s.dead || s.ghost || !isSoldier(gs.data, s.role)) continue;
    const d = dist2(s, e);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  e.brawl = best?.eid ?? 0;
  return best;
}

function cautious(gs, clan) {
  const army = armyOf(clan);
  const soldiers = soldiersOf(gs, clan.id);
  for (const squad of army.squads) {
    const p = stanceParams(squad.stance);
    if (!p.retreatAt || squad.order.kind === 'retreat') continue;
    const members = soldiers.filter((s) => squad.members.includes(s.id));
    if (members.length && squadHealth(members) < p.retreatAt) {
      squad.order = { kind: 'retreat' };
      clan.dirty = true;
      toClan(gs, clan, `${squad.name} är svårt skadad och drar sig tillbaka.`, 'warn');
      clans.sendClan(gs, clan);
    }
  }
}

// --- Outposts near players ---------------------------------------------------------------------------

function outposts(gs) {
  const t = state(gs);
  const want = new Set();
  const claims = gs.claims();
  const dormant = (s) => outpostDormant(s, claims, gs.rules.claimRadius);
  for (const p of gs.players.values()) {
    if (p.dead && !p.conn) continue;
    const { tx, ty } = territoryAt(gs.data, p.x, p.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const s = outpostFor(gs.world, gs.data, tx + dx, ty + dy);
        if (s && dist2(s, p) < ACTIVATE * ACTIVATE && !dormant(s)) want.add(s.key);
      }
    }
  }
  for (const key of want) if (!t.active.has(key)) activate(gs, site(gs, key));
  for (const [key, a] of t.active) {
    if (want.has(key)) {
      if (a.tier !== tierOf(gs, key)) {
        // A base that grew (or changed hands) is built anew.
        deactivate(gs, key, { keepTroops: true });
        activate(gs, a.site);
      }
      continue;
    }
    let near = false;
    for (const p of gs.playersNear(a.site.x, a.site.y, DEACTIVATE)) if (p) near = true;
    if (!near || dormant(a.site)) deactivate(gs, key);
  }
}

/** The base a faction keeps on a square ('camp' for everyone else's outposts). */
function tierOf(gs, key) {
  return gs.factions?.owned[key]?.tier ?? 'camp';
}

function factionAt(gs, key) {
  const fe = gs.factions?.owned[key];
  return fe ? factionById(gs.factions, fe.faction) : null;
}

function flagColor(gs, key) {
  const owner = state(gs).map.get(key)?.owner;
  if (owner) return clanColor(owner);
  return factionAt(gs, key)?.color ?? NEUTRAL_COLOR;
}

function activate(gs, s) {
  const tier = tierOf(gs, s.key);
  const structures = placeOutpost(gs.world, gs.data, s, flagColor(gs, s.key), tier);
  const a = { site: s, structures, defenders: [], tier };
  state(gs).active.set(s.key, a);
  const e = entry(gs, s.key);
  const f = factionAt(gs, s.key);
  if (f) {
    // A faction's base: its garrison (still standing from before, or anew).
    const alive = [...gs.enemies.values()].filter((m) => !m.dead && m.outpost === s.key && m.faction === f.id);
    if (alive.length) a.defenders = alive;
    else spawnTroops(gs, a, f, troopsFor(f, tier, gs.factions.owned[s.key].garrison));
  } else if (!e.owner && !(e.cleared > Date.now())) {
    spawnDefenders(gs, a);
  }
}

/** A faction's troops at an outpost: its garrison, or (raid) an army coming for the flag. */
function spawnTroops(gs, a, f, list, { raid = false } = {}) {
  const s = a.site;
  const level = Math.max(outpostLevel(s), 1);
  const a0 = Math.random() * Math.PI * 2;
  list.forEach((d, i) => {
    const ang = (i / 7) * Math.PI * 2;
    const x = raid ? s.x + Math.cos(a0) * 14 + (i % 3) : s.x + Math.cos(ang) * 2;
    const y = raid ? s.y + Math.sin(a0) * 14 + Math.floor(i / 3) : s.y + Math.sin(ang) * 2;
    const spot = gs.world.findFreeSpot(x, y, 0.45, 'enemy', null);
    if (!spot) return;
    const m = enemies.spawnEnemy(gs, d.kind, spot.x, spot.y, { level, elite: d.elite });
    if (!m) return;
    Object.assign(m, { faction: f.id, homeX: s.x, homeY: s.y, keep: true });
    if (raid) m.raid = s.key;
    else {
      m.outpost = s.key;
      a.defenders.push(m);
    }
  });
}

function spawnDefenders(gs, a) {
  const s = a.site;
  const biome = gs.data.byId.biomes.get(s.biome) ?? gs.world.biomeAt(s.fx, s.fy);
  defendersFor(gs.data, s).forEach((d, i) => {
    const ang = (i / 7) * Math.PI * 2;
    const spot = gs.world.findFreeSpot(s.x + Math.cos(ang) * 2, s.y + Math.sin(ang) * 2, 0.45, 'enemy', null);
    if (!spot) return;
    const e = enemies.spawnEnemy(gs, d.kind, spot.x, spot.y, { level: outpostLevel(s), elite: d.elite, biome });
    if (!e) return;
    e.outpost = s.key;
    e.homeX = s.x;
    e.homeY = s.y;
    e.keep = true; // (not despawned like wandering monsters)
    a.defenders.push(e);
  });
}

function vanish(gs, m) {
  m.dead = true;
  m.vanished = true;
  gs.enemies.delete(m.id);
}

function deactivate(gs, key, { keepTroops = false } = {}) {
  const t = state(gs);
  const a = t.active.get(key);
  if (!a) return;
  removeOutpost(gs.world, a.structures);
  t.active.delete(key);
  if (keepTroops) return;
  for (const e of a.defenders) if (!e.dead) vanish(gs, e);
  // Raiders still at it: a faction's fight goes on as a whole (an army right by the flag); monsters give up.
  const byFaction = new Map();
  for (const m of [...gs.enemies.values()]) {
    if (m.dead || m.raid !== key) continue;
    vanish(gs, m);
    if (m.faction && factionById(gs.factions, m.faction)?.alive) byFaction.set(m.faction, (byFaction.get(m.faction) ?? 0) + 1);
  }
  for (const [fid, n] of byFaction) {
    const f = factionById(gs.factions, fid);
    gs.factions.armies.push({ id: gs.factions.nextArmy++, faction: fid, kind: 'attack', from: f.hq, to: key, troops: n, x: a.site.x, y: a.site.y });
  }
}

function setFlag(gs, key) {
  const a = state(gs).active.get(key);
  if (!a) return;
  const color = flagColor(gs, key);
  for (const st of a.structures) st.color = color;
}

function raidable(gs, clanId) {
  return Boolean(gs.raidState?.(clanId)?.raidable);
}

function capture(gs, dt) {
  const t = state(gs);
  if (!t.active.size) return;
  const cfg = territoryConfig(gs.data);
  const R = cfg.captureRadius;
  for (const [key, a] of t.active) {
    const s = a.site;
    const e = entry(gs, key);
    const fe = gs.factions?.owned[key];
    const f = fe ? factionById(gs.factions, fe.faction) : null;
    if (f) {
      // A faction's garrison is what still stands.
      if (a.defenders.length) fe.garrison = a.defenders.filter((d) => !d.dead).length;
    } else if (a.defenders.length && a.defenders.every((d) => d.dead && !d.vanished)) {
      a.defenders = [];
      e.cleared = Date.now() + CLEARED_FOR;
      changed(gs);
    }
    const here = new Set();
    for (const p of gs.playersNear(s.x, s.y, R)) if (!p.dead && p.clanId && dist2(p, s) < R * R) here.add(p.clanId);
    for (const w of gs.workers?.values() ?? []) {
      if (!w.dead && !w.ghost && isSoldier(gs.data, w.role) && dist2(w, s) < R * R) here.add(w.clanId);
    }
    let monsters = false;
    const troops = new Set(); // factions with troops by the flag
    for (const m of gs.enemiesNear(s.x, s.y, 7)) {
      if (m.dead || m.submerged || dist2(m, s) >= 49) continue;
      monsters = true;
      if (m.faction && factionById(gs.factions, m.faction)?.alive) troops.add(m.faction);
    }
    const before = e.capture ?? 0;
    if (f) {
      // A faction's base: its troops by the flag hold it; with them gone, a clan standing there alone takes it.
      const list = [...here];
      const hold = troops.has(f.id);
      if (list.length === 1 && !hold) {
        if (e.by !== list[0]) {
          e.by = list[0];
          e.capture = 0;
        }
        e.capture = stepCapture(e.capture, { friendly: true, hostile: false, dt, seconds: cfg.captureSeconds });
      } else if (!list.length) {
        e.capture = stepCapture(before, { friendly: false, hostile: hold, dt, seconds: cfg.captureSeconds });
        if (e.capture <= 0) e.by = null;
      }
      if (e.capture >= 1 && e.by) {
        const clan = gs.clans.get(e.by);
        if (clan && ownedBy(gs, clan.id).length < cfg.maxOwned) {
          loseToOthers(gs.factions, key);
          take(gs, key, clan.id, fe.tier === 'hq'
            ? `[${clan.tag}] tog ${genitiveSv(f.sv ?? f.name)} högkvarter! Deras arméer får det svårt nu.`
            : `[${clan.tag}] tog ett ${fe.tier === 'stronghold' ? 'fäste' : 'läger'} från ${f.sv ?? f.name}!`);
          saveFactions(gs);
        } else {
          take(gs, key, e.by);
        }
      }
    } else if (e.owner) {
      const others = [...here].filter((c) => c !== e.owner);
      const hostile = monsters || (others.length > 0 && raidable(gs, e.owner));
      e.capture = stepCapture(before, { friendly: here.has(e.owner), hostile, dt, seconds: cfg.captureSeconds });
      if (hostile && !here.has(e.owner)) e.attackedUntil = gs.time + 3;
      if (e.capture <= 0) {
        // Whoever stands at the flag takes it: a faction's troops, another clan, or monsters (then nobody holds it).
        if (troops.size && !others.length) factionTakes(gs, key, [...troops][0]);
        else lose(gs, key, others.length === 1 ? others[0] : null);
      }
    } else {
      const list = [...here];
      if (list.length === 1 && !monsters) {
        if (e.by !== list[0]) {
          e.by = list[0];
          e.capture = 0;
        }
        e.capture = stepCapture(e.capture, { friendly: true, hostile: false, dt, seconds: cfg.captureSeconds });
      } else if (!list.length) {
        e.capture = stepCapture(before, { friendly: false, hostile: monsters, dt, seconds: cfg.captureSeconds });
        if (e.capture <= 0) e.by = null;
      }
      if (e.capture >= 1 && e.by) take(gs, key, e.by);
    }
    if (Math.abs((e.capture ?? 0) - before) > 0.04 || (e.capture > 0 && e.capture < 1 && Math.floor(gs.time) !== Math.floor(gs.time - dt))) changed(gs);
  }
}

function take(gs, key, clanId, text = null) {
  const clan = gs.clans.get(clanId);
  const e = entry(gs, key);
  if (!clan) return;
  const cfg = territoryConfig(gs.data);
  if (ownedBy(gs, clanId).length >= cfg.maxOwned) {
    e.capture = 0.99;
    if (!(e.fullToldAt > gs.time - 30)) {
      e.fullToldAt = gs.time;
      toClan(gs, clan, `Klanen kan hålla högst ${cfg.maxOwned} territorier.`, 'warn');
    }
    return;
  }
  e.owner = clanId;
  e.since = Date.now();
  e.capture = 1;
  e.by = null;
  setFlag(gs, key);
  const s = site(gs, key);
  if (s) gs.event(s.x, s.y, { k: 'fx', fx: 'levelup', x: s.x, y: s.y - 1 }, 40);
  const pay = Object.entries(incomeFor(gs.data, s?.tier ?? 1)).map(([k, n]) => `${n} ${{ scrap: 'skrot', essence: 'essens', wood: 'trä', stone: 'sten' }[k] ?? k}`).join(', ');
  toClan(gs, clan, text ? `${text} Den ger ${pay} i timmen till valvet.` : `[${clan.tag}] tog utposten! Den ger ${pay} i timmen till valvet.`, 'legendary');
  gs.log?.info?.(`[army] ${clan.tag} took ${key}`);
  changed(gs);
  save(gs);
}

function lose(gs, key, toClanId = null) {
  const e = entry(gs, key);
  const old = e.owner ? gs.clans.get(e.owner) : null;
  e.owner = null;
  e.capture = 0;
  e.by = toClanId;
  e.cleared = 0;
  setFlag(gs, key);
  if (old) toClan(gs, old, 'Ni har förlorat en utpost! Ta tillbaka den på strategikartan (N).', 'warn');
  const a = state(gs).active.get(key);
  if (a && !toClanId && !a.defenders.some((d) => !d.dead)) spawnDefenders(gs, a);
  changed(gs);
  save(gs);
}

// --- Far away: the same numbers, as a whole ---------------------------------------------------------

function power(gs, clan, members) {
  const lv = levels(gs, clan);
  let sum = 0;
  for (const s of members) {
    const rec = roster(clan).find((r) => r.id === s.id);
    if (rec) sum += soldierPower(gs.data, rec, Math.max(1, lv.training), Math.max(0.05, s.hp / s.maxHp));
  }
  return sum;
}

function losses(gs, members, share) {
  for (const s of members) {
    const hit = s.maxHp * share * (0.7 + Math.random() * 0.6);
    if (hit >= s.hp) hurt(gs, s, s.hp + 1);
    else s.hp -= hit;
  }
}

/** Soldiers of a clan holding a square (defend, hold or patrol there, close by). */
function garrison(gs, clan, key) {
  const s = site(gs, key);
  if (!s) return [];
  const army = armyOf(clan);
  const ids = new Set(army.squads
    .filter((sq) => ['defend', 'hold', 'patrol'].includes(sq.order.kind) && (sq.order.key === key || (sq.order.x - s.x) ** 2 + (sq.order.y - s.y) ** 2 < 100))
    .flatMap((sq) => sq.members));
  return soldiersOf(gs, clan.id).filter((w) => ids.has(w.id) && dist2(w, s) < 14 * 14);
}

function abstract(gs, clan) {
  const army = armyOf(clan);
  const t = state(gs);
  for (const squad of army.squads) {
    const o = squad.order;
    if (o.kind !== 'attack' || !o.key || t.active.has(o.key)) continue;
    const e = entry(gs, o.key);
    if (e.owner === clan.id) continue;
    const s = site(gs, o.key);
    if (!s || outpostDormant(s, gs.claims(), gs.rules.claimRadius)) continue;
    const members = soldiersOf(gs, clan.id).filter((w) => squad.members.includes(w.id));
    if (!members.length || !members.every((w) => w.ghost && dist2(w, s) < 36)) continue;
    let defense;
    let foe = null;
    const fe = gs.factions?.owned[o.key];
    const ff = fe ? factionById(gs.factions, fe.faction) : null;
    if (ff) {
      // A faction's base: its garrison (and walls) against the squad.
      const res = abstractBattle(power(gs, clan, members), troopPower(gs.data, ff, fe.tier, fe.garrison, s) * 1.25);
      losses(gs, members, res.attackerLoss * 0.6);
      if (res.win && members.some((w) => !w.dead)) {
        loseToOthers(gs.factions, o.key);
        take(gs, o.key, clan.id, `${squad.name} tog ${fe.tier === 'hq' ? 'högkvarteret' : 'en bas'} från ${ff.sv ?? ff.name}!`);
        squad.order = { kind: 'defend', key: o.key, x: s.x, y: s.y };
        saveFactions(gs);
      } else {
        fe.garrison = Math.max(1, Math.round(fe.garrison * (1 - res.defenderLoss)));
        squad.order = { kind: 'retreat' };
        toClan(gs, clan, `${squad.name} slogs tillbaka av ${ff.sv ?? ff.name} och vänder hem.`, 'warn');
      }
      clan.dirty = true;
      clans.sendClan(gs, clan);
      continue;
    }
    if (e.owner) {
      foe = gs.clans.get(e.owner);
      if (!foe || !raidable(gs, e.owner)) {
        squad.order = { kind: 'retreat' };
        toClan(gs, clan, `${squad.name} kan inte anfalla [${foe?.tag ?? '?'}] just nu: deras bas går inte att anfalla. Truppen vänder hem.`, 'warn');
        clan.dirty = true;
        continue;
      }
      const g = garrison(gs, foe, o.key);
      defense = (power(gs, foe, g) + 15 * s.tier) * defenseFactor(gs.data, ownedBy(gs, foe.id).length, frontier(ownedBy(gs, foe.id)));
      const res = abstractBattle(power(gs, clan, members), defense);
      losses(gs, members, res.attackerLoss * 0.6);
      losses(gs, g, res.win ? res.defenderLoss * 0.6 : Math.min(0.5, res.defenderLoss));
      if (res.win) {
        lose(gs, o.key, null);
        take(gs, o.key, clan.id);
        squad.order = { kind: 'defend', key: o.key, x: s.x, y: s.y };
      } else {
        squad.order = { kind: 'retreat' };
        toClan(gs, clan, `${squad.name} slogs tillbaka vid [${foe.tag}]s utpost.`, 'warn');
      }
    } else {
      const cleared = e.cleared > Date.now();
      defense = cleared ? 0 : monsterPower(gs.data, defendersFor(gs.data, s), outpostLevel(s));
      const res = abstractBattle(power(gs, clan, members), defense);
      if (!cleared) losses(gs, members, res.attackerLoss * 0.6);
      if (res.win && members.some((w) => !w.dead)) {
        e.cleared = Date.now() + CLEARED_FOR;
        take(gs, o.key, clan.id);
        squad.order = { kind: 'defend', key: o.key, x: s.x, y: s.y };
      } else {
        squad.order = { kind: 'retreat' };
        toClan(gs, clan, `${squad.name} slogs tillbaka vid utposten och vänder hem.`, 'warn');
      }
    }
    clan.dirty = true;
    clans.sendClan(gs, clan);
  }
}

function online(gs, clan) {
  for (const id of clan.members.keys()) if (gs.byAccount.get(id)?.conn) return true;
  return false;
}

/** Monsters try to take a clan's squares back now and then (while someone in the clan plays). */
function raids(gs, clan) {
  const owned = ownedBy(gs, clan.id);
  if (!owned.length || !online(gs, clan)) return;
  const cfg = territoryConfig(gs.data);
  const b = base.clanBase(clan);
  b.raidT ??= cfg.raidEveryMinutes * 60;
  b.raidT -= 1;
  if (b.raidT > 0) return;
  b.raidT = cfg.raidEveryMinutes * 60 * (0.75 + Math.random() * 0.5);
  const key = owned[Math.floor(Math.random() * owned.length)];
  const s = site(gs, key);
  if (!s) return;
  const list = defendersFor(gs.data, s);
  for (let i = 0; i < Math.floor(owned.length / 4); i++) list.push(list[i % list.length]);
  const e = entry(gs, key);
  e.attackedUntil = gs.time + 60;
  changed(gs);
  const a = state(gs).active.get(key);
  if (a) {
    const ang = Math.random() * Math.PI * 2;
    const biome = gs.data.byId.biomes.get(s.biome);
    list.forEach((d, i) => {
      const spot = gs.world.findFreeSpot(s.x + Math.cos(ang) * 14 + (i % 3), s.y + Math.sin(ang) * 14 + Math.floor(i / 3), 0.45, 'enemy', null);
      if (!spot) return;
      const m = enemies.spawnEnemy(gs, d.kind, spot.x, spot.y, { level: outpostLevel(s), elite: d.elite, biome });
      if (!m) return;
      m.raid = key;
      m.homeX = s.x;
      m.homeY = s.y;
      m.keep = true;
    });
    toClan(gs, clan, 'Monster anfaller en av era utposter! Håll flaggan.', 'boss');
    return;
  }
  const g = garrison(gs, clan, key);
  const defense = (power(gs, clan, g) + 15 * s.tier) * defenseFactor(gs.data, owned.length, frontier(owned));
  const res = abstractBattle(monsterPower(gs.data, list, outpostLevel(s)), defense);
  losses(gs, g, res.win ? res.defenderLoss * 0.6 : Math.min(0.5, res.defenderLoss));
  if (res.win) lose(gs, key, null);
  else toClan(gs, clan, `Monster anföll en av era utposter, men ${g.length ? 'garnisonen' : 'palissaden'} höll.`, 'info');
}

/** Every hour each square pays its clan's vault (up to 12 hours back). */
function income(gs, clan, now = Date.now()) {
  const owned = ownedBy(gs, clan.id);
  const b = base.clanBase(clan);
  if (!owned.length) {
    b.terrIncomeAt = now;
    return;
  }
  b.terrIncomeAt ??= now;
  let hours = Math.floor((now - b.terrIncomeAt) / HOUR);
  if (hours <= 0) return;
  if (hours > 12) {
    b.terrIncomeAt = now - 12 * HOUR;
    hours = 12;
  }
  b.terrIncomeAt += hours * HOUR;
  const got = {};
  for (const key of owned) {
    for (const [k, n] of Object.entries(incomeFor(gs.data, site(gs, key)?.tier ?? 1))) got[k] = (got[k] ?? 0) + n * hours;
  }
  for (const [k, n] of Object.entries(got)) clan.vault[k] = (clan.vault[k] ?? 0) + n;
  clan.dirty = true;
  gs.db.saveClan(clan);
  clans.sendClan(gs, clan);
}

// --- NPC factions ----------------------------------------------------------------------------------

/** The world's factions (made once, saved in meta 'factions'), never on a clan's land. */
export function factions(gs) {
  if (gs.factions) return gs.factions;
  let st = null;
  try {
    st = JSON.parse(gs.db.meta('factions') ?? 'null');
  } catch (err) {
    gs.log?.warn?.('[army] factions unreadable', err.message);
  }
  if (!st?.list) {
    st = createFactions(gs.world, gs.data);
    const claims = gs.claims();
    for (const key of Object.keys(st.owned)) {
      const s = site(gs, key);
      if (state(gs).map.get(key)?.owner || !s || outpostDormant(s, claims, gs.rules.claimRadius)) delete st.owned[key];
    }
  }
  st.armies ??= [];
  // (Armies walk for real only while someone is near: after a restart they march on as a whole.)
  for (const a of st.armies) for (const k of ['live', 'best', 'bestAt', 'restUntil']) delete a[k];
  gs.factions = st;
  gs.marching = new Map(); // army id → its troops walking the land
  catchUp(gs);
  return st;
}

function saveFactions(gs) {
  const st = gs.factions;
  if (!st) return;
  const armies = st.armies.map(({ live, best, bestAt, restUntil, ...a }) => a);
  gs.db.setMeta('factions', JSON.stringify({ ...st, armies, lastAt: Date.now() }));
}

/** While the server was down the factions went on (a few hours at most, all of it far from everyone). */
function catchUp(gs, now = Date.now()) {
  const st = gs.factions;
  if (st.lastAt) {
    const seconds = Math.min(factionConfig(gs.data).catchUpHours * 3600, Math.max(0, (now - st.lastAt) / 1000));
    const ctx = { ...factionCtx(gs), live: () => false, told: () => {} };
    for (let t = 0; t < seconds; t += 6) stepFactions(st, ctx, 6);
  }
  st.lastAt = now;
}

/** Where a faction sits on the map: its headquarters (or, without it, any land it holds). */
function factionSeat(gs, f) {
  const fx = gs.factions;
  const key = fx.owned[f.hq]?.faction === f.id ? f.hq : factionSquares(fx, f.id)[0];
  const s = key ? site(gs, key) : null;
  return s ? { x: s.x, y: s.y } : null;
}

function everyone(gs, text, kind = 'info') {
  for (const p of gs.players.values()) if (p.conn) gs.toast(p, text, kind);
}

function nameOf(f) {
  return f?.sv ?? f?.name ?? 'En fraktion';
}

/** What the factions' AI needs to know about the clans and the land (src/game/factions.js). */
function factionCtx(gs) {
  if (gs.fctx) return gs.fctx;
  const st = () => gs.factions;
  gs.fctx = {
    world: gs.world, data: gs.data, rng: Math.random,
    ownerOf: (key) => {
      const owner = state(gs).map.get(key)?.owner;
      return owner ? { kind: 'clan', id: owner } : null;
    },
    defense: (key, s) => {
      const e = state(gs).map.get(key);
      if (e?.owner) {
        const clan = gs.clans.get(e.owner);
        const owned = ownedBy(gs, e.owner);
        return ((clan ? power(gs, clan, garrison(gs, clan, key)) : 0) + 15 * s.tier) * defenseFactor(gs.data, owned.length, frontier(owned));
      }
      if (e?.cleared > Date.now()) return 5;
      return monsterPower(gs.data, defendersFor(gs.data, s), outpostLevel(s));
    },
    // Never the camp, never an outpost in a clan's base, never a clan whose base can't be raided right now.
    allowed: (key) => {
      if (key === '0,0') return false;
      const s = site(gs, key);
      // (The claims once per tick: the AI asks about many squares at once.)
      if (gs.fclaimsTick !== gs.tick) {
        gs.fclaims = gs.claims();
        gs.fclaimsTick = gs.tick;
      }
      if (!s || outpostDormant(s, gs.fclaims, gs.rules.claimRadius)) return false;
      const owner = state(gs).map.get(key)?.owner;
      return !owner || raidable(gs, owner);
    },
    live: (key) => state(gs).active.has(key),
    realAttack: (army, s) => {
      const f = factionById(st(), army.faction);
      const a = state(gs).active.get(s.key);
      if (!f || !a) return;
      const walking = troopsOf(gs, army);
      if (walking.length) {
        for (const m of walking) Object.assign(m, { army: 0, march: null, raid: s.key, homeX: s.x, homeY: s.y });
        gs.marching.delete(army.id);
      } else {
        spawnTroops(gs, a, f, troopsFor(f, 'camp', army.troops), { raid: true });
      }
      const e = entry(gs, s.key);
      e.attackedUntil = gs.time + 60;
      changed(gs);
      const clan = e.owner ? gs.clans.get(e.owner) : null;
      if (clan) toClan(gs, clan, `${nameOf(f)} anfaller en av era utposter! Håll flaggan.`, 'boss');
    },
    taken: (key, fid, from, army) => {
      const f = factionById(st(), fid);
      const a = state(gs).active.get(key);
      if (a) garrisonTaken(gs, a, f, army);
      setFlag(gs, key);
      const clan = from?.kind === 'clan' ? gs.clans.get(from.id) : null;
      if (clan) toClan(gs, clan, `${nameOf(f)} tog en av era utposter! Ta tillbaka den på strategikartan (N).`, 'warn');
      changed(gs);
    },
    lost: (key) => {
      const e = state(gs).map.get(key);
      if (!e?.owner) return;
      Object.assign(e, { owner: null, capture: 0, by: null, cleared: 0 });
      setFlag(gs, key);
      changed(gs);
      save(gs);
    },
    plunder: (owner, pct, f) => {
      const clan = owner?.kind === 'clan' ? gs.clans.get(owner.id) : null;
      if (!clan) return;
      const got = [];
      const names = { scrap: 'skrot', essence: 'essens', wood: 'trä', stone: 'sten' };
      for (const k of Object.keys(names)) {
        const n = Math.floor((clan.vault[k] ?? 0) * pct / 100);
        if (n > 0) {
          clan.vault[k] -= n;
          got.push(`${n} ${names[k]}`);
        }
      }
      clan.dirty = true;
      gs.db.saveClan(clan);
      clans.sendClan(gs, clan);
      toClan(gs, clan, `${nameOf(f)} plundrade en av era utposter${got.length ? ` och tog ${got.join(', ')} ur valvet` : ''}.`, 'warn');
    },
    told: (e) => {
      // Troops that walked here and are done: beaten back, home again, or inside their own walls.
      if (e.army && ['repelled', 'home', 'joined', 'plundered'].includes(e.kind)) {
        const a = e.kind === 'joined' ? state(gs).active.get(e.key) : null;
        for (const m of troopsOf(gs, e.army)) {
          if (a) {
            Object.assign(m, { army: 0, march: null, outpost: e.key, homeX: a.site.x, homeY: a.site.y });
            a.defenders.push(m);
          } else {
            vanish(gs, m);
          }
        }
        gs.marching.delete(e.army.id);
      }
      const clan = e.owner?.kind === 'clan' ? gs.clans.get(e.owner.id) : e.target?.kind === 'clan' ? gs.clans.get(e.target.id) : null;
      if (e.kind === 'march' && clan) toClan(gs, clan, `${nameOf(e.faction)} marscherar mot en av era utposter. Se strategikartan (N).`, 'warn');
      else if (e.kind === 'repelled' && clan) toClan(gs, clan, `Er utpost höll mot ${nameOf(e.faction)}.`, 'info');
      else if (e.kind === 'gone') everyone(gs, `${nameOf(e.faction)} har fallit: fraktionen håller ingen mark längre.`, 'legendary');
      if (['rival', 'gone', 'repelled', 'plundered'].includes(e.kind)) changed(gs);
    },
  };
  return gs.fctx;
}

function troopsOf(gs, army) {
  return (gs.marching?.get(army.id) ?? []).filter((m) => !m.dead && m.army === army.id);
}

function playerNear(gs, at, r) {
  for (const p of gs.playersNear(at.x, at.y, r)) if (!p.dead) return p;
  return null;
}

/** The factions' armies close to players walk the land for real; far from everyone they march as a whole. */
function liveArmies(gs) {
  const st = gs.factions;
  for (const army of [...st.armies]) {
    const f = factionById(st, army.faction);
    const s = site(gs, army.to);
    if (!f || !s) continue;
    if (!army.live) {
      if ((army.restUntil ?? 0) < gs.time && playerNear(gs, army, ARMY_LIVE)) muster(gs, army, f, s);
      continue;
    }
    const all = gs.marching.get(army.id) ?? [];
    const troops = troopsOf(gs, army);
    if (!troops.length) {
      // Beaten in the field: the army is no more.
      st.armies = st.armies.filter((a) => a !== army);
      gs.marching.delete(army.id);
      if (all.some((m) => m.dead && !m.vanished)) {
        for (const p of gs.playersNear(army.x, army.y, ARMY_GONE)) if (p.conn) gs.toast(p, `${genitiveSv(nameOf(f))} armé är slagen!`, 'legendary');
      }
      changed(gs);
      continue;
    }
    army.x = troops.reduce((a, m) => a + m.x, 0) / troops.length;
    army.y = troops.reduce((a, m) => a + m.y, 0) / troops.length;
    army.troops = troops.length;
    if (!playerNear(gs, army, ARMY_GONE)) {
      dismiss(gs, army, troops);
      continue;
    }
    const left = Math.hypot(s.x - army.x, s.y - army.y);
    // Stuck (water, cliffs): it goes on as a whole for a while.
    if (left < (army.best ?? Infinity) - 1) {
      army.best = left;
      army.bestAt = gs.time;
    } else if (gs.time - (army.bestAt ?? gs.time) > 20) {
      dismiss(gs, army, troops);
      army.restUntil = gs.time + 45;
      continue;
    }
    if (left < 9) {
      delete army.live;
      armyArrives(st, factionCtx(gs), army);
      for (const m of troopsOf(gs, army)) vanish(gs, m);
      gs.marching.delete(army.id);
      changed(gs);
    }
  }
}

/** An army comes close to someone: its troops stand where it is and walk on to its target. */
function muster(gs, army, f, s) {
  const level = Math.max(outpostLevel(s), 1);
  const target = { x: s.x, y: s.y + 7 };
  // Just setting out from its own walls: out through the gate.
  const from = site(gs, army.from);
  const at = from && dist2(from, army) < 36 ? { x: from.x, y: from.y + 6 } : army;
  const list = [];
  troopsFor(f, 'camp', army.troops).forEach((d, i) => {
    const spot = gs.world.findFreeSpot(at.x + (i % 3) - 1, at.y + Math.floor(i / 3) - 1, 0.45, 'enemy', null);
    if (!spot || dist2(spot, at) > 64) return;
    const m = enemies.spawnEnemy(gs, d.kind, spot.x, spot.y, { level, elite: d.elite });
    if (!m) return;
    Object.assign(m, { army: army.id, faction: f.id, march: target, homeX: spot.x, homeY: spot.y, keep: true });
    list.push(m);
  });
  if (!list.length) {
    army.restUntil = gs.time + 30;
    return;
  }
  army.live = true;
  army.best = Infinity;
  army.bestAt = gs.time;
  gs.marching.set(army.id, list);
  const owner = state(gs).map.get(army.to)?.owner;
  const text = `${genitiveSv(nameOf(f))} armé (${list.length}) är på marsch i närheten.`;
  for (const p of gs.playersNear(army.x, army.y, ARMY_LIVE + 10)) {
    if (!p.conn) continue;
    if (owner && p.clanId === owner) gs.toast(p, `${genitiveSv(nameOf(f))} armé (${list.length}) marscherar mot er utpost! Stoppa den på vägen eller håll flaggan.`, 'boss');
    else gs.toast(p, text, 'info');
  }
}

/** Nobody near any more: the army goes on as a whole. */
function dismiss(gs, army, troops) {
  for (const m of troops) vanish(gs, m);
  delete army.live;
  army.troops = troops.length;
  gs.marching.delete(army.id);
}

/** A faction took an outpost someone stands by: the old guards are gone, its troops hold the flag. */
function garrisonTaken(gs, a, f, army) {
  for (const m of a.defenders) if (!m.dead && m.faction !== f?.id) vanish(gs, m);
  a.defenders = a.defenders.filter((m) => !m.dead);
  for (const m of army ? troopsOf(gs, army) : []) {
    Object.assign(m, { army: 0, march: null, outpost: a.site.key, homeX: a.site.x, homeY: a.site.y });
    a.defenders.push(m);
  }
  if (army) gs.marching.delete(army.id);
  if (!a.defenders.length && f) spawnTroops(gs, a, f, troopsFor(f, 'camp', gs.factions.owned[a.site.key]?.garrison ?? 3));
}

/** A faction's troops held a clan's flag: the outpost is theirs now. */
function factionTakes(gs, key, fid) {
  const f = factionById(gs.factions, fid);
  const e = entry(gs, key);
  const old = e.owner ? gs.clans.get(e.owner) : null;
  Object.assign(e, { owner: null, capture: 0, by: null, cleared: 0 });
  takeFor(gs.factions, gs.data, key, fid);
  const a = state(gs).active.get(key);
  if (a) {
    for (const m of gs.enemiesNear(a.site.x, a.site.y, 9)) {
      if (m.dead || m.faction !== fid) continue;
      Object.assign(m, { raid: null, army: 0, march: null, outpost: key, homeX: a.site.x, homeY: a.site.y });
      a.defenders.push(m);
    }
  }
  setFlag(gs, key);
  if (old) toClan(gs, old, `${nameOf(f)} tog en av era utposter! Ta tillbaka den på strategikartan (N).`, 'warn');
  changed(gs);
  save(gs);
  saveFactions(gs);
}

/** A faction's towers shoot at whoever comes close. */
function towers(gs, dt) {
  for (const [key, a] of state(gs).active) {
    const f = factionAt(gs, key);
    if (!f) continue;
    for (const st of a.structures) {
      const spec = st.def.turret;
      if (st.def.kind !== 'turret' || !spec) continue;
      const rt = st.rt;
      rt.cd -= dt;
      if (rt.cd > 0) continue;
      const cx = st.x + 0.5;
      const cy = st.y + 0.3;
      const p = gs.nearestPlayer(cx, cy, spec.range);
      if (!p) continue;
      rt.cd = spec.interval;
      const d = Math.hypot(p.x - cx, p.y - cy);
      const lead = d / spec.speed;
      const angle = Math.atan2(p.y + (p.vy ?? 0) * lead - cy, p.x + (p.vx ?? 0) * lead - cx);
      const level = gs.world.worldLevel(st.x, st.y);
      combat.spawnProjectile(gs, {
        x: cx, y: cy, angle, speed: spec.speed, damage: spec.damage * (1 + 0.25 * (level - 1)), range: d + 2,
        size: spec.sprite === 'orb' ? 3 : 2, sprite: spec.sprite, enemy: -1, outpost: key, element: spec.element ?? 'physical',
        color: spec.color, status: spec.status ?? null, kind: 'shot', source: 'turret',
      });
      gs.event(cx, cy, { k: 'mturret', x: st.x, y: st.y, aim: angle }, 30);
    }
  }
}

/** A faction's land inside a clan's base (a banner went up by it) is theirs no more. */
function asleep(gs) {
  const claims = gs.claims();
  for (const key of Object.keys(gs.factions.owned)) {
    const s = site(gs, key);
    if (!s || outpostDormant(s, claims, gs.rules.claimRadius)) {
      loseToOthers(gs.factions, key);
      changed(gs);
    }
  }
}

// --- Requests ---------------------------------------------------------------------------------------

/** For the clan payload: soldiers, recruits, squads and the barracks. */
export function armyPayload(gs, clan) {
  const lv = levels(gs, clan);
  const list = roster(clan);
  return {
    squads: armyOf(clan).squads,
    barracks: { used: soldierCount(gs.data, list), cap: barracksCap(gs.data, lv.training) },
    training: lv.training,
    forge: lv.forge,
    owned: ownedBy(gs, clan.id),
  };
}

/** { t: 'army', op, ... } → problem text or null. */
export function request(gs, p, msg) {
  const clan = p.clanId ? gs.clans.get(p.clanId) : null;
  if (!clan) return 'Gå med i eller grunda en klan först';
  const role = clan.members.get(p.accountId)?.role ?? 'member';
  const army = armyOf(clan);
  const list = roster(clan);
  const rec = msg.id != null ? list.find((r) => r.id === Number(msg.id)) : null;
  const lv = levels(gs, clan);
  const officer = canDo(role, 'build');
  let problem = null;
  switch (msg.op) {
    case 'train': {
      if (!officer) return 'Du får inte bestämma över klanens folk';
      const def = roleDef(gs.data, msg.role);
      problem = trainProblem(gs.data, list, rec, msg.role, lv);
      if (problem) return problemSv(problem);
      const short = base.shortfall(clan, p, def.cost);
      if (short) return short;
      base.pay(clan, p, def.cost);
      startTraining(gs.data, rec, msg.role, Date.now());
      toClan(gs, clan, `${workers.lookOf(clan, rec.id).name} börjar träna till ${def.sv?.toLowerCase() ?? def.name}.`, 'level');
      break;
    }
    case 'gear': {
      if (!officer) return 'Du får inte bestämma över klanens folk';
      if (!rec || !isSoldier(gs.data, rec.role)) return 'Ingen sådan soldat';
      const g = gearUpgrade(gs.data, rec, lv);
      if (g.problem) return problemSv(g.problem);
      const short = base.shortfall(clan, p, g.next.cost);
      if (short) return short;
      base.pay(clan, p, g.next.cost);
      rec.gear = g.next.level;
      break;
    }
    case 'muster': {
      if (!officer) return 'Du får inte bestämma över klanens folk';
      if (!rec || !isSoldier(gs.data, rec.role)) return 'Ingen sådan soldat';
      const level = workers.lodgeLevel(gs, clan);
      if (workerCount(gs.data, list) >= workers.capOf(gs, level)) return 'Arbetarstugan är full';
      rec.role = msg.role === 'stone' ? 'stone' : 'wood';
      assignSoldier(gs.data, army, rec.id, 0);
      break;
    }
    case 'squad-create':
      if (!officer) return 'Du får inte leda klanens trupper';
      try {
        createSquad(gs.data, army, String(msg.name ?? '').slice(0, 24) || `Trupp ${army.nextSquad}`);
      } catch {
        return 'Ni har så många trupper ni kan leda';
      }
      break;
    case 'squad-disband':
      if (!officer) return 'Du får inte leda klanens trupper';
      army.squads = army.squads.filter((s) => s.id !== Number(msg.squad));
      break;
    case 'assign': {
      if (!officer) return 'Du får inte leda klanens trupper';
      if (!rec && msg.soldier == null) return 'Ingen sådan soldat';
      const sid = Number(msg.soldier ?? msg.id);
      if (!list.some((r) => r.id === sid && isSoldier(gs.data, r.role))) return 'Ingen sådan soldat';
      problem = assignSoldier(gs.data, army, sid, Number(msg.squad) || 0);
      if (problem) return problem === 'That squad is full' ? 'Truppen är full' : 'Ingen sådan trupp';
      break;
    }
    case 'stance': {
      if (!officer) return 'Du får inte leda klanens trupper';
      const sq = army.squads.find((s) => s.id === Number(msg.squad));
      if (!sq || !STANCES.includes(msg.stance)) return 'Okänd hållning';
      sq.stance = msg.stance;
      break;
    }
    case 'order': {
      if (!officer) return 'Du får inte leda klanens trupper';
      const sq = army.squads.find((s) => s.id === Number(msg.squad));
      if (!sq) return 'Ingen sådan trupp';
      if (!sq.members.length && msg.kind !== 'retreat') return 'Truppen har inga soldater än';
      const members = soldiersOf(gs, clan.id).filter((w) => sq.members.includes(w.id));
      const from = members.length ? { x: members.reduce((a, w) => a + w.x, 0) / members.length, y: members.reduce((a, w) => a + w.y, 0) / members.length } : p;
      const x = Number(msg.x);
      const y = Number(msg.y);
      const key = typeof msg.key === 'string' && /^-?\d+,-?\d+$/.test(msg.key) ? msg.key : null;
      const { order, problem: bad } = makeOrder(String(msg.kind), { key, x: Number.isFinite(x) ? x : undefined, y: Number.isFinite(y) ? y : undefined, site: (k) => site(gs, k), from });
      if (bad) return problemSv(bad);
      if (order.kind === 'defend' && order.key && entry(gs, order.key).owner !== clan.id) return 'Ni kan bara försvara en utpost ni håller: anfall den först';
      if (order.kind === 'attack' && order.key && outpostDormant(site(gs, order.key), gs.claims(), gs.rules.claimRadius)) return 'Den utposten ligger i en klans bas';
      // Far-off orders stay within reason (no marching across the whole world).
      if (Number.isFinite(order.x) && Math.hypot(order.x, order.y) > 2400) return 'För långt bort';
      if (order.kind === 'follow') order.leader = p.accountId;
      sq.order = order;
      break;
    }
    default:
      return 'Okänd order';
  }
  clan.dirty = true;
  gs.db.saveClan(clan);
  workers.sync(gs, clan);
  clans.sendClan(gs, clan);
  return null;
}

export { roleTitle, makeSoldier, workerStats };
