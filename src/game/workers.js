// Workers: people you hire at the Workers' Lodge. Each one walks out into
// the wild, chops trees (lumberjacks) or breaks rocks (miners), carries what
// it got back to the lodge and puts it in the Vault, then sets out again.
// They cost a daily wage (base upkeep, see upkeep.js); unpaid, they stay
// home. Hurt one and it turns on you for a while.
//
// Pure behaviour shared by single player (src/game/workforce.js) and the
// server (server/workers.js): the caller hands stepWorker a small context
// that does the world changes (felling a tree, filling the vault, a blow).

import { hashInts } from '../core/rng.js';
import { harvestInfo } from './gathering.js';

export const WORKER_ROLES = ['wood', 'stone'];
export const ROLE_NAMES = { wood: 'Lumberjack', stone: 'Miner' };
export const ROLE_NAMES_SV = { wood: 'Skogshuggare', stone: 'Gruvarbetare' };

// (Plain letters only: names are drawn over their heads in the tiny pixel font.)
const NAMES = [
  'Alva', 'Bror', 'Dag', 'Edvin', 'Frida', 'Gustav', 'Hedda', 'Ingrid', 'Jon', 'Knut', 'Lova', 'Magnus',
  'Nora', 'Olle', 'Pelle', 'Rut', 'Sixten', 'Tyra', 'Valter', 'Ylva', 'Ebbe', 'Siri', 'Tore', 'Majken',
];
const CLOAKS = ['#8a5a33', '#4f7a3a', '#3f6fa8', '#a8323a', '#7a5aa8', '#c8963a', '#3a8a8a', '#6e6b80'];
const HATS = ['#c8a050', '#6b4a2a', '#a8323a', '#3a5a8a', '#e8e0c8'];

const REACH = 0.85; // how close to a tree's centre a worker stands to chop it
const STRIKE_REACH = 0.95;
const STRIKE_EVERY = 1.0;
const LEASH = 22; // an angry worker gives up chasing beyond this

/** A worker's name and colours: the same everywhere, from who owns it and its number. */
export function workerLook(owner, id) {
  const h = hashInts(typeof owner === 'number' ? owner : 0x51d, id, 0x40a7);
  return {
    name: NAMES[h % NAMES.length],
    cloak: CLOAKS[(h >>> 8) % CLOAKS.length],
    hat: HATS[(h >>> 16) % HATS.length],
  };
}

/** How many workers the lodge houses (0 until it is built). */
export function workerCap(data, lodgeLevel) {
  if (lodgeLevel <= 0) return 0;
  return (data.base.workers?.baseCap ?? 1) + lodgeLevel;
}

/** What hiring one more worker costs (each one dearer than the last). */
export function hireCost(data, count) {
  const w = data.base.workers;
  const k = 1 + (w.hireGrowth ?? 0.5) * count;
  const out = {};
  for (const [res, n] of Object.entries(w.hire ?? {})) out[res] = Math.round(n * k);
  return out;
}

/** The hardest thing workers can break: trees and rocks (1), crystals (2), obsidian (3), ore (4). */
export function workerTier(lodgeLevel) {
  return Math.max(1, Math.min(4, lodgeLevel - 1));
}

/** A worker's numbers at a lodge level. */
export function workerStats(data, lodgeLevel) {
  const w = data.base.workers;
  const n = Math.max(0, lodgeLevel - 1);
  return {
    hp: w.hp + (w.hpPerLevel ?? 0) * n,
    power: w.power + (w.powerPerLevel ?? 0) * n,
    damage: w.damage + (w.damagePerLevel ?? 0) * n,
    speed: w.speed,
    swing: w.swing ?? 0.9,
    tier: workerTier(lodgeLevel),
    range: w.range ?? 40,
    fells: w.fellsPerTrip ?? 2,
    calm: w.calmSeconds ?? 30,
    rest: w.restSeconds ?? 12,
  };
}

/** Can a worker with this role and skill work on this harvestable? */
export function canWorkOn(info, role, tier) {
  if (!info || info.tier > tier) return false;
  if (role === 'wood') return Boolean(info.drops?.wood);
  return !info.drops?.wood;
}

