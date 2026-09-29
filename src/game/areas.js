// Lingering area effects: portals / black holes (pull), clouds and lava
// pools (damage over time), time warps (slow), orbiting blade rings,
// expanding shockwaves, and enemy telegraphs/hazards.

import { dist2, normalize } from '../core/math.js';
import { applyStatus, statusForElement } from './status.js';

const MAX_AREAS = 40;
const TICK = 0.3;

export function spawnArea(game, kind, o) {
  if (game.areas.length >= MAX_AREAS) {
    const idx = game.areas.findIndex((a) => a.owner !== 'enemy');
    if (idx < 0) return null;
    game.areas.splice(idx, 1);
  }
  const area = {
    kind,
    x: o.x,
    y: o.y,
    r: o.r ?? 2,
    dur: o.dur ?? 2,
    t: 0,
    tick: 0,
    dps: o.dps ?? 0,
    pull: o.pull ?? 0,
    element: o.element ?? 'physical',
    owner: o.owner ?? 'player',
    color: o.color ?? game.data.byId.elements.get(o.element)?.glow ?? '#ffffff',
    ...o,
  };
  if (kind === 'quake') area.hitSet = new Set();
  if (kind === 'bladering') area.cooldowns = new Map();
  game.areas.push(area);
  return area;
}

function damageInside(game, a, amount, extra = {}) {
  for (const e of game.enemies) {
    if (e.dead) continue;
    const rr = a.r + e.r;
    if (dist2(a.x, a.y, e.x, e.y) > rr * rr) continue;
    game.damageEnemy(e, amount, { element: a.element, depth: 2, source: a.source ?? 'weapon', ...extra });
    if (a.element !== 'physical' && Math.random() < 0.3) {
      const st = statusForElement(game.data, a.element);
      if (st) applyStatus(game, e, st, amount * 3);
    }
  }
}

export function updateAreas(game, dt) {
  const player = game.player;
  for (let i = game.areas.length - 1; i >= 0; i--) {
    const a = game.areas[i];
    a.t += dt;
    a.tick += dt;
    const tick = a.tick >= TICK;
    if (tick) a.tick -= TICK;

    switch (a.kind) {
      case 'portal': {
        for (const e of game.enemies) {
          if (e.dead) continue;
          const d2 = dist2(a.x, a.y, e.x, e.y);
          const reach = a.r * 1.4;
          if (d2 > reach * reach || d2 < 0.01) continue;
          const n = normalize(a.x - e.x, a.y - e.y);
          const strength = a.pull * (e.boss ? 0.15 : 1) * dt;
          e.x += n.x * strength;
          e.y += n.y * strength;
        }
        if (tick) damageInside(game, a, a.dps * TICK);
        if (Math.random() < 0.5) game.fx.emit('void', a.x, a.y, 1, a.r * 1.4, 0.5);
        break;
      }
      case 'cloud':
        if (tick) damageInside(game, a, a.dps * TICK);
        if (Math.random() < 0.3) game.fx.emit(a.lava ? 'ember' : 'toxic', a.x, a.y, 1, a.r);
        break;
      case 'timewarp':
        for (const e of game.enemies) {
          if (dist2(a.x, a.y, e.x, e.y) <= a.r * a.r) {
            e.warpUntil = game.time + 0.2;
            e.warpSlow = a.slow;
          }
        }
        break;
      case 'bladering': {
        a.x = player.x;
        a.y = player.y;
        const n = a.count ?? 3;
        for (let k = 0; k < n; k++) {
          const ang = a.t * 5 + (k / n) * Math.PI * 2;
          const bx = a.x + Math.cos(ang) * a.r;
          const by = a.y + Math.sin(ang) * a.r;
          for (const e of game.enemies) {
            if (e.dead) continue;
            const rr = e.r + 0.4;
            if (dist2(bx, by, e.x, e.y) > rr * rr) continue;
            const key = `${k}:${e.id}`;
            if ((a.cooldowns.get(key) ?? 0) > game.time) continue;
            a.cooldowns.set(key, game.time + 0.35);
            game.damageEnemy(e, a.hit, { element: a.element, depth: 1, source: 'ability' });
            if (a.vampiric) game.heal(a.hit * 0.2);
          }
        }
        break;
      }
      case 'quake': {
        const radius = a.r * Math.min(1, a.t / a.dur);
        for (const e of game.enemies) {
          if (e.dead || a.hitSet.has(e)) continue;
          if (dist2(a.x, a.y, e.x, e.y) <= (radius + e.r) * (radius + e.r)) {
            a.hitSet.add(e);
            game.damageEnemy(e, a.hit, { element: a.element, depth: 1, source: 'ability', status: 'stagger', knockback: 2, fromX: a.x, fromY: a.y });
            if (a.vampiric) game.heal(a.hit * 0.2);
          }
        }
        break;
      }
      case 'telegraph':
        if (a.t >= a.dur) a.onEnd?.();
        break;
      case 'hazard':
        if (tick && !player.dead && dist2(a.x, a.y, player.x, player.y) <= (a.r + player.r) * (a.r + player.r)) {
          game.hurtPlayer(a.dps * TICK, { element: a.element });
        }
        if (Math.random() < 0.3) game.fx.emit(game.data.byId.elements.get(a.element)?.particles ?? 'smoke', a.x, a.y, 1, a.r);
        break;
      default:
        break;
    }
    if (a.t >= a.dur) game.areas.splice(i, 1);
  }
}

/** Speed multiplier for enemy projectiles (Time Warp slows them too). */
export function projectileSlowAt(game, p) {
  for (const a of game.areas) {
    if (a.kind === 'timewarp' && dist2(a.x, a.y, p.x, p.y) <= a.r * a.r) return 1 - a.slow / 100;
  }
  return 1;
}
