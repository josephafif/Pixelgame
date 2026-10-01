// Pals: small companions that follow you around and either fight at your
// side or chop trees and break rocks for you. They are hard to come by:
// pals hatch from rare eggs (bosses, buried island treasure, sea serpents,
// now and then an elite) at the Pal Den in your camp, and are made stronger
// with essence and materials. The Den's level caps how far they can grow.
//
// The top half is pure save logic (runs in tests); the bottom half is the
// pal's behaviour in the running game.

import { canAfford, pay, shortfalls, buildingLevel, COST_KEYS } from './base.js';
import { harvestInfo } from './gathering.js';
import { applyStatus } from './status.js';

export const PAL_MODES = ['fight', 'gather', 'follow'];
export const MODE_LABEL = { fight: 'Fight', gather: 'Gather', follow: 'Follow' };

export function palConfig(data) {
  return data.pals;
}

export function palSpecies(data, id) {
  return data.pals.species.find((s) => s.id === id) ?? null;
}

/** Stats of a pal of this species at this level. */
export function palStats(data, speciesId, level) {
  const cfg = data.pals;
  const sp = palSpecies(data, speciesId) ?? cfg.species[0];
  const n = Math.max(0, level - 1);
  const b = cfg.base;
  const per = cfg.perLevel;
  return {
    maxHp: Math.round((b.hp + per.hp * n) * (sp.hp ?? 1)),
    damage: Math.round((b.damage + per.damage * n) * (sp.damage ?? 1) * 10) / 10,
    speed: b.speed + per.speed * n,
    attackInterval: Math.max(0.45, b.attackInterval + per.attackInterval * n),
    gatherPower: Math.round((b.gatherPower + per.gatherPower * n) * (sp.gather ?? 1) * 100) / 100,
    // Harder stone needs a stronger pal (like it needs a better pickaxe):
    // crystals from level 5, obsidian from 7, iron ore from 9.
    gatherTier: level >= 9 ? 4 : level >= 7 ? 3 : level >= 5 ? 2 : 1,
    range: sp.attack === 'zap' ? sp.range ?? 4.5 : 0,
    element: sp.element ?? 'physical',
  };
}

/** How far pals can grow with the current Pal Den (0 without one). */
export function palLevelCap(data, save) {
  const den = buildingLevel(data, save, 'den');
  return Math.min(data.pals.maxLevel, den * 2);
}

/** Cost to raise a pal from `level` to `level + 1`. */
export function upgradeCost(data, level) {
  const u = data.pals.upgrade;
  const k = u.growth ** (level - 1);
  const out = {};
  for (const key of COST_KEYS) if (u[key]) out[key] = Math.round((u[key] * k) / 5) * 5;
  return out;
}

export function findPal(save, id) {
  return save.pals.owned.find((p) => p.id === id) ?? null;
}

export function activePal(save) {
  return save.pals.active ? findPal(save, save.pals.active) : null;
}

/** Why a pal can't be upgraded right now (empty = can). */
export function palUpgradeBlockers(data, save, pal) {
  if (!pal) return ['No pal'];
  if (pal.level >= data.pals.maxLevel) return ['Max level'];
  const out = [];
  const cap = palLevelCap(data, save);
  if (pal.level >= cap) {
    out.push(cap === 0 ? 'Build a Pal Den first' : `Upgrade the Pal Den to raise pals past level ${cap}`);
  }
  out.push(...shortfalls(save.resources, upgradeCost(data, pal.level)));
  return out;
}

/** Pays for and applies one level. Throws with a readable reason. */
export function upgradePal(data, save, id) {
  const pal = findPal(save, id);
  const blockers = palUpgradeBlockers(data, save, pal);
  if (blockers.length) throw new Error(blockers[0]);
  const cost = upgradeCost(data, pal.level);
  if (!canAfford(save.resources, cost)) throw new Error('Not enough materials');
  pay(save.resources, cost);
  pal.level += 1;
  return pal.level;
}