/** A fresh runtime worker for a roster record { id, role }, standing at `home`. */
export function createWorker(rec, home, stats) {
  return {
    id: rec.id, role: rec.role, x: home.x, y: home.y, r: 0.3, facing: Math.PI / 2,
    hp: stats.hp, maxHp: stats.hp, state: 'rest', t: 0, restFor: 1 + Math.random() * 3,
    job: null, carry: {}, fells: 0, dmg: 0, swingT: 0, anim: 0, moving: false, walkT: 0,
    hurtFlash: 0, angry: null, calmAt: 0, strikeT: 0, stuckT: 0, lastD: Infinity, detour: 0, detourT: 0, dead: false, idle: false,
  };
}

function key(t) {
  return `${t.tx},${t.ty}`;
}

/** The best tree or rock around (cx, cy) for this worker, or null. */
function scan(ctx, w, cx, cy, radius, stats) {
  const { world, data, home, clear, taken } = ctx;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  let best = null;
  let bestD = Infinity;
  const range2 = stats.range * stats.range;
  const clear2 = clear ? (clear.r + 1.5) ** 2 : -1;
  for (let ty = y0 - radius; ty <= y0 + radius; ty++) {
    for (let tx = x0 - radius; tx <= x0 + radius; tx++) {
      const id = world.blockAt(tx, ty);
      if (!id) continue;
      const info = harvestInfo(data, id);
      if (!canWorkOn(info, w.role, stats.tier)) continue;
      const mx = tx + 0.5;
      const my = ty + 0.5;
      if ((mx - home.x) ** 2 + (my - home.y) ** 2 > range2) continue;
      if (clear && (mx - clear.x) ** 2 + (my - clear.y) ** 2 < clear2) continue;
      if (taken.has(`${tx},${ty}`)) continue;
      if (world.marketAt?.(mx, my, 1)) continue; // never in a market or a village
      const d = (mx - w.x) ** 2 + (my - w.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { tx, ty, info };
      }
    }
  }
  if (!best) return null;
  // Stand on the side facing the worker (or any open side).
  const cxT = best.tx + 0.5;
  const cyT = best.ty + 0.5;
  const dx = w.x - cxT;
  const dy = w.y - cyT;
  const d = Math.hypot(dx, dy) || 1;
  const sides = [[dx / d, dy / d], [0, 1], [1, 0], [-1, 0], [0, -1]];
  for (const [sx, sy] of sides) {
    const x = cxT + sx * REACH;
    const y = cyT + sy * REACH;
    if (world.isFree(x, y, w.r, 'pal')) return { ...best, sx: x, sy: y };
  }
  return null;
}

/** Finds the next job: near the worker first, then around random spots within range of home. */
export function findWorkTarget(ctx, w, stats) {
  const rng = ctx.rng ?? Math.random;
  const tries = [[w.x, w.y, 9]];
  for (let i = 0; i < 3; i++) {
    const a = rng() * Math.PI * 2;
    const r = stats.range * (0.35 + rng() * 0.6);
    tries.push([ctx.home.x + Math.cos(a) * r, ctx.home.y + Math.sin(a) * r, 10]);
  }
  for (const [x, y, radius] of tries) {
    const t = scan(ctx, w, x, y, radius, stats);
    if (t) return t;
  }
  return null;
}

/**
 * Walks towards (tx, ty), sliding along walls and stepping sideways when
 * stuck. Returns true on arrival.
 */
