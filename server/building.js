// Clan bases on the server: banners claim land, members build inside the
// claim, and other players can only damage it while the base is raidable
// (someone in the clan online or just logged out, or the raid window).
// Turrets and spike traps defend against monsters and intruders.

import { tileKey } from '../src/game/world.js';
import { structureDef, refundFor, groundProblem, onWater } from '../src/game/construction.js';
import { canAfford, pay, shortfalls } from '../src/game/base.js';
import { inSafeZone, bannerProblem, claimAt, canDo } from '../src/net/rules.js';
import { mpStructureLock } from '../src/net/mpbuild.js';
import { buildingOfStruct, BUILDING_SV } from '../src/net/mpbase.js';
import * as combat from './combat.js';
import * as players from './players.js';
import * as loot from './loot.js';
import * as base from './base.js';
import * as clans from './clans.js';

const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
const MAX_CLAN_STRUCTURES = 400;

function layerOf(def) {
  return def.kind === 'floor' ? 'floor' : 'top';
}

function attach(gs, st) {
  const def = structureDef(gs.data, st.id);
  if (!def) return false;
  hidden(st, 'def', def);
  hidden(st, 'rt', { cd: Math.random() * 0.5, aim: -Math.PI / 2, flash: 0, trig: -9, open: 0, lastHit: -99 });
  st.hp = Math.min(def.hp, st.hp ?? def.hp);
  const layer = def.kind === 'floor' ? gs.world.floors : gs.world.structures;
  if (layer.has(tileKey(st.x, st.y))) return false;
  layer.set(tileKey(st.x, st.y), st);
  gs.structures.set(st.sid, st);
  base.attached(gs, st);
  return true;
}

export function loadStructures(gs) {
  for (const st of gs.db.loadStructures()) {
    if (!attach(gs, st)) gs.db.deleteStructure(st.sid);
  }
}

export function structurePayload(st, gs = null) {
  const out = { sid: st.sid, id: st.id, x: st.x, y: st.y, hp: Math.ceil(st.hp), clanId: st.clanId ?? 0 };
  // A clan building shows its level (its look grows with it).
  if (gs && st.def?.kind === 'building') out.lv = base.structureLevel(gs, st);
  return out;
}

export function bannerOf(gs, clanId) {
  for (const st of gs.structures.values()) if (st.id === 'banner' && st.clanId === clanId) return st;
  return null;
}

export function ownBannerNear(gs, p, r) {
  if (!p.clanId) return null;
  const b = bannerOf(gs, p.clanId);
  if (!b) return null;
  return (b.x + 0.5 - p.x) ** 2 + (b.y + 0.5 - p.y) ** 2 <= r * r ? b : null;
}

/** The claim (banner) whose land contains tile (tx, ty). */
export function claimFor(gs, tx, ty) {
  return claimAt(gs.rules, gs.claims(), tx, ty);
}

/** May player `p` damage structure `st` right now? */
export function canDamage(gs, p, st, now = Date.now()) {
  if (!p || st.dead || st.marketId) return false; // markets' walls stand
  if (st.def?.kind === 'building') return false; // a clan's buildings can't be broken (raids are about walls and the vault)
  if (st.clanId && st.clanId === p.clanId) return false;
  if (inSafeZone(gs.rules, st.x + 0.5, st.y + 0.5)) return false;
  if (!st.clanId) return true; // abandoned
  return gs.raidState(st.clanId, now).raidable;
}

/** May a turret of `st`'s clan shoot player `p`? (Intruders in a raidable base.) */
export function turretMayHit(gs, st, p, now = Date.now()) {
  if (!st.clanId || p.clanId === st.clanId || p.dead) return false;
  if (p.lastClanHit?.[st.clanId] > now - 30000) return true; // attacked us recently
  const claim = claimFor(gs, Math.floor(p.x), Math.floor(p.y));
  if (!claim || claim.clanId !== st.clanId) return false;
  return gs.raidState(st.clanId, now).raidable;
}

export function damageStructure(gs, st, amount, attacker) {
  if (!st || st.dead || amount <= 0 || st.marketId || st.def?.kind === 'building') return;
  st.hp -= amount;
  st.rt.flash = 0.12;
  st.rt.lastHit = gs.time;
  st.dirtyHp = true;
  if (gs.tick - (st.lastHpSent ?? -99) >= 3 || st.hp <= 0) {
    st.lastHpSent = gs.tick;
    gs.broadcastTile(st.x, st.y, { t: 'wd', k: 'sthp', sid: st.sid, hp: Math.max(0, Math.ceil(st.hp)) });
  }
  if (attacker && st.clanId) {
    attacker.lastClanHit ??= {};
    attacker.lastClanHit[st.clanId] = Date.now();
    raidAlert(gs, st, attacker);
  }
  if (st.hp <= 0) destroyStructure(gs, st, attacker);
}

