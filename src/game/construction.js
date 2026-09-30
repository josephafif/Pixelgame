// Camp construction: walls, gates, turrets, traps, torches, banners and
// floors, placed on the tile grid inside the camp's build area (which grows
// with the Hearth). Structures are data driven (gamedata.json → building),
// block enemies, soak enemy shots, and turrets/traps fight for you.
//
// Saved as plain { id, x, y, hp } objects in save.base.structures; the
// runtime adds non-enumerable `def` and `rt` fields that never get saved.

import { tileKey, T } from './world.js';
import { buildingLevel, buildingDef, canAfford, pay, shortfalls, COST_KEYS } from './base.js';
import { dist2 } from '../core/math.js';

export function structureDefs(data) {
  return data.building?.structures ?? [];
}

export function structureDef(data, id) {
  return structureDefs(data).find((s) => s.id === id) ?? null;
}

/** Radius (tiles, from the Hearth) inside which you can build. */
export function buildRadius(data, save) {
  const b = data.building;
  if (!b) return 0;
  return b.radius + b.radiusPerHearth * buildingLevel(data, save, 'hearth');
}

export function inBuildArea(data, save, tx, ty) {
  return Math.hypot(tx + 0.5 - 0.5, ty + 0.5 - 0.5) <= buildRadius(data, save);
}

/** Missing camp building levels for a structure, or null when unlocked. */
export function structureLock(data, save, def) {
  for (const [id, level] of Object.entries(def.requires ?? {})) {
    if (buildingLevel(data, save, id) < level) {
      return `Needs ${buildingDef(data, id)?.name ?? id} level ${level}`;
    }
  }
  return null;
}

/** Tiles next to the camp buildings stay free so you can always reach them. */
export function reservedTile(data, tx, ty) {
  return (data.base?.buildings ?? []).some((b) => {
    const bx = Math.floor(b.x);
    const by = Math.floor(b.y);
    return tx >= bx - 1 && tx <= bx + 1 && ty >= by - 1 && ty <= by + 1;
  });
}

/** What a structure gives back when you take it down. */
export function refundFor(data, def) {
  const k = data.building?.refund ?? 0.5;
  const out = {};
  for (const key of COST_KEYS) if (def.cost?.[key]) out[key] = Math.floor(def.cost[key] * k);
  return out;
}

const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });

/**
 * One turret tick: turn towards the nearest target and fire when lined up.
 * Normally targets enemies; with `hostile` (a market you angered) it
 * targets you instead, with shots that hurt.
 */
