// Weapon runtime. A weapon's DNA is compiled into a set of hook lists
// (attack / hit / crit / kill / nth) and executed by generic actions — no
// weapon has hand-written code, so two swords with different DNA really do
// play differently (Flame Arc throws fire, Thunder Strike chains lightning,
// Blood Feast heals, Void Edge opens portals...).

import { angleDiff, angleTo, dist2, normalize, segmentDist2 } from '../core/math.js';
import { applyStatus, statusForElement, isChilled } from './status.js';
import { spawnProjectile } from './projectiles.js';
import { spawnArea } from './areas.js';
import { killEnemy } from './enemies.js';
import { attackDuration, impactDelay, MELEE_PATTERNS } from '../render/weapon-anim.js';

const DEG = Math.PI / 180;
// Hooks that may still run on damage caused by other hooks (depth >= 1).
// Everything else only triggers from direct weapon hits, which keeps
// chain reactions bounded and cheap.
const PROC_SAFE = new Set(['heal', 'status']);

export function compileWeapon(dna) {
  const hooks = { attack: [], hit: [], crit: [], kill: [], nth: [] };
  let bounces = 0;
  const sources = [...dna.modifiers, ...dna.effects, ...(dna.drawback ? [dna.drawback] : [])];
  for (const src of sources) {
    for (const h of src.hooks ?? []) {
      if (h.on === 'static') {
        if (h.do === 'projMod') bounces += h.bounces ?? 0;
        continue;
      }
      hooks[h.on]?.push({ ...h, source: src.name });
    }
  }
  return {
    dna,
    stats: dna.stats,
    attack: dna.attack,
    element: dna.element,
    hooks,
    bounces,
    trail: dna.visual.trail,
    particles: dna.visual.particles,
  };
}

export function weaponDamage(game) {
  return game.weapon.stats.damage * (1 + game.pstats.attackPower / 100);
}

// --- Queries -----------------------------------------------------------------