function raidAlert(gs, st, attacker) {
  const clan = gs.clans.get(st.clanId);
  if (!clan) return;
  const now = Date.now();
  if (now - (clan.alertAt ?? 0) < 60000) return;
  clan.alertAt = now;
  const text = `Er bas anfalls av ${attacker.name} vid (${st.x}, ${st.y})!`;
  for (const id of clan.members.keys()) {
    const m = gs.byAccount.get(id);
    if (m?.conn) gs.toast(m, text, 'boss');
  }
  gs.log.info(`[raid] ${attacker.name} is raiding [${clan.tag}] at ${st.x},${st.y}`);
  if (gs.config.discordWebhook && now - (clan.webhookAt ?? 0) > 10 * 60000) {
    clan.webhookAt = now;
    const content = `⚔️ [${clan.tag}] ${clan.name}: basen anfalls av ${attacker.name} vid (${st.x}, ${st.y})!`;
    fetch(gs.config.discordWebhook, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(5000),
    }).catch((err) => gs.log.warn('[raid] webhook failed', err.message));
  }
}

export function destroyStructure(gs, st, attacker) {
  if (st.dead) return;
  st.dead = true;
  const layer = st.def.kind === 'floor' ? gs.world.floors : gs.world.structures;
  if (layer.get(tileKey(st.x, st.y)) === st) layer.delete(tileKey(st.x, st.y));
  gs.structures.delete(st.sid);
  base.detached(gs, st);
  gs.db.deleteStructure(st.sid);
  gs.broadcastTile(st.x, st.y, { t: 'wd', k: 'st-', sid: st.sid, x: st.x, y: st.y, broken: Boolean(attacker !== undefined) });
  if (st.id === 'banner' && st.clanId) bannerLost(gs, st, attacker);
  // A floor on water was all that held up what stood on it.
  if (st.def.kind === 'floor' && onWater(gs.world, st.x, st.y)) {
    const top = gs.world.structureAt(st.x, st.y);
    if (top && !top.dead && !top.marketId && top.def.kind !== 'building') destroyStructure(gs, top, attacker);
  }
}

/** The banner fell: the claim is gone and raiders get the unprotected vault. */
function bannerLost(gs, st, attacker) {
  const clan = gs.clans.get(st.clanId);
  if (!clan) return;
  const res = {};
  let any = false;
  for (const [k, v] of Object.entries(clan.vault)) {
    const n = Math.floor(v * (1 - gs.rules.vaultProtected));
    if (n > 0) {
      res[k] = n;
      clan.vault[k] = v - n;
      any = true;
    }
  }
  clan.dirty = true;
  gs.db.saveClan(clan);
  gs.db.log(attacker?.accountId ?? null, 'banner-lost', null, { clan: clan.id, spilled: res });
  if (any) {
    loot.addPickup(gs, 'bag', st.x + 0.5, st.y + 0.5, { vx: 0, vy: 0, res, items: [], born: Date.now(), bag: true, ownerName: `[${clan.tag}]` });
  }
  const text = attacker ? `${attacker.name} fällde ert klanbanér! Bygg ett nytt för att ta tillbaka marken.` : 'Ert klanbanér är förstört.';
  for (const id of clan.members.keys()) {
    const m = gs.byAccount.get(id);
    if (m?.conn) gs.toast(m, text, 'boss');
  }
  gs.broadcast({ t: 'claims', claims: gs.claims() });
}

// --- Requests from players ------------------------------------------------------------------