// --- Eggs ------------------------------------------------------------------------------

function pickSpecies(data, rng) {
  const list = data.pals.species;
  let r = rng() * list.reduce((s, sp) => s + sp.weight, 0);
  for (const sp of list) {
    if (r < sp.weight) return sp.id;
    r -= sp.weight;
  }
  return list[0].id;
}

/** Adds an egg to the save and returns it. */
export function addEgg(data, save, species = null, rng = Math.random) {
  const egg = { id: `egg${save.pals.nextId++}`, species: species ?? pickSpecies(data, rng), hatchAt: null };
  save.pals.eggs.push(egg);
  return egg;
}

/**
 * The chance of an egg from a source: 'bossFirst' (first kill of a boss),
 * 'boss', 'serpent', 'treasure' or 'elite'.
 */
export function eggChance(data, source) {
  return data.pals.eggChance[source] ?? 0;
}

/** Rolls for an egg from a source; returns the species id or null. */
export function rollEgg(data, source, rng = Math.random) {
  return rng() < eggChance(data, source) ? pickSpecies(data, rng) : null;
}

/** Why an egg can't be put in the Den right now (empty = can). */
export function hatchBlockers(data, save, egg) {
  if (!egg) return ['No egg'];
  if (egg.hatchAt) return ['Already hatching'];
  const out = [];
  if (buildingLevel(data, save, 'den') < 1) out.push('Build a Pal Den first');
  if (save.pals.eggs.some((e) => e.hatchAt)) out.push('The Den is already warming an egg');
  out.push(...shortfalls(save.resources, { essence: data.pals.hatchEssence }));
  return out;
}

/** Puts an egg in the Den: it hatches `hatchSeconds` later (even while away). */
export function startHatch(data, save, eggId, now = Date.now()) {
  const egg = save.pals.eggs.find((e) => e.id === eggId);
  const blockers = hatchBlockers(data, save, egg);
  if (blockers.length) throw new Error(blockers[0]);
  save.resources.essence -= data.pals.hatchEssence;
  egg.hatchAt = now + data.pals.hatchSeconds * 1000;
  return egg;
}

/** Hatches every egg whose time has come. Returns the new pals. */
export function hatchReady(data, save, now = Date.now()) {
  const born = [];
  for (const egg of [...save.pals.eggs]) {
    if (!egg.hatchAt || egg.hatchAt > now) continue;
    save.pals.eggs.splice(save.pals.eggs.indexOf(egg), 1);
    const sp = palSpecies(data, egg.species) ?? data.pals.species[0];
    const count = save.pals.owned.filter((p) => p.species === sp.id).length;
    const pal = { id: `pal${save.pals.nextId++}`, species: sp.id, name: count ? `${sp.name} ${count + 1}` : sp.name, level: 1 };
    save.pals.owned.push(pal);
    if (!save.pals.active) {
      save.pals.active = pal.id;
      save.pals.mode = sp.mode ?? 'fight';
    }
    born.push(pal);
  }
  return born;
}

// --- In the world ------------------------------------------------------------------------

const TELEPORT_DIST = 14;
const HELP_RADIUS = 7;
const GATHER_RADIUS = 6;
const RETHINK = 0.3;

/** Creates (or clears) the pal that walks with you, from the save. */
export function syncPalEntity(game) {
  const pal = activePal(game.save);
  if (!pal) {
    game.pal = null;
    return;
  }
  const stats = palStats(game.data, pal.species, pal.level);
  const cur = game.pal;
  if (cur && cur.id === pal.id) {
    // Upgraded: keep position, top up health by what was gained.
    cur.hp = Math.min(stats.maxHp, cur.hp + Math.max(0, stats.maxHp - cur.stats.maxHp));
    cur.stats = stats;
    cur.level = pal.level;
    return;
  }
  const p = game.player;
  const spot = game.world.findFreeSpot(p.x - 1, p.y + 0.5, 0.3, 'pal', null) ?? { x: p.x, y: p.y };
  game.pal = {
    id: pal.id, species: pal.species, level: pal.level, stats,
    x: spot.x, y: spot.y, vx: 0, vy: 0, r: 0.3, hp: stats.maxHp, skip: new Map(),
    facing: 1, state: 'follow', target: null, tile: null, cd: 0.5, think: 0,
    attackT: -9, workT: -9, hurtCd: 0, flash: 0, downUntil: 0, stuckT: 0, phase: Math.random() * 10,
  };
}