function walk(ctx, w, tx, ty, speed, dt, arrive = 0.2) {
  const dx = tx - w.x;
  const dy = ty - w.y;
  const d = Math.hypot(dx, dy);
  if (d <= arrive) {
    w.moving = false;
    w.stuckT = 0;
    w.lastD = Infinity;
    return true;
  }
  let mx = dx / d;
  let my = dy / d;
  if (w.detourT > 0) {
    // Step around whatever is in the way.
    w.detourT -= dt;
    const px = -my * w.detour;
    const py = mx * w.detour;
    mx = mx * 0.3 + px;
    my = my * 0.3 + py;
    const n = Math.hypot(mx, my) || 1;
    mx /= n;
    my /= n;
  }
  const step = Math.min(d, speed * dt);
  const world = ctx.world;
  const nx = w.x + mx * step;
  const ny = w.y + my * step;
  if (world.isFree(nx, ny, w.r, 'pal')) {
    w.x = nx;
    w.y = ny;
  } else {
    if (world.isFree(nx, w.y, w.r, 'pal')) w.x = nx;
    if (world.isFree(w.x, ny, w.r, 'pal')) w.y = ny;
  }
  w.moving = true;
  w.walkT += dt * 8;
  w.facing = Math.atan2(my, mx);
  const now = Math.hypot(tx - w.x, ty - w.y);
  if (now > w.lastD - speed * dt * 0.25) {
    w.stuckT += dt;
    if (w.stuckT > 0.5 && w.detourT <= 0) {
      w.detour = w.detour === 1 ? -1 : 1;
      w.detourT = 0.9;
    }
  } else {
    w.stuckT = Math.max(0, w.stuckT - dt * 0.5);
  }
  w.lastD = now;
  return false;
}

function release(ctx, w) {
  if (w.job) ctx.taken.delete(key(w.job));
  w.job = null;
}

function setState(w, state) {
  w.state = state;
  w.t = 0;
  w.stuckT = 0;
  w.lastD = Infinity;
  w.detourT = 0;
}

function goHome(ctx, w) {
  release(ctx, w);
  setState(w, 'return');
}

/** One worker, one step. */
export function stepWorker(w, ctx, dt) {
  w.hurtFlash = Math.max(0, w.hurtFlash - dt);
  if (w.dead) return;
  const stats = ctx.stats;
  w.t += dt;
  if (w.angry) {
    angry(w, ctx, dt, stats);
    return;
  }
  if (w.hp < w.maxHp) w.hp = Math.min(w.maxHp, w.hp + dt * 2);
  const home = ctx.home;
  if (!ctx.working && (w.state === 'go' || w.state === 'work')) goHome(ctx, w);
  switch (w.state) {
    case 'rest': {
      w.moving = false;
      w.idle = !ctx.working;
      if (w.t < w.restFor) return;
      if (!ctx.working) {
        w.restFor = 2;
        w.t = 0;
        return;
      }
      const job = findWorkTarget(ctx, w, stats);
      if (!job) {
        w.restFor = 6 + (ctx.rng ?? Math.random)() * 6;
        w.t = 0;
        return;
      }
      w.job = job;
      ctx.taken.add(key(job));
      setState(w, 'go');
      return;
    }
    case 'go': {
      const job = w.job;
      if (!job || !ctx.world.blockAt(job.tx, job.ty)) {
        nextJob(w, ctx, stats);
        return;
      }
      if (walk(ctx, w, job.sx, job.sy, stats.speed, dt)) {
        setState(w, 'work');
        w.dmg = 0;
        w.swingT = stats.swing;
      } else if (w.stuckT > 5 || w.t > 60) {
        // Can't get there: try something else.
        release(ctx, w);
        setState(w, 'rest');
        w.restFor = 0.5;
      }
      return;
    }
    case 'work': {
      const job = w.job;
      w.moving = false;
      if (!job || !ctx.world.blockAt(job.tx, job.ty)) {
        nextJob(w, ctx, stats);
        return;
      }
      w.facing = Math.atan2(job.ty + 0.5 - w.y, job.tx + 0.5 - w.x);
      w.swingT -= dt;
      if (w.swingT > 0) return;
      w.swingT = stats.swing;
      w.anim = (w.anim + 1) & 255;
      w.dmg += stats.power;
      ctx.chop?.(w, job, Math.min(1, w.dmg / job.info.hp));
      if (w.dmg < job.info.hp) return;
      const drops = ctx.fell(w, job) ?? {};
      for (const [k, n] of Object.entries(drops)) w.carry[k] = (w.carry[k] ?? 0) + n;
      w.fells++;
      release(ctx, w);
      if (w.fells >= stats.fells) goHome(ctx, w);
      else nextJob(w, ctx, stats);
      return;
    }
    case 'return': {
      if (walk(ctx, w, home.x, home.y, stats.speed, dt, 0.35)) {
        if (Object.keys(w.carry).length) ctx.deliver(w, w.carry);
        w.carry = {};
        w.fells = 0;
        setState(w, 'rest');
        // A breather at the lodge (and a bite to eat) before the next trip.
        w.restFor = (stats.rest ?? 12) * (0.75 + (ctx.rng ?? Math.random)() * 0.5);
      } else if (w.stuckT > 6 || w.t > 90) {
        // Lost: they find their own way back (and turn up at the lodge).
        w.x = home.x;
        w.y = home.y;
        ctx.teleported?.(w);
      }
      return;
    }
    default:
      setState(w, 'rest');
  }
}