/** Builds `defId` on tile (tx, ty) for player p. Returns a problem text or null. */
export function place(gs, p, defId, tx, ty) {
  const def = structureDef(gs.data, defId);
  if (!def) return 'Okänd byggnad';
  if (!Number.isInteger(tx) || !Number.isInteger(ty) || Math.abs(tx) > 1e6 || Math.abs(ty) > 1e6) return 'Ogiltig plats';
  if (p.dead) return 'Du är död';
  if (p.sailing) return 'Gå i land för att bygga';
  if (gs.world.marketAt(tx + 0.5, ty + 0.5, 3)) return 'Man kan inte bygga vid en marknad';
  const clan = p.clanId ? gs.clans.get(p.clanId) : null;
  if (!clan) return 'Gå med i eller skapa en klan för att bygga (även ensam)';
  const role = clan.members.get(p.accountId)?.role ?? 'member';
  if (inSafeZone(gs.rules, tx + 0.5, ty + 0.5)) return 'Man kan inte bygga i Fristaden';
  if ((p.x - (tx + 0.5)) ** 2 + (p.y - (ty + 0.5)) ** 2 > (gs.data.building.reach + 0.5) ** 2) return 'För långt bort';
  const lock = mpStructureLock(def, p.ch.level);
  if (lock) return lock;
  const claims = gs.claims();
  if (def.id === 'banner') {
    if (!canDo(role, 'banner')) return 'Bara ledare och officerare kan resa klanbanéret';
    if (bannerOf(gs, clan.id)) return 'Er klan har redan ett banér (riv det först för att flytta basen)';
    const problem = bannerProblem(gs.rules, tx + 0.5, ty + 0.5, clan.id, claims);
    if (problem) return problem;
  } else {
    const claim = claimAt(gs.rules, claims, tx, ty);
    if (!claim) return 'Bygg inom er klans mark (res ett klanbanér först)';
    if (claim.clanId !== clan.id) return 'Det här är en annan klans mark';
    if (!canDo(role, 'build')) return 'Du får inte bygga här';
  }
  const ground = groundProblem(gs.world, def, tx, ty);
  if (ground === 'water') return 'Lägg ett golv på vattnet först, sedan kan du bygga på det';
  if (ground === 'deep') return 'För djupt (eller för hett) att bygga här';
  if (ground) return 'Hugg bort trädet eller stenen först';
  if (def.kind === 'building' && onWater(gs.world, tx, ty)) return 'Byggnader står på fast mark';
  if (def.kind === 'floor' ? gs.world.floorAt(tx, ty) : gs.world.structureAt(tx, ty)) return 'Här står redan något';
  if (!def.walkable) {
    const inside = (x, y, r) => x + r > tx && x - r < tx + 1 && y + r > ty && y - r < ty + 1;
    for (const o of gs.playersNear(tx + 0.5, ty + 0.5, 2)) if (!o.dead && inside(o.x, o.y, o.r)) return 'Någon står där';
    for (const e of gs.enemiesNear(tx + 0.5, ty + 0.5, 3)) if (inside(e.x, e.y, e.r)) return 'Något står i vägen';
  }
  let count = 0;
  for (const st of gs.structures.values()) if (st.clanId === clan.id) count++;
  if (count >= MAX_CLAN_STRUCTURES) return 'Er bas kan inte rymma fler byggen';
  const bid = buildingOfStruct(def.id);
  let paid = null;
  if (bid) {
    // A camp building: one of each per clan, a little room around it, paid
    // from the vault (and your pockets). Built before? Then moving it is free.
    if (base.placed(gs, clan.id).has(bid)) return `Er klan har redan ${BUILDING_SV[bid].toLowerCase()} (riv den först för att flytta den)`;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (gs.world.structureAt(tx + dx, ty + dy)?.def?.kind === 'building') return 'För nära en annan byggnad';
      }
    }
    const built = (base.clanBase(clan).buildings[bid] ?? 0) > 0;
    const cost = built ? {} : def.cost;
    const short = base.shortfall(clan, p, cost);
    if (short) return short;
    paid = base.pay(clan, p, cost);
    base.clanBase(clan).buildings[bid] = Math.max(1, base.clanBase(clan).buildings[bid] ?? 0);
  } else {
    if (!canAfford(p.ch.resources, def.cost)) return shortfalls(p.ch.resources, def.cost)[0];
    pay(p.ch.resources, def.cost);
  }
  const st = { clanId: clan.id, id: def.id, x: tx, y: ty, layer: layerOf(def), hp: def.hp, builtBy: p.accountId };
  try {
    gs.db.tx(() => {
      st.sid = gs.db.insertStructure(st);
      players.persist(gs, p);
      if (bid) gs.db.saveClan(clan);
    });
  } catch (err) {
    if (paid) base.refund(clan, p, paid);
    else for (const [k, v] of Object.entries(def.cost)) p.ch.resources[k] = (p.ch.resources[k] ?? 0) + v;
    gs.log.error('[build] failed', err);
    return 'Kunde inte bygga';
  }
  attach(gs, st);
  players.markMe(p);
  gs.broadcastTile(tx, ty, { t: 'wd', k: 'st+', st: structurePayload(st, gs) });
  if (bid) {
    if (bid === 'well') base.clanBase(clan).wellAt ??= Date.now();
    base.changed(gs, clan);
    for (const id of clan.members.keys()) {
      const m = gs.byAccount.get(id);
      if (m?.conn) gs.toast(m, `${p.name} byggde ${BUILDING_SV[bid].toLowerCase()} i er bas!`, 'level');
    }
  }
  if (def.id === 'banner') {
    gs.broadcast({ t: 'claims', claims: gs.claims() });
    for (const id of clan.members.keys()) {
      const m = gs.byAccount.get(id);
      if (m?.conn) gs.toast(m, `${p.name} reste klanbanéret: marken runt det är nu er.`, 'level');
    }
  }
  return null;
}