function place(game, pal) {
  const p = game.player;
  for (const [dx, dy] of [[-1.2, 0.6], [1.2, 0.6], [0, 1.3], [-1, -1], [1, -1]]) {
    if (game.world.isFree(p.x + dx, p.y + dy, pal.r, 'pal')) {
      pal.x = p.x + dx;
      pal.y = p.y + dy;
      return;
    }
  }
  pal.x = p.x;
  pal.y = p.y;
}

function nearestEnemy(game, pal) {
  const p = game.player;
  let best = null;
  let bestD = Infinity;
  const mine = game.target && !game.target.dead && !game.target.submerged ? game.target : null;
  for (const e of game.enemies) {
    if (e.dead || e.submerged || e.def?.sea) continue;
    const dp = Math.hypot(e.x - p.x, e.y - p.y);
    if (dp > HELP_RADIUS) continue;
    // Prefer whatever you are fighting.
    const d = Math.hypot(e.x - pal.x, e.y - pal.y) - (e === mine ? 3 : 0) - (e.alert ? 1 : 0);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function nearestHarvest(game, pal) {
  const p = game.player;
  const w = game.world;
  let best = null;
  let bestD = Infinity;
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  for (let ty = py - GATHER_RADIUS; ty <= py + GATHER_RADIUS; ty++) {
    for (let tx = px - GATHER_RADIUS; tx <= px + GATHER_RADIUS; tx++) {
      const id = w.blockAt(tx, ty);
      if (!id) continue;
      const info = harvestInfo(game.data, id);
      if (!info || info.tier > pal.stats.gatherTier) continue;
      if ((pal.skip.get(`${tx},${ty}`) ?? 0) > game.time) continue;
      const d = Math.hypot(tx + 0.5 - pal.x, ty + 0.5 - pal.y) + Math.hypot(tx + 0.5 - p.x, ty + 0.5 - p.y) * 0.5;
      if (d < bestD) {
        bestD = d;
        best = { tx, ty, x: tx + 0.5, y: ty + 0.5, info };
      }
    }
  }
  return best;
}

/** Walks towards a point, sliding around trees, rocks and water. */
function walk(game, pal, tx, ty, speed, stopAt, dt) {
  const dx = tx - pal.x;
  const dy = ty - pal.y;
  const d = Math.hypot(dx, dy);
  if (d <= stopAt) {
    pal.vx = pal.vy = 0;
    pal.stuckT = 0;
    return true;
  }
  const w = game.world;
  let a = Math.atan2(dy, dx);
  const step = Math.min(speed * dt, d - stopAt);
  const look = Math.min(0.4, step + 0.1);
  const free = (ang) => w.isFree(pal.x + Math.cos(ang) * look, pal.y + Math.sin(ang) * look, pal.r, 'pal');
  if (!free(a)) {
    const side = pal.detour || 1;
    let found = false;
    for (const turn of [0.7, 1.3, 2]) {
      for (const sgn of [side, -side]) {
        if (free(a + turn * sgn)) {
          a += turn * sgn;
          pal.detour = sgn;
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }
  const nx = pal.x + Math.cos(a) * step;
  const ny = pal.y + Math.sin(a) * step;
  const bx = pal.x;
  const by = pal.y;
  if (w.isFree(nx, pal.y, pal.r, 'pal')) pal.x = nx;
  if (w.isFree(pal.x, ny, pal.r, 'pal')) pal.y = ny;
  pal.vx = (pal.x - bx) / dt;
  pal.vy = (pal.y - by) / dt;
  if (Math.abs(pal.vx) > 0.05) pal.facing = pal.vx > 0 ? 1 : -1;
  pal.stuckT = Math.hypot(pal.x - bx, pal.y - by) < step * 0.2 ? pal.stuckT + dt : 0;
  return false;
}

function attack(game, pal, e) {
  const s = pal.stats;
  const sp = palSpecies(game.data, pal.species);
  pal.cd = s.attackInterval;
  pal.attackT = game.time;
  pal.facing = e.x >= pal.x ? 1 : -1;
  const element = s.element;
  const status = element === 'fire' && Math.random() < 0.3 ? 'burn' : element === 'lightning' && Math.random() < 0.25 ? 'shock' : null;
  game.damageEnemy(e, s.damage, {
    element, depth: 1, source: 'pal', fromX: pal.x, fromY: pal.y, knockback: sp?.attack === 'bite' ? 0.5 : 0,
    color: '#b8ffb0',
  });
  if (status && !e.dead) applyStatus(game, e, status, s.damage);
  if (sp?.attack === 'zap') {
    game.fx.add({ type: 'line', points: [[pal.x, pal.y - 0.2], [e.x, e.y]], color: '#bff4ff', dur: 0.16, jagged: true });
    game.audio.play('zap', { throttle: 90 });
  } else {
    game.fx.emit(element === 'fire' ? 'ember' : 'hit', e.x, e.y, 4, 0.3, 2);
  }
}

function work(game, pal, o) {
  pal.cd = pal.stats.attackInterval * 0.8;
  pal.workT = game.time;
  pal.facing = o.x >= pal.x ? 1 : -1;
  const key = `${o.tx},${o.ty}`;
  if (!game.world.blockAt(o.tx, o.ty)) {
    pal.tile = null;
    return;
  }
  const dmg = (game.harvestDamage.get(key)?.dmg ?? 0) + pal.stats.gatherPower;
  game.harvestDamage.set(key, { dmg, at: game.time });
  const wood = o.info.drops.wood;
  game.fx.emit(wood ? 'wood' : 'stone', o.x, o.y - 0.2, 3, 0.4, 1.6);
  game.audio.play(wood ? 'chop' : 'mine', { throttle: 90 });
  if (dmg >= o.info.hp) {
    // Your pal hands over what it chopped straight away.
    game.fellBlock(o, { direct: true });
    pal.tile = null;
  }
}

/** Enemies that bump into your pal hurt it; at 0 health it naps for a while. */
function takeHits(game, pal) {
  if (pal.hurtCd > game.time) return;
  for (const e of game.enemies) {
    if (e.dead || e.submerged || e.def?.sea) continue;
    const reach = e.r + pal.r + 0.05;
    if ((e.x - pal.x) ** 2 + (e.y - pal.y) ** 2 > reach * reach) continue;
    pal.hurtCd = game.time + 0.8;
    const hard = e.state === 'charge';
    const dmg = Math.max(1, Math.round(e.dmg * (e.boss ? 0.8 : 0.5) * (hard ? 1.5 : 1)));
    pal.hp -= dmg;
    pal.flash = 0.12;
    game.fx.number(pal.x, pal.y - 0.8, dmg, { color: '#ffb0b0' });
    if (pal.hp <= 0) {
      pal.hp = 0;
      pal.state = 'down';
      pal.downUntil = game.time + game.data.pals.reviveSeconds;
      pal.target = pal.tile = null;
      game.fx.emit('smoke', pal.x, pal.y, 8, 0.4, 1.5);
      const name = findPal(game.save, pal.id)?.name ?? 'Your pal';
      game.toast(`${name} is knocked out — back in ${game.data.pals.reviveSeconds}s`, 'warn');
    }
    return;
  }
}

/** One step of the pal's life: follow, fight, gather, nap. */
export function updatePal(game, dt) {
  const pal = game.pal;
  if (!pal) return;
  const p = game.player;
  pal.flash = Math.max(0, pal.flash - dt);
  // Out at sea your pal rides along in the boat.
  if (game.sailing) {
    pal.hidden = true;
    pal.x = p.x;
    pal.y = p.y;
    return;
  }
  if (pal.hidden) {
    pal.hidden = false;
    place(game, pal);
  }
  if (pal.state === 'down') {
    pal.vx = pal.vy = 0;
    if (game.time >= pal.downUntil) {
      pal.state = 'follow';
      pal.hp = pal.stats.maxHp;
      place(game, pal);
      game.fx.emit('holy', pal.x, pal.y, 10, 0.5, 2);
    } else if (Math.hypot(p.x - pal.x, p.y - pal.y) > TELEPORT_DIST * 2) {
      place(game, pal);
    }
    return;
  }
  const dp = Math.hypot(p.x - pal.x, p.y - pal.y);
  if (pal.tile && pal.stuckT > 1) {
    // Can't get at that tree: try another one for a while.
    pal.skip.set(`${pal.tile.tx},${pal.tile.ty}`, game.time + 20);
    pal.tile = null;
    pal.stuckT = 0;
  }
  if (dp > TELEPORT_DIST || pal.stuckT > 1.5 || p.dead) {
    place(game, pal);
    pal.stuckT = 0;
    pal.target = pal.tile = null;
    if (!p.dead) game.fx.emit('dust', pal.x, pal.y, 6, 0.4, 1.2);
  }
  pal.cd -= dt;
  takeHits(game, pal);
  if (pal.state === 'down') return;

  const mode = game.save.pals.mode ?? 'fight';
  pal.think -= dt;
  if (pal.think <= 0) {
    pal.think = RETHINK;
    const foe = nearestEnemy(game, pal);
    // Gatherers only fight back when something is right on top of them.
    const threat = foe && Math.hypot(foe.x - pal.x, foe.y - pal.y) < 2.2;
    pal.target = mode === 'fight' || (mode === 'gather' && threat) ? foe : null;
    if (mode === 'gather' && !pal.target) {
      if (!pal.tile || !game.world.blockAt(pal.tile.tx, pal.tile.ty) || Math.hypot(pal.tile.x - p.x, pal.tile.y - p.y) > GATHER_RADIUS + 1.5) {
        pal.tile = nearestHarvest(game, pal);
      }
    } else {
      pal.tile = null;
    }
  }
  const s = pal.stats;
  // Keep up with you when you sprint off.
  const catchUp = dp > 4 ? Math.max(s.speed, (game.pstats.moveSpeed ?? 4) * 1.15) : s.speed;
  const e = pal.target && !pal.target.dead && !pal.target.submerged ? pal.target : null;
  if (e) {
    pal.state = 'fight';
    const reach = s.range || e.r + pal.r + 0.35;
    const there = walk(game, pal, e.x, e.y, catchUp, Math.max(0.1, reach - 0.15), dt);
    if (there || Math.hypot(e.x - pal.x, e.y - pal.y) <= reach) {
      pal.facing = e.x >= pal.x ? 1 : -1;
      if (pal.cd <= 0) attack(game, pal, e);
    }
  } else if (pal.tile) {
    pal.state = 'gather';
    const o = pal.tile;
    if (walk(game, pal, o.x, o.y, catchUp, 1.15, dt) && pal.cd <= 0) work(game, pal, o);
  } else {
    pal.state = 'follow';
    // Trot along just behind you; close enough is close enough.
    if (dp < 2.2 && !(p.moving && dp > 1.6)) {
      pal.vx = pal.vy = 0;
      pal.stuckT = 0;
    } else {
      const back = Math.cos(p.facing) >= 0 ? -1 : 1;
      walk(game, pal, p.x + back * 1.3, p.y + 0.4, catchUp, 0.6, dt);
    }
  }
  // Out of a fight, pals lick their wounds.
  if (!e && pal.hp < s.maxHp) pal.hp = Math.min(s.maxHp, pal.hp + s.maxHp * 0.03 * dt);
}