export function nearestEnemy(game, x, y, maxDist, exclude = null) {
  let best = null;
  let bestD = maxDist * maxDist;
  for (const e of game.enemies) {
    if (e.dead || (exclude && exclude.has(e))) continue;
    const d = dist2(x, y, e.x, e.y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function enemiesInRadius(game, x, y, r) {
  const out = [];
  for (const e of game.enemies) {
    if (e.dead) continue;
    const rr = r + e.r;
    if (dist2(x, y, e.x, e.y) <= rr * rr) out.push(e);
  }
  return out;
}

/**
 * The weapon aims itself: it locks onto the nearest enemy within reach.
 * The current target gets a bonus so the lock doesn't flicker between two
 * enemies at similar distance, and bosses are preferred.
 */
export function acquireTarget(game, current) {
  const p = game.player;
  const reach = Math.max(4.5, (game.weapon?.stats.range ?? 3) + 3.5);
  let best = null;
  let bestScore = Infinity;
  for (const e of game.enemies) {
    if (e.dead) continue;
    const d = Math.sqrt(dist2(p.x, p.y, e.x, e.y)) - e.r;
    if (d > reach) continue;
    // Bosses (and their mirror images, so the lock never gives the real one away) come first.
    const score = d - (e === current ? 1.2 : 0) - (e.boss || e.cloneOf ? 0.8 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

// --- Damage --------------------------------------------------------------------

/**
 * Damages an enemy and runs the weapon's hooks.
 * opts: { element, canCrit, depth, source ('weapon'|'proc'|'ability'|'dot'),
 *         knockback, fromX, fromY, status, color }
 */
export function dealDamage(game, e, amount, opts = {}) {
  if (e.dead || amount <= 0) return 0;
  const data = game.data;
  const depth = opts.depth ?? 0;
  const element = opts.element ?? 'physical';
  let crit = false;
  if (opts.canCrit) {
    if (e.status.mark?.until > game.time) {
      crit = true;
      e.status.mark = null;
    } else {
      crit = Math.random() * 100 < game.pstats.critChance;
    }
  }
  let dmg = amount * (crit ? game.pstats.critDamage / 100 : 1);
  if (e.status.shock?.until > game.time) dmg *= 1 + data.statuses.shock.vulnerability / 100;
  if (element !== 'physical' && e.element && e.element !== 'physical') {
    if (e.element === element) dmg *= 0.6;
    else if (data.byId.elements.get(e.element)?.opposes.includes(element)) dmg *= 1.5;
  }
  dmg = Math.max(1, Math.round(dmg));
  e.hp -= dmg;
  e.flash = 0.08;
  if (!e.boss) {
    // Being hit wakes an enemy up, even from beyond its sight range.
    e.alertUntil = game.time + 5;
    if (opts.structure) e.siege = opts.structure;
  }
  if (!opts.quiet) {
    const color = opts.color ?? (element !== 'physical' ? data.byId.elements.get(element)?.glow : null) ?? '#ffffff';
    game.fx.number(e.x, e.y - e.r - 0.3, dmg, { crit, color });
  }
  if (depth === 0) {
    game.fx.emit('hit', e.x, e.y, crit ? 6 : 3, 0.3, 3);
    game.audio.play(crit ? 'crit' : 'hit');
    if (crit) game.shake = Math.max(game.shake, 0.15);
    // A few frames of hit-stop make melee blows feel heavy.
    if (opts.melee) game.addHitstop?.(crit ? 0.06 : e.boss ? 0.045 : 0.03);
    e.squash = 1;
  }
  if (opts.knockback && !e.boss) {
    const n = normalize(e.x - (opts.fromX ?? game.player.x), e.y - (opts.fromY ?? game.player.y));
    const k = opts.knockback * (e.elite ? 1.5 : 2.5);
    e.kx += n.x * k;
    e.ky += n.y * k;
  }
  if (depth === 0 && element !== 'physical' && Math.random() < 0.2) {
    const st = statusForElement(data, element);
    if (st) applyStatus(game, e, st, dmg);
  }
  if (opts.status) applyStatus(game, e, opts.status, dmg);

  // Resolve the death first so follow-up hooks never see a half-dead enemy.
  const died = e.hp <= 0;
  const wasChilled = died && isChilled(game, e);
  if (died) killEnemy(game, e);

  if (opts.source === 'weapon' && game.weapon) {
    const ctx = { target: e, damage: dmg, crit, depth, x: e.x, y: e.y };
    for (const h of game.weapon.hooks.hit) runHitHook(game, h, ctx);
    if (crit && depth === 0) for (const h of game.weapon.hooks.crit) runHitHook(game, h, ctx);
  }
  // Kills by the weapon, its procs and its damage-over-time all count.
  if (died && game.weapon && opts.source !== 'ability' && opts.source !== 'ally') {
    for (const h of game.weapon.hooks.kill) runKillHook(game, h, { target: e, damage: dmg, x: e.x, y: e.y, chilled: wasChilled, depth });
  }
  return dmg;
}

export function healPlayer(game, amount) {
  const p = game.player;
  if (p.dead || amount <= 0) return;
  const before = p.hp;
  p.hp = Math.min(game.pstats.maxHp, p.hp + amount);
  const gained = Math.round(p.hp - before);
  if (gained >= 1) {
    p.healAcc = (p.healAcc ?? 0) + gained;
    if (p.healAcc >= 3 || gained >= 3) {
      game.fx.number(p.x, p.y - 1.2, p.healAcc, { heal: true });
      p.healAcc = 0;
    }
  }
}

/** Damage to the player from enemies/hazards. */
export function hurtPlayer(game, amount, { element = 'physical', fromX, fromY, selfInflicted = false } = {}) {
  const p = game.player;
  if (p.dead || (!selfInflicted && p.invuln > 0) || game.godMode) return 0;
  const s = game.pstats;
  let dmg = amount;
  if (!selfInflicted) {
    dmg *= 100 / (100 + s.defense * 4);
    dmg *= 1 - (s.resist[element] ?? 0) / 100;
    dmg *= s.damageTaken;
    // A sturdy hull takes part of the hit while you are at sea.
    if (game.sailing) dmg *= 1 - (game.boat?.armor ?? 0);
  }
  dmg = Math.max(1, Math.round(dmg));
  if (selfInflicted) dmg = Math.min(dmg, Math.max(0, Math.ceil(p.hp) - 1));
  if (dmg <= 0) return 0;
  p.hp -= dmg;
  if (!selfInflicted) {
    p.invuln = 0.45;
    p.hurtFlash = 0.15;
    game.shake = Math.max(game.shake, 0.25);
    game.audio.play('hurt', { throttle: 120 });
    game.vibrate(30);
    if (fromX !== undefined) {
      const n = normalize(p.x - fromX, p.y - fromY);
      p.kx += n.x * 5;
      p.ky += n.y * 5;
    }
    game.fx.number(p.x, p.y - 1.2, dmg, { color: '#ff5a5a' });
  }
  if (p.hp <= 0) game.onPlayerDeath();
  return dmg;
}

// --- Attacks -------------------------------------------------------------------

function hitMeleeTargets(game, targets, damage, attack, origin) {
  const w = game.weapon;
  for (const e of targets) {
    dealDamage(game, e, damage, {
      element: w.element, canCrit: true, depth: 0, source: 'weapon', melee: true,
      knockback: w.stats.knockback, fromX: origin.x, fromY: origin.y,
    });
  }
  return targets.length;
}

function meleeArc(game, x, y, angle, range, arcDeg, damage) {
  const half = (arcDeg * DEG) / 2;
  const targets = game.enemies.filter((e) => {
    if (e.dead) return false;
    const d = Math.sqrt(dist2(x, y, e.x, e.y));
    if (d > range + e.r) return false;
    if (d < e.r + 0.4) return true;
    return Math.abs(angleDiff(angle, angleTo(x, y, e.x, e.y))) <= half + Math.atan2(e.r, d);
  });
  game.hitNpcs?.({ kind: 'arc', x, y, angle, range, half }, damage);
  return hitMeleeTargets(game, targets, damage, null, { x, y });
}

function meleeLine(game, x, y, angle, range, width, damage) {
  const ex = x + Math.cos(angle) * range;
  const ey = y + Math.sin(angle) * range;
  const targets = game.enemies.filter((e) => {
    if (e.dead) return false;
    const rr = width / 2 + e.r;
    return segmentDist2(e.x, e.y, x, y, ex, ey) <= rr * rr;
  });
  game.hitNpcs?.({ kind: 'line', x, y, ex, ey, width }, damage);
  return hitMeleeTargets(game, targets, damage, null, { x, y });
}

/** Fires the weapon's projectile pattern. */
export function fireWeaponProjectiles(game, { x, y, angle, damage, echo = false }) {
  const w = game.weapon;
  const s = w.stats;
  const a = w.attack;
  const count = Math.max(1, s.projectiles);
  const spreadDeg = count > 1 ? Math.max(a.spread ?? 0, 8 * (count - 1)) : a.spread ?? 0;
  const perShot = a.pattern === 'volley' || a.pattern === 'cone' || a.pattern === 'wisp'
    ? damage
    : damage * (count > 1 ? 0.75 : 1);
  for (let i = 0; i < count; i++) {
    let off = 0;
    if (count > 1) off = (i / (count - 1) - 0.5) * spreadDeg * DEG;
    else if (spreadDeg) off = (Math.random() - 0.5) * spreadDeg * DEG;
    const dir = angle + off;
    const common = {
      x, y, angle: dir, speed: s.projectileSpeed, damage: perShot, range: s.range,
      element: w.element, sprite: a.projectile, size: a.size ?? 2, owner: 'player',
      pierce: s.pierce, homing: s.homing, split: s.split, bounces: w.bounces,
      knockback: s.knockback, source: 'weapon', depth: 0, echo,
      color: w.trail,
    };
    if (a.pattern === 'lob') {
      const target = nearestEnemy(game, x + Math.cos(angle) * s.range * 0.7, y + Math.sin(angle) * s.range * 0.7, s.range * 0.5);
      const dist = target ? Math.min(s.range, Math.sqrt(dist2(x, y, target.x, target.y))) : s.range * 0.8;
      spawnProjectile(game, { ...common, kind: 'lob', tx: x + Math.cos(dir) * dist, ty: y + Math.sin(dir) * dist, blast: a.blast ?? 1.5 });
    } else if (a.pattern === 'boomerang') {
      spawnProjectile(game, { ...common, kind: 'boomerang', pierce: 99 });
    } else {
      spawnProjectile(game, common);
    }
  }
}

/** Executes the archetype's base attack pattern. */
export function executePattern(game, { x, y, angle, damage, echo = false, dir = 1 }) {
  const w = game.weapon;
  const a = w.attack;
  const range = w.stats.range;
  const color = w.trail;
  const blade = w.dna.visual.palette.blade;
  switch (a.pattern) {
    case 'swing':
      meleeArc(game, x, y, angle, range, a.arc ?? 120, damage);
      game.fx.add({ type: 'slash', x, y, angle, dir, arc: (a.arc ?? 120) * DEG, r: range, color, core: blade[0], dur: 0.2, ghost: echo });
      break;
    case 'lash':
      meleeArc(game, x, y, angle, range, a.arc ?? 60, damage);
      game.fx.add({ type: 'whip', x, y, angle, dir, r: range, color: blade[1], tip: color, dur: 0.22, ghost: echo });
      break;
    case 'thrust':
      meleeLine(game, x, y, angle, range, a.width ?? 0.7, damage);
      game.fx.add({ type: 'thrust', x, y, angle, r: range, color, core: blade[0], dur: 0.16, ghost: echo });
      break;
    case 'slam': {
      const radius = a.radius ?? 1.6;
      const cx = x + Math.cos(angle) * range * 0.6;
      const cy = y + Math.sin(angle) * range * 0.6;
      const targets = enemiesInRadius(game, cx, cy, radius);
      hitMeleeTargets(game, targets, damage, null, { x: cx, y: cy });
      game.fx.add({ type: 'ring', x: cx, y: cy, r0: 0.3, r1: radius, color, dur: 0.3, fill: true });
      game.fx.add({ type: 'cracks', x: cx, y: cy, r: radius, color: '#161622', dur: 0.6, seed: Math.random() * 1000 });
      game.fx.emit('dust', cx, cy, 14, radius, 2.5);
      game.shake = Math.max(game.shake, 0.28);
      break;
    }
    default:
      fireWeaponProjectiles(game, { x, y, angle, damage, echo });
  }
}

/** Attempts a player attack in direction `angle`. Returns true if it fired. */
export function tryAttack(game, angle) {
  const p = game.player;
  const w = game.weapon;
  if (!w || p.attackCd > 0 || p.dead) return false;
  const aspd = w.stats.attackSpeed * game.pstats.attackSpeedMult;
  const pattern = w.attack.pattern;
  p.attackCd = 1 / aspd;
  p.facing = angle;
  // Swings alternate sides for a combo rhythm; the weapon rests where it ended.
  const dir = p.guard ?? 1;
  if (pattern === 'swing' || pattern === 'lash' || pattern === 'slam') p.guard = -dir;
  const dur = attackDuration(pattern, aspd);
  const anim = { t: 0, dur, angle, pattern, dir };
  p.attackAnim = anim;
  p.attackCount += 1;
  const count = p.attackCount;

  let mult = 1;
  for (const h of w.hooks.attack) if (h.do === 'sprintBonus' && p.sprinting) mult *= 1 + h.pct / 100;
  for (const h of w.hooks.attack) if (h.do === 'blink') phaseStrike(game, h, angle);
  const damage = weaponDamage(game) * mult;

  // Damage lands on the animation's impact frame, re-aimed at the target if
  // it moved during the wind-up.
  const strike = () => {
    if (game.weapon !== w || p.dead) return;
    let a = angle;
    if (game.target && !game.target.dead) a = Math.atan2(game.target.y - p.y, game.target.x - p.x);
    anim.angle = a;
    executePattern(game, { x: p.x, y: p.y, angle: a, damage, dir });
    for (const h of w.hooks.attack) runAttackHook(game, h, a, damage);
    for (const h of w.hooks.nth) if (count % h.n === 0) runAttackHook(game, h, a, damage);
    game.audio.weapon(w.dna.sound);
  };
  const delay = MELEE_PATTERNS.has(pattern) ? impactDelay(pattern, dur) : 0;
  if (delay > 0.01) game.schedule(delay, strike);
  else strike();
  return true;
}

function phaseStrike(game, h, angle) {
  const p = game.player;
  const target = nearestEnemy(game, p.x + Math.cos(angle) * 2, p.y + Math.sin(angle) * 2, h.range);
  if (!target) return;
  const d = Math.sqrt(dist2(p.x, p.y, target.x, target.y));
  const reach = game.weapon.stats.range * 0.6;
  if (d <= reach) return;
  const n = normalize(target.x - p.x, target.y - p.y);
  const tx = target.x - n.x * reach;
  const ty = target.y - n.y * reach;
  if (!game.world.isFree(tx, ty, p.r)) return;
  game.fx.emit('void', p.x, p.y, 8, 0.5);
  game.fx.add({ type: 'line', points: [[p.x, p.y], [tx, ty]], color: '#9a5cff', dur: 0.15 });
  p.x = tx;
  p.y = ty;
  p.invuln = Math.max(p.invuln, 0.2);
  game.fx.emit('void', tx, ty, 8, 0.5);
}

function chanceOk(h) {
  return h.chance == null || Math.random() * 100 < h.chance;
}

function runAttackHook(game, h, angle, damage) {
  if (!chanceOk(h)) return;
  const p = game.player;
  switch (h.do) {
    case 'projectile': {
      const count = h.count ?? 1;
      for (let i = 0; i < count; i++) {
        const off = count > 1 ? (i / (count - 1) - 0.5) * (h.spread ?? 30) * DEG : 0;
        spawnProjectile(game, {
          x: p.x, y: p.y, angle: angle + off, speed: h.speed, range: h.range, size: h.size ?? 2,
          damage: (damage * h.dmg) / 100, element: h.element ?? game.weapon.element, sprite: h.sprite,
          owner: 'player', pierce: h.pierce ?? 0, homing: h.homing ?? 0, knockback: h.knockback ?? 0,
          source: 'weapon', depth: 1, pool: h.pool,
        });
      }
      break;
    }
    case 'echo':
      game.schedule(h.delay ?? 0.25, () => {
        if (!game.weapon || p.dead) return;
        executePattern(game, { x: p.x, y: p.y, angle, damage: (damage * h.dmg) / 100, echo: true });
      });
      break;
    case 'nova': {
      const targets = enemiesInRadius(game, p.x, p.y, h.radius);
      for (const e of targets) {
        dealDamage(game, e, (damage * h.dmg) / 100, { element: h.element, depth: 1, source: 'weapon', status: h.status });
      }
      const color = game.data.byId.elements.get(h.element)?.glow ?? '#ffffff';
      game.fx.add({ type: 'ring', x: p.x, y: p.y, r0: 0.5, r1: h.radius, color, dur: 0.3 });
      game.fx.emit(game.data.byId.elements.get(h.element)?.particles ?? 'sparkle', p.x, p.y, 14, h.radius);
      break;
    }
    case 'spin': {
      const r = game.weapon.stats.range;
      for (const e of enemiesInRadius(game, p.x, p.y, r)) {
        dealDamage(game, e, (damage * h.dmg) / 100, {
          element: game.weapon.element, depth: 1, source: 'weapon', knockback: game.weapon.stats.knockback,
        });
      }
      game.fx.add({ type: 'slash', x: p.x, y: p.y, angle, arc: Math.PI * 2, r, color: game.weapon.trail, dur: 0.22 });
      break;
    }
    case 'spikes': {
      for (let i = 1; i <= h.count; i++) {
        game.schedule(i * 0.06, () => {
          const x = p.x + Math.cos(angle) * i * h.spacing * 1.2;
          const y = p.y + Math.sin(angle) * i * h.spacing * 1.2;
          game.fx.add({ type: 'spike', x, y, color: '#a8804a', dur: 0.35 });
          for (const e of enemiesInRadius(game, x, y, 0.6)) {
            dealDamage(game, e, (damage * h.dmg) / 100, { element: h.element, depth: 1, source: 'weapon' });
          }
        });
      }
      break;
    }
    case 'selfDamage':
      hurtPlayer(game, h.flat, { selfInflicted: true });
      break;
    default:
      break;
  }
}

function explosion(game, x, y, radius, damage, element, depth, exclude = null) {
  const color = game.data.byId.elements.get(element)?.glow ?? '#ffb040';
  game.fx.add({ type: 'ring', x, y, r0: 0.2, r1: radius, color, dur: 0.22, fill: true });
  game.fx.emit(element === 'physical' ? 'smoke' : game.data.byId.elements.get(element)?.particles ?? 'ember', x, y, 8, radius);
  game.audio.play('explode', { throttle: 80 });
  game.hitNpcs?.({ kind: 'circle', x, y, r: radius }, damage);
  for (const e of enemiesInRadius(game, x, y, radius)) {
    if (e === exclude) continue;
    dealDamage(game, e, damage, { element, depth, source: 'weapon' });
  }
}

function chain(game, from, targets, damage, radius, element, depth) {
  const hit = new Set([from]);
  let cur = from;
  const points = [[from.x, from.y]];
  for (let i = 0; i < targets; i++) {
    const next = nearestEnemy(game, cur.x, cur.y, radius, hit);
    if (!next) break;
    hit.add(next);
    points.push([next.x, next.y]);
    dealDamage(game, next, damage, { element, depth, source: 'weapon' });
    cur = next;
  }
  if (points.length > 1) {
    game.fx.add({ type: 'line', points, color: game.data.byId.elements.get(element)?.glow ?? '#fff27a', dur: 0.18, jagged: true });
    game.audio.play('zap', { throttle: 90 });
  }
}

function strike(game, x, y, h, damage) {
  const color = game.data.byId.elements.get(h.element)?.glow ?? '#ffffff';
  game.fx.add({ type: 'marker', x, y, r: h.radius, color, dur: h.delay ?? 0.2 });
  game.schedule(h.delay ?? 0.2, () => {
    game.fx.add({ type: h.sprite === 'bolt' ? 'bolt' : 'pillar', x, y, r: h.radius, color, dur: 0.25 });
    for (const e of enemiesInRadius(game, x, y, h.radius)) {
      dealDamage(game, e, damage, { element: h.element, depth: 1, source: 'weapon' });
    }
  });
}

function runHitHook(game, h, ctx) {
  if (ctx.depth > 0 && !PROC_SAFE.has(h.do)) return;
  if (!chanceOk(h)) return;
  const e = ctx.target;
  switch (h.do) {
    case 'elementDamage': {
      const extra = (ctx.damage * h.pct) / 100;
      dealDamage(game, e, extra, { element: h.element, depth: 1, source: 'weapon', quiet: extra < 2 });
      if (Math.random() < 0.15) {
        const st = statusForElement(game.data, h.element);
        if (st) applyStatus(game, e, st, ctx.damage);
      }
      break;
    }
    case 'heal':
      healPlayer(game, h.pct ? (ctx.damage * h.pct) / 100 : h.flat ?? 0);
      break;
    case 'chain':
      chain(game, e, h.targets, (ctx.damage * h.dmg) / 100, h.radius, h.element ?? 'lightning', 1);
      break;
    case 'explode':
      explosion(game, ctx.x, ctx.y, h.radius, (ctx.damage * h.dmg) / 100, h.element ?? (game.weapon.element === 'physical' ? 'fire' : game.weapon.element), 1, null);
      break;
    case 'status':
      applyStatus(game, e, h.status, ctx.damage);
      break;
    case 'execute':
      if (!e.boss && e.hp > 0 && (e.hp / e.maxHp) * 100 < h.threshold) {
        game.fx.add({ type: 'flash', x: e.x, y: e.y, r: 0.8, color: '#ff3450', dur: 0.2 });
        dealDamage(game, e, e.hp + 1, { depth: 1, source: 'weapon', color: '#ff3450' });
      }
      break;
    case 'portal':
      spawnArea(game, 'portal', { x: ctx.x, y: ctx.y, r: h.radius, dur: h.duration, pull: h.pull, dps: h.dps / 100 * weaponDamage(game), element: h.element ?? 'void' });
      break;
    case 'strike':
      strike(game, ctx.x, ctx.y, h, (ctx.damage * h.dmg) / 100);
      break;
    default:
      break;
  }
}

function runKillHook(game, h, ctx) {
  if (!chanceOk(h)) return;
  const wd = weaponDamage(game);
  switch (h.do) {
    case 'heal':
      healPlayer(game, h.flat ?? 0);
      break;
    case 'cloud':
      spawnArea(game, 'cloud', { x: ctx.x, y: ctx.y, r: h.radius, dur: h.duration, dps: (h.dps / 100) * wd, element: h.element });
      break;
    case 'portal':
      spawnArea(game, 'portal', { x: ctx.x, y: ctx.y, r: h.radius, dur: h.duration, pull: h.pull, dps: (h.dps / 100) * wd, element: h.element ?? 'void' });
      break;
    case 'shatter':
      if (!ctx.chilled) break;
      for (let i = 0; i < h.count; i++) {
        spawnProjectile(game, {
          x: ctx.x, y: ctx.y, angle: (i / h.count) * Math.PI * 2, speed: h.speed, range: h.range, size: 2,
          damage: (wd * h.dmg) / 100, element: h.element, sprite: 'shard', owner: 'player', source: 'weapon', depth: 2,
        });
      }
      game.fx.emit('frost', ctx.x, ctx.y, 10, 0.6, 3);
      break;
    case 'buff':
      game.addBuff(h.stat, h.value, h.duration);
      break;
    default:
      break;
  }
}

export { explosion, chain };