/** Takes a structure down (half the materials back). Returns problem or null. */
export function remove(gs, p, tx, ty) {
  const st = gs.world.structureAt(tx, ty) ?? gs.world.floorAt(tx, ty);
  if (!st) return 'Här finns inget att riva';
  if ((p.x - (tx + 0.5)) ** 2 + (p.y - (ty + 0.5)) ** 2 > (gs.data.building.reach + 0.5) ** 2) return 'För långt bort';
  const clan = p.clanId ? gs.clans.get(p.clanId) : null;
  if (!clan || st.clanId !== clan.id) return 'Det där är inte er klans';
  const role = clan.members.get(p.accountId)?.role ?? 'member';
  if (!canDo(role, 'unbuild') && st.builtBy !== p.accountId) return 'Bara officerare kan riva andras byggen';
  if (st.id === 'banner' && !canDo(role, 'banner')) return 'Bara ledare och officerare kan riva banéret';
  if (st.rt.lastHit > gs.time - 10) return 'Inte medan basen anfalls';
  const bid = buildingOfStruct(st.id);
  if (bid) {
    // A camp building comes down for free and keeps its level: build it again anywhere in the base.
    if (!canDo(role, 'unbuild')) return 'Bara ledare och officerare kan riva byggnader';
    destroyStructure(gs, st, undefined);
    base.changed(gs, clan);
    gs.toast(p, `${BUILDING_SV[bid]} är riven. Nivån finns kvar: bygg den igen var ni vill i basen (gratis).`, 'info');
    return null;
  }
  const refund = refundFor(gs.data, st.def);
  for (const [k, v] of Object.entries(refund)) p.ch.resources[k] = (p.ch.resources[k] ?? 0) + v;
  destroyStructure(gs, st, undefined);
  players.persist(gs, p);
  players.markMe(p);
  if (st.id === 'banner') gs.broadcast({ t: 'claims', claims: gs.claims() });
  return null;
}

// --- Tick -------------------------------------------------------------------------------------

function turretDamage(gs, st) {
  const wl = gs.world.worldLevel(st.x, st.y);
  return st.def.turret.damage * (1 + 0.25 * (wl - 1));
}

