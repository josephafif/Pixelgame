// Projectiles for players and enemies: straight shots, lobbed shells,
// returning boomerangs/chakrams, homing, piercing, bouncing and splitting.

import { dist2, normalize, angleTo, angleDiff } from '../core/math.js';
import { T, REFLECTS } from './world.js';

const MAX_PROJECTILES = 260;
const PASS_THROUGH = new Set([T.WATER, T.LAVA, T.SEA, T.DEEP]);

export function spawnProjectile(game, o) {
  if (game.projectiles.length >= MAX_PROJECTILES) {
    // Drop the oldest proc projectile first; primary attacks always fire.
    const idx = game.projectiles.findIndex((p) => p.depth > 0);
    if (idx < 0 || o.depth > 0) return null;
    game.projectiles.splice(idx, 1);
  }
  const speed = o.speed || 8;
  const p = {
    x: o.x,
    y: o.y,
    vx: Math.cos(o.angle) * speed,
    vy: Math.sin(o.angle) * speed,
    speed,
    damage: o.damage,
    range: o.range ?? 6,
    travelled: 0,
    r: 0.12 + (o.size ?? 2) * 0.05,
    size: o.size ?? 2,
    pierce: o.pierce ?? 0,
    hit: new Set(),
    homing: o.homing ?? 0,
    bounces: o.bounces ?? 0,
    split: o.split ?? 0,
    element: o.element ?? 'physical',
    sprite: o.sprite ?? 'bolt',
    color: o.color ?? game.data.byId.elements.get(o.element)?.glow ?? '#ffffff',
    owner: o.owner ?? 'player',
    kind: o.kind ?? 'normal',
    source: o.source ?? 'weapon',
    depth: o.depth ?? 0,
    knockback: o.knockback ?? 0,
    status: o.status ?? null,
    pool: o.pool ?? null,
    tx: o.tx,
    ty: o.ty,
    blast: o.blast ?? 0,
    returning: false,
    echo: Boolean(o.echo),
    spin: 0,
    age: 0,
    reflections: 0,
    // A monster's shot sent back by a mirror crystal: now it hits monsters.
    turned: false,
  };
  if (p.kind === 'lob') {
    const d = Math.sqrt(dist2(p.x, p.y, p.tx, p.ty));
    p.flight = Math.max(0.25, d / speed);
    p.sx = p.x;
    p.sy = p.y;
  }
  game.projectiles.push(p);
  return p;
}

function steerTowards(p, tx, ty, turn, dt) {
  const cur = Math.atan2(p.vy, p.vx);
  const want = angleTo(p.x, p.y, tx, ty);
  const d = angleDiff(cur, want);
  const step = Math.max(-turn * dt, Math.min(turn * dt, d));
  const a = cur + step;
  p.vx = Math.cos(a) * p.speed;
  p.vy = Math.sin(a) * p.speed;
}