export function runTurret(game, st, dt, { hostile = false, range = null } = {}) {
  const rt = st.rt;
  const spec = st.def.turret;
  rt.cd -= dt;
  const cx = st.x + 0.5;
  const cy = st.y + 0.3;
  const reach = range ?? spec.range;
  let best = null;
  let bestD = reach * reach;
  if (hostile) {
    const p = game.player;
    const d = dist2(cx, cy, p.x, p.y);
    if (!p.dead && d < bestD) {
      best = p;
      bestD = d;
    }
  } else {
    for (const e of game.enemies) {
      if (e.dead) continue;
      const d = dist2(cx, cy, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
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
  rt.cd = spec.interval * (hostile ? 0.8 : 1);
  rt.flash = 0.06;
  const lead = Math.sqrt(bestD) / spec.speed;
  const vx = best.vx ?? 0;
  const vy = best.vy ?? 0;
  const angle = Math.atan2(best.y + vy * lead - cy, best.x + vx * lead - cx);
  const damage = hostile
    ? 8 + game.save.player.level * 3
    : game.construction.turretDamage(st.def);
  const proj = game.spawnProjectile({
    x: cx, y: cy, angle, speed: spec.speed, damage, range: reach + 1,
    size: spec.sprite === 'orb' ? 3 : 2, sprite: spec.sprite, owner: hostile ? 'enemy' : 'turret',
    element: spec.element ?? 'physical', color: spec.color, status: spec.status ?? null, depth: 1,
  });
  if (proj) proj.structure = st;
  game.audio.play(spec.element === 'fire' ? 'whirl' : 'hit', { throttle: 120 });
}

export class Construction {
  constructor(game) {
    this.game = game;
    this.lastHit = -99;
    this.damaged = new Set();
    this.load();
  }

  get list() {
    return this.game.save.base.structures;
  }

  load() {
    const world = this.game.world;
    world.structures.clear();
    const keep = [];
    for (const st of this.list) {
      if (this.#attach(st)) keep.push(st);
    }
    this.game.save.base.structures = keep;
  }

  #attach(st) {
    const def = structureDef(this.game.data, st.id);
    if (!def) return false;
    hidden(st, 'def', def);
    hidden(st, 'rt', { cd: Math.random() * 0.5, aim: -Math.PI / 2, flash: 0, trig: -9, open: 0 });
    st.hp = Math.min(def.hp, st.hp ?? def.hp);
    if (st.hp < def.hp) this.damaged.add(st);
    this.game.world.structures.set(tileKey(st.x, st.y), st);
    return true;
  }

  at(tx, ty) {
    return this.game.world.structureAt(tx, ty);
  }

  /** Why `def` can't go on tile (tx, ty), or null when it can. */
  placementProblem(def, tx, ty) {
    const { data, save, world, player } = this.game;
    const lock = structureLock(data, save, def);
    if (lock) return lock;
    if (!inBuildArea(data, save, tx, ty)) return 'Outside your camp. Upgrade the Hearth to expand it';
    if (dist2(player.x, player.y, tx + 0.5, ty + 0.5) > (data.building.reach + 0.5) ** 2) return 'Too far away';
    if (reservedTile(data, tx, ty)) return 'Too close to a camp building';
    const block = world.blockAt(tx, ty);
    if (block) return [T.WATER, T.LAVA, T.SEA, T.DEEP].includes(block) ? 'Can’t build on water' : 'Clear the tree or rock first (pickaxe)';
    if (this.at(tx, ty)) return 'Something is already built here';
    if (!def.walkable) {
      const inside = (x, y, r) => x + r > tx && x - r < tx + 1 && y + r > ty && y - r < ty + 1;
      if (inside(player.x, player.y, player.r)) return 'You are standing there';
      if (this.game.enemies.some((e) => !e.dead && inside(e.x, e.y, e.r))) return 'Something is in the way';
    }
    if (this.list.length >= (data.building.maxStructures ?? 600)) return 'Your camp can’t hold more structures';
    if (!canAfford(save.resources, def.cost)) return shortfalls(save.resources, def.cost)[0];
    return null;
  }

  place(id, tx, ty) {
    const def = structureDef(this.game.data, id);
    if (!def) return { ok: false, reason: 'Unknown structure' };
    const reason = this.placementProblem(def, tx, ty);
    if (reason) return { ok: false, reason };
    pay(this.game.save.resources, def.cost);
    const st = { id, x: tx, y: ty, hp: def.hp };
    this.list.push(st);
    this.#attach(st);
    const g = this.game;
    g.fx.emit(def.kind === 'floor' ? 'dust' : 'wood', tx + 0.5, ty + 0.6, 6, 0.6, 1.5);
    g.audio.play('build', { throttle: 60 });
    g.emit('structures');
    g.requestSave();
    return { ok: true, structure: st };
  }

  /** Takes a structure down and refunds part of its cost. */
  remove(tx, ty) {
    const st = this.at(tx, ty);
    if (!st) return null;
    const refund = refundFor(this.game.data, st.def);
    for (const [k, v] of Object.entries(refund)) this.game.save.resources[k] += v;
    this.#destroy(st, false);
    this.game.audio.play('break', { throttle: 60 });
    this.game.requestSave();
    return refund;
  }

  #destroy(st, byEnemy) {
    const g = this.game;
    const i = this.list.indexOf(st);
    if (i >= 0) this.list.splice(i, 1);
    g.world.structures.delete(tileKey(st.x, st.y));
    this.damaged.delete(st);
    st.dead = true;
    g.fx.emit(st.def.kind === 'wall' && st.id.startsWith('stone') ? 'stone' : 'wood', st.x + 0.5, st.y + 0.5, 12, 0.8, 2.5);
    g.fx.emit('smoke', st.x + 0.5, st.y + 0.5, 6, 0.6, 1);
    if (byEnemy) {
      g.audio.play('break');
      if (st.def.kind === 'turret' || st.def.kind === 'gate') g.toast(`Your ${st.def.name} was destroyed!`, 'warn');
    }
    g.emit('structures');
  }

  damage(st, amount) {
    if (!st || st.dead) return;
    st.hp -= amount;
    st.rt.flash = 0.12;
    this.lastHit = this.game.time;
    this.damaged.add(st);
    this.game.fx.emit(st.id.startsWith('stone') ? 'stone' : 'wood', st.x + 0.5, st.y + 0.4, 2, 0.4, 1.5);
    if (st.hp <= 0) {
      this.#destroy(st, true);
      this.game.requestSave();
    }
  }

  /** Turret damage grows with your level and the Training Grounds. */
  turretDamage(def) {
    const { data, save } = this.game;
    const training = buildingLevel(data, save, 'training');
    return def.turret.damage * (1 + 0.25 * (save.player.level - 1)) * (1 + 0.15 * training);
  }

  update(dt) {
    const g = this.game;
    if (!this.list.length) return;
    const t = g.time;
    // Slow self-repair while nothing is attacking the camp.
    if (this.damaged.size && t - this.lastHit > 8) {
      const rate = g.data.building.repairPerSec ?? 0.02;
      for (const st of this.damaged) {
        st.hp = Math.min(st.def.hp, st.hp + st.def.hp * rate * dt);
        if (st.hp >= st.def.hp) this.damaged.delete(st);
      }
    }
    const p = g.player;
    for (const st of this.list) {
      const rt = st.rt;
      if (rt.flash > 0) rt.flash -= dt;
      const kind = st.def.kind;
      if (kind === 'turret') runTurret(g, st, dt);
      else if (kind === 'trap') this.#updateTrap(st, dt);
      else if (kind === 'gate') {
        const near = !p.dead && dist2(p.x, p.y, st.x + 0.5, st.y + 0.5) < 1.6 * 1.6;
        rt.open = Math.max(0, Math.min(1, rt.open + (near ? dt : -dt) * 6));
      }
    }
  }

  #updateTrap(st, dt) {
    const g = this.game;
    const rt = st.rt;
    rt.cd -= dt;
    if (rt.cd > 0) return;
    let hit = false;
    for (const e of g.enemies) {
      if (e.dead || e.boss) continue;
      if (e.x + e.r > st.x && e.x - e.r < st.x + 1 && e.y + e.r > st.y && e.y - e.r < st.y + 1) {
        g.damageEnemy(e, this.turretDamage({ turret: st.def.trap }), { structure: st, canCrit: false });
        hit = true;
      }
    }
    if (hit) {
      rt.cd = st.def.trap.interval;
      rt.trig = g.time;
      g.audio.play('hit', { throttle: 90 });
    }
  }
}