function runTurret(gs, st, dt, now) {
  const rt = st.rt;
  const spec = st.def.turret;
  rt.cd -= dt;
  const cx = st.x + 0.5;
  const cy = st.y + 0.3;
  let best = null;
  let bestD = spec.range * spec.range;
  for (const e of gs.enemiesNear(cx, cy, spec.range)) {
    if (e.dead || e.submerged) continue;
    const d = (e.x - cx) ** 2 + (e.y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (!best && st.clanId) {
    for (const p of gs.playersNear(cx, cy, spec.range)) {
      if (!turretMayHit(gs, st, p, now)) continue;
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  if (!best) return;
  const want = Math.atan2(best.y - cy, best.x - cx);
  let diff = want - rt.aim;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  rt.aim += Math.max(-dt * 8, Math.min(dt * 8, diff));
  if (rt.cd > 0 || Math.abs(diff) > 0.5) return;
  rt.cd = spec.interval;
  const lead = Math.sqrt(bestD) / spec.speed;
  const angle = Math.atan2(best.y + (best.vy ?? 0) * lead - cy, best.x + (best.vx ?? 0) * lead - cx);
  combat.spawnProjectile(gs, {
    x: cx, y: cy, angle, speed: spec.speed, damage: turretDamage(gs, st), range: spec.range + 1,
    size: spec.sprite === 'orb' ? 3 : 2, sprite: spec.sprite, turret: st.sid, clanId: st.clanId, element: spec.element ?? 'physical',
    color: spec.color, status: spec.status ?? null, kind: 'shot', source: 'turret',
  });
  gs.event(cx, cy, { k: 'turret', sid: st.sid, aim: angle }, 30);
}

function runTrap(gs, st, dt, now) {
  const rt = st.rt;
  rt.cd -= dt;
  if (rt.cd > 0) return;
  const inside = (o) => o.x + o.r > st.x && o.x - o.r < st.x + 1 && o.y + o.r > st.y && o.y - o.r < st.y + 1;
  let hit = false;
  const dmg = st.def.trap.damage * (1 + 0.25 * (gs.world.worldLevel(st.x, st.y) - 1));
  for (const e of gs.enemiesNear(st.x + 0.5, st.y + 0.5, 2)) {
    if (e.boss || !inside(e)) continue;
    combat.damageEnemy(gs, e, dmg, { canCrit: false, source: 'trap' });
    hit = true;
  }
  for (const p of gs.playersNear(st.x + 0.5, st.y + 0.5, 2)) {
    if (!inside(p) || !turretMayHit(gs, st, p, now)) continue;
    combat.hurtPlayer(gs, p, dmg * gs.rules.pvpDamage, {});
    hit = true;
  }
  if (hit) {
    rt.cd = st.def.trap.interval;
    rt.trig = gs.time;
    gs.event(st.x + 0.5, st.y + 0.5, { k: 'trap', sid: st.sid }, 24);
  }
}

export function update(gs, dt, now) {
  const repair = gs.data.building.repairPerSec ?? 0.02;
  for (const st of gs.structures.values()) {
    const kind = st.def.kind;
    if (st.rt.flash > 0) st.rt.flash -= dt;
    if (kind === 'turret') runTurret(gs, st, dt, now);
    else if (kind === 'trap') runTrap(gs, st, dt, now);
    // Slow self-repair while nobody is attacking (not for abandoned or unpaid bases).
    if (st.hp < st.def.hp && gs.time - st.rt.lastHit > 8 && st.clanId && !gs.clans.get(st.clanId)?.unpaid) {
      st.hp = Math.min(st.def.hp, st.hp + st.def.hp * repair * dt);
      st.dirtyHp = true;
      if (gs.tick % 30 === st.sid % 30) gs.broadcastTile(st.x, st.y, { t: 'wd', k: 'sthp', sid: st.sid, hp: Math.ceil(st.hp) });
    }
  }
}

export function persistDamage(gs) {
  for (const st of gs.structures.values()) {
    if (!st.dirtyHp) continue;
    gs.db.updateStructureHp(st.sid, st.hp);
    st.dirtyHp = false;
  }
}

/**
 * Hourly: each clan pays upkeep for its base from the vault; bases that
 * can't pay (and abandoned ones) slowly crumble.
 */
export function upkeep(gs) {
  const per = gs.rules.upkeepPerStructure ?? {};
  const counts = new Map();
  for (const st of gs.structures.values()) {
    if (st.def.kind === 'building') continue; // the camp's buildings cost no upkeep
    counts.set(st.clanId ?? 0, (counts.get(st.clanId ?? 0) ?? 0) + 1);
  }
  for (const clan of gs.clans.values()) {
    const n = counts.get(clan.id) ?? 0;
    if (!n) continue;
    let short = false;
    for (const [k, v] of Object.entries(per)) {
      clan.upkeep[k] = (clan.upkeep[k] ?? 0) + (n * v) / 168;
      const whole = Math.floor(clan.upkeep[k]);
      if (whole <= 0) continue;
      if ((clan.vault[k] ?? 0) >= whole) {
        clan.vault[k] -= whole;
        clan.upkeep[k] -= whole;
      } else {
        short = true;
      }
    }
    if (short !== clan.unpaid) {
      clan.unpaid = short;
      const text = short ? 'Klanvalvet räcker inte till underhållet: basen börjar förfalla. Lägg trä och sten i valvet vid banéret.' : 'Underhållet är betalt igen.';
      for (const id of clan.members.keys()) {
        const m = gs.byAccount.get(id);
        if (m?.conn) gs.toast(m, text, short ? 'warn' : 'info');
      }
    }
    clan.dirty = true;
  }
  for (const st of [...gs.structures.values()]) {
    const clan = st.clanId ? gs.clans.get(st.clanId) : null;
    const decay = !clan ? 0.05 : st.def.kind === 'building' ? 0 : clan.unpaid ? 0.02 : !bannerOf(gs, clan.id) ? 0.02 : 0;
    if (!decay) continue;
    st.hp -= st.def.hp * decay;
    st.dirtyHp = true;
    if (st.hp <= 0) destroyStructure(gs, st, null);
  }
}