function nearestTarget(game, p, maxDist) {
  let best = null;
  let bestD = maxDist * maxDist;
  for (const e of game.enemies) {
    if (e.dead || p.hit.has(e)) continue;
    const d = dist2(p.x, p.y, e.x, e.y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function onPlayerProjectileHit(game, p, e) {
  p.hit.add(e);
  game.damageEnemy(e, p.damage, {
    element: p.element,
    canCrit: p.depth === 0,
    depth: p.depth,
    source: p.source,
    knockback: p.knockback,
    fromX: p.x - p.vx * 0.05,
    fromY: p.y - p.vy * 0.05,
    status: p.status,
  });
  if (p.split > 0 && p.depth === 0) {
    const base = Math.atan2(p.vy, p.vx);
    for (let i = 0; i < p.split; i++) {
      const off = (i / Math.max(1, p.split - 1) - 0.5) * 1.1;
      const child = spawnProjectile(game, {
        x: p.x, y: p.y, angle: base + off, speed: p.speed * 0.9, range: 3.5, size: Math.max(1, p.size - 1),
        damage: p.damage * 0.4, element: p.element, sprite: p.sprite, owner: 'player', source: p.source, depth: 1,
        color: p.color,
      });
      child?.hit.add(e);
    }
  }
  if (p.bounces > 0) {
    const next = nearestTarget(game, p, 5);
    if (next) {
      p.bounces -= 1;
      const n = normalize(next.x - p.x, next.y - p.y);
      p.vx = n.x * p.speed;
      p.vy = n.y * p.speed;
      p.travelled = Math.max(0, p.travelled - 3);
      return false;
    }
  }
  if (p.pierce > 0) {
    p.pierce -= 1;
    return false;
  }
  return true;
}

const MAX_REFLECTIONS = 4;

/** Bounces a shot off the crystal it just flew into (back out the way it came in). */
function reflect(p, dt) {
  const px = p.x - p.vx * dt;
  const py = p.y - p.vy * dt;
  const sideX = Math.floor(px) !== Math.floor(p.x);
  const sideY = Math.floor(py) !== Math.floor(p.y);
  if (sideX || !sideY) p.vx = -p.vx;
  if (sideY || !sideX) p.vy = -p.vy;
  p.x = px;
  p.y = py;
  p.reflections += 1;
  p.damage *= 1.15;
  p.travelled = Math.max(0, p.travelled - 2);
  p.hit.clear();
}

function expire(game, p) {
  if (p.kind === 'lob' && p.owner === 'player') {
    game.explode(p.x, p.y, p.blast, p.damage, p.element);
  }
  if (p.pool) {
    game.spawnArea('cloud', {
      x: p.x, y: p.y, r: p.pool.radius, dur: p.pool.duration,
      dps: (p.pool.dps / 100) * game.weaponDamage(), element: p.element, lava: true,
    });
  }
}

export function updateProjectiles(game, dt) {
  const list = game.projectiles;
  const player = game.player;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.age += dt;
    p.spin += dt * 18;
    let remove = false;

    if (p.kind === 'lob') {
      const t = Math.min(1, p.age / p.flight);
      p.x = p.sx + (p.tx - p.sx) * t;
      p.y = p.sy + (p.ty - p.sy) * t;
      p.z = Math.sin(t * Math.PI) * 1.4;
      if (t >= 1) {
        expire(game, p);
        remove = true;
      }
    } else {
      if (p.kind === 'boomerang') {
        if (!p.returning && p.travelled >= p.range) {
          p.returning = true;
          p.hit.clear();
        }
        if (p.returning) {
          steerTowards(p, player.x, player.y, 14, dt);
          if (dist2(p.x, p.y, player.x, player.y) < 0.5) remove = true;
        }
      } else if (p.homing && p.owner === 'player') {
        const target = nearestTarget(game, p, 6);
        if (target) steerTowards(p, target.x, target.y, 5 + p.homing * 2, dt);
      }
      const slow = p.owner === 'enemy' ? game.enemyProjectileSlow(p) : 1;
      p.x += p.vx * dt * slow;
      p.y += p.vy * dt * slow;
      p.travelled += p.speed * dt * slow;
      if (p.kind !== 'boomerang' && p.travelled >= p.range) {
        expire(game, p);
        remove = true;
      }
      if (!remove && p.kind !== 'boomerang') {
        const tx = Math.floor(p.x);
        const ty = Math.floor(p.y);
        const block = game.world.isSolid(tx, ty) ? game.world.blockAt(tx, ty) : 0;
        // Mirror crystals send shots off at an angle (a little stronger each
        // time), so you can hit what hides behind cover, or turn a monster's
        // shot on its own kind.
        if (REFLECTS.has(block) && p.reflections < MAX_REFLECTIONS && game.world.propAt(p.x, p.y)) {
          reflect(p, dt * slow);
          if (p.owner === 'enemy') p.turned = true;
          game.fx.emit('glint', p.x, p.y, 4, 0.3, 1.5, ['#e8fbff', '#7ae8ff', '#c09aff']);
          game.audio.play('zap', { throttle: 120 });
        } else if (block && !PASS_THROUGH.has(block) && game.world.propAt(p.x, p.y)) {
          game.fx.emit('hit', p.x, p.y, 3, 0.2, 1.5);
          expire(game, p);
          remove = true;
        } else if (p.owner === 'enemy') {
          // Walls and turrets shield you from enemy shots (and take the hit).
          const st = game.world.structureAt(tx, ty);
          // A market's own turrets shoot over its walls and stalls.
          const own = st && p.structure?.marketId && st.marketId === p.structure.marketId;
          if (st && !st.def.walkable && !own) {
            game.damageStructure?.(st, p.damage * 0.5);
            game.fx.emit('hit', p.x, p.y, 3, 0.2, 1.5);
            remove = true;
          }
        }
      }
      if (p.kind === 'boomerang' && p.age > 6) remove = true;
    }

    if (!remove && p.kind !== 'lob') {
      if (p.owner === 'player' && (game.markets?.npcs.length || game.workers?.length) && game.hitNpcs({ kind: 'circle', x: p.x, y: p.y, r: p.r }, p.damage)) {
        expire(game, p);
        remove = true;
      } else if (p.owner === 'player') {
        for (const e of game.enemies) {
          if (e.dead || e.submerged || p.hit.has(e)) continue;
          const rr = e.r + p.r;
          if (dist2(p.x, p.y, e.x, e.y) <= rr * rr) {
            // A Mirror Knight's shield sends some shots straight back at you.
            if (e.def?.reflect && p.kind === 'normal' && p.source !== 'reflect' && Math.random() < e.def.reflect) {
              p.vx = -p.vx;
              p.vy = -p.vy;
              p.owner = 'enemy';
              p.source = 'reflect';
              p.damage *= 0.6;
              p.travelled = Math.max(0, p.travelled - 3);
              p.hit.clear();
              game.fx.text(e.x, e.y - 1, 'REFLECT', '#e8fbff', 0.8);
              game.fx.emit('glint', p.x, p.y, 5, 0.3, 1.5, ['#e8fbff', '#7ae8ff']);
              break;
            }
            if (onPlayerProjectileHit(game, p, e)) {
              expire(game, p);
              remove = true;
              break;
            }
          }
        }
      } else if (p.owner === 'turret') {
        for (const e of game.enemies) {
          if (e.dead) continue;
          const rr = e.r + p.r;
          if (dist2(p.x, p.y, e.x, e.y) <= rr * rr) {
            game.turretHit?.(p, e);
            remove = true;
            break;
          }
        }
      } else if (p.turned) {
        for (const e of game.enemies) {
          if (e.dead || e.submerged || p.hit.has(e)) continue;
          const rr = e.r + p.r;
          if (dist2(p.x, p.y, e.x, e.y) <= rr * rr) {
            game.damageEnemy(e, p.damage, { element: p.element, canCrit: false, depth: 1, source: 'reflect', fromX: p.x - p.vx * 0.05, fromY: p.y - p.vy * 0.05 });
            remove = true;
            break;
          }
        }
      } else if (!player.dead) {
        const rr = player.r + p.r;
        if (dist2(p.x, p.y, player.x, player.y) <= rr * rr) {
          game.hurtPlayer(p.damage, { element: p.element, fromX: p.x - p.vx, fromY: p.y - p.vy });
          if (p.status) game.applyPlayerStatus(p.status);
          remove = true;
        }
      }
    }
    if (remove) {
      list[i] = list[list.length - 1];
      list.pop();
    }
  }
}