/** After a tree falls (or someone else got it first): the next one nearby, or home with what it carries. */
function nextJob(w, ctx, stats) {
  release(ctx, w);
  if (!ctx.working) {
    goHome(ctx, w);
    return;
  }
  const t = scan(ctx, w, w.x, w.y, 7, stats);
  if (t) {
    w.job = t;
    ctx.taken.add(key(t));
    setState(w, 'go');
  } else {
    goHome(ctx, w);
  }
}

function angry(w, ctx, dt, stats) {
  const foe = ctx.target(w);
  const far = foe ? (foe.x - w.x) ** 2 + (foe.y - w.y) ** 2 > LEASH * LEASH : true;
  if (!foe || foe.dead || far || ctx.time >= w.calmAt) {
    w.angry = null;
    ctx.calmed?.(w);
    goHome(ctx, w);
    return;
  }
  w.strikeT -= dt;
  if (walk(ctx, w, foe.x, foe.y, stats.speed * 1.35, dt, STRIKE_REACH)) {
    w.facing = Math.atan2(foe.y - w.y, foe.x - w.x);
    if (w.strikeT <= 0) {
      w.strikeT = STRIKE_EVERY;
      w.anim = (w.anim + 1) & 255;
      ctx.strike(w, foe, stats.damage);
    }
  }
}

/**
 * Someone hurt a worker: it turns on them (`attacker` is whatever
 * ctx.target looks up). Returns true when the blow killed it.
 */
export function hurtWorker(w, ctx, damage, attacker) {
  if (w.dead) return false;
  w.hp -= damage;
  w.hurtFlash = 0.15;
  if (!w.angry) w.strikeT = 0.6;
  w.angry = attacker;
  w.calmAt = ctx.time + ctx.stats.calm;
  release(ctx, w);
  if (w.hp <= 0) {
    w.dead = true;
    w.moving = false;
    return true;
  }
  return false;
}

/**
 * Does an attack shape reach someone? Shapes: { kind: 'arc', x, y, angle,
 * range, half } | { kind: 'line', x, y, ex, ey, width } | { kind: 'circle', x, y, r }.
 */
export function inShape(n, s) {
  if (s.kind === 'circle') return (n.x - s.x) ** 2 + (n.y - s.y) ** 2 <= (s.r + n.r) ** 2;
  if (s.kind === 'arc') {
    const d = Math.hypot(n.x - s.x, n.y - s.y);
    if (d > s.range + n.r) return false;
    let diff = Math.atan2(n.y - s.y, n.x - s.x) - s.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return d < n.r + 0.4 || Math.abs(diff) <= s.half + Math.atan2(n.r, d);
  }
  if (s.kind === 'line') {
    const vx = s.ex - s.x;
    const vy = s.ey - s.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((n.x - s.x) * vx + (n.y - s.y) * vy) / len2));
    const px = s.x + vx * t - n.x;
    const py = s.y + vy * t - n.y;
    return px * px + py * py <= (s.width / 2 + n.r) ** 2;
  }
  return false;
}

/** Roughly what a paid worker brings in per hour (time away from the game). */
export function awayYield(data, role, lodgeLevel) {
  const per = data.base.workers?.offlinePerHour ?? {};
  const k = 1 + 0.15 * Math.max(0, lodgeLevel - 1);
  const res = role === 'wood' ? 'wood' : 'stone';
  return { [res]: (per[res] ?? 0) * k };
}
