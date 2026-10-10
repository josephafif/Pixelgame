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

import {
  isSoldier, roleDef, roleTitle, trainProblem, startTraining, finishTraining, gearUpgrade, soldierStats, soldierPower,
  addXp, ensureArmy, createSquad, assignSoldier, pruneSquads, squadOf, makeOrder, postFor, stepSoldier, hurtSoldier,
  squadHealth, stanceParams, STANCES, barracksCap, soldierCount, workerCount, makeSoldier, problemSv,
} from '../src/game/army.js';
import {
  territoryConfig, territoryAt, parseKey, outpostFor, defendersFor, outpostLevel, monsterPower, abstractBattle,
  stepCapture, incomeFor, frontier, defenseFactor, placeOutpost, removeOutpost, outpostDormant,
} from '../src/game/territory.js';
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
  t.checkT -= dt;
  if (t.checkT <= 0 && on) {
    t.checkT = 0.5;
    outposts(gs);
  }
  stepSoldiers(gs, dt);
  if (on) capture(gs, dt);
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
  }
}

/** Every square someone holds or is taking, for the clients' maps: { t: 'terr', list }. */
export function territoryPayload(gs) {
  const list = [];
  for (const [key, e] of state(gs).map) {
    const attacked = e.attackedUntil > gs.time;
    if (!e.owner && !(e.capture > 0) && !attacked) continue;
    const clan = e.owner ? gs.clans.get(e.owner) : null;
    list.push({
      key, owner: e.owner, tag: clan?.tag ?? null, color: e.owner ? clanColor(e.owner) : null,
      cap: Math.round((e.capture ?? 0) * 100) / 100, by: e.by ?? null, att: attacked ? 1 : 0,
    });
  }
  return { t: 'terr', list };
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
  if (!(e.outpost || e.raid) || !gs.workers?.size) return null;
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
    if (want.has(key)) continue;
    let near = false;
    for (const p of gs.playersNear(a.site.x, a.site.y, DEACTIVATE)) if (p) near = true;
    if (!near || dormant(a.site)) deactivate(gs, key);
  }
}

function flagColor(gs, key) {
  const owner = entry(gs, key).owner;
  return owner ? clanColor(owner) : NEUTRAL_COLOR;
}

function activate(gs, s) {
  const structures = placeOutpost(gs.world, gs.data, s, flagColor(gs, s.key));
  const a = { site: s, structures, defenders: [] };
  state(gs).active.set(s.key, a);
  const e = entry(gs, s.key);
  if (!e.owner && !(e.cleared > Date.now())) spawnDefenders(gs, a);
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

function deactivate(gs, key) {
  const t = state(gs);
  const a = t.active.get(key);
  if (!a) return;
  removeOutpost(gs.world, a.structures);
  for (const e of a.defenders) {
    if (e.dead) continue;
    e.dead = true;
    e.vanished = true;
    gs.enemies.delete(e.id);
  }
  t.active.delete(key);
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
    if (a.defenders.length && a.defenders.every((d) => d.dead && !d.vanished)) {
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
    for (const m of gs.enemiesNear(s.x, s.y, 7)) if (!m.dead && !m.submerged && dist2(m, s) < 49) monsters = true;
    const before = e.capture ?? 0;
    if (e.owner) {
      const others = [...here].filter((c) => c !== e.owner);
      const hostile = monsters || (others.length > 0 && raidable(gs, e.owner));
      e.capture = stepCapture(before, { friendly: here.has(e.owner), hostile, dt, seconds: cfg.captureSeconds });
      if (hostile && !here.has(e.owner)) e.attackedUntil = gs.time + 3;
      if (e.capture <= 0) lose(gs, key, others.length === 1 ? others[0] : null);
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

function take(gs, key, clanId) {
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
  toClan(gs, clan, `[${clan.tag}] tog utposten! Den ger ${pay} i timmen till valvet.`, 'legendary');
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
