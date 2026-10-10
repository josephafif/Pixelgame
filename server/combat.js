// Server combat: weapon attacks (melee shapes and projectiles) against
// monsters, other players (within the PvP rules) and raidable structures;
// damage, statuses, deaths. Hits are checked against where targets were on
// the attacker's screen (lag compensation, capped at 200 ms).

import { angleDiff, angleTo, segmentDist2 } from '../src/core/math.js';
import { attackDuration, impactDelay, MELEE_PATTERNS } from '../src/render/weapon-anim.js';
import { pvpBlock, inSafeZone } from '../src/net/rules.js';
import { TICK_DT, TICK_RATE } from '../src/net/movement.js';
import { T, CHUNK, REFLECTS, PLANTS } from '../src/game/world.js';
import { PLANT_AREAS, plantsHit, puffDps } from '../src/game/plants.js';
import * as players from './players.js';
import * as loot from './loot.js';
import * as building from './building.js';
import * as enemies from './enemies.js';
import * as abilities from './abilities.js';
import * as bosses from './bosses.js';
import * as markets from './markets.js';
import * as workers from './workers.js';
import * as horses from './horses.js';

const DEG = Math.PI / 180;
const BLOCKS_SHOTS = new Set([T.TREE, T.PINE, T.ROCK, T.CACTUS, T.CRYSTAL, T.PALM, T.OBSIDIAN, T.ORE, T.STARSTONE, T.PRISM]);
const MAX_REFLECTIONS = 4;
const PROJ_CAP = 1500;

function elementGlow(gs, element) {
  return gs.data.byId.elements.get(element)?.glow ?? '#ffffff';
}

// --- Damage ---------------------------------------------------------------------------

function critRoll(attacker) {
  if (!attacker?.stats) return false;
  return Math.random() * 100 < attacker.stats.critChance;
}

/** Damages a monster; returns the damage dealt. */
export function damageEnemy(gs, e, amount, opts = {}) {
  if (e.dead || e.submerged || amount <= 0) return 0;
  const attacker = opts.attacker ?? null;
  const element = opts.element ?? 'physical';
  let crit = false;
  if (opts.canCrit !== false && attacker?.stats) {
    // A marked monster takes a sure critical hit (and loses the mark).
    if (e.statuses.mark?.until > gs.time) {
      crit = true;
      delete e.statuses.mark;
    } else {
      crit = critRoll(attacker);
    }
  }
  let dmg = amount * (crit ? (attacker.stats.critDamage ?? 150) / 100 : 1);
  if (e.statuses.shock?.until > gs.time) dmg *= 1 + (gs.data.statuses.shock?.vulnerability ?? 0) / 100;
  if (element !== 'physical' && e.element && e.element !== 'physical') {
    if (e.element === element) dmg *= 0.6;
    else if (gs.data.byId.elements.get(e.element)?.opposes.includes(element)) dmg *= 1.5;
  }
  dmg = Math.max(1, Math.round(dmg));
  e.hp -= dmg;
  e.alertUntil = gs.time + 6;
  if (attacker) {
    e.damageBy.set(attacker.id, (e.damageBy.get(attacker.id) ?? 0) + dmg);
    e.lastHitBy = attacker.id;
    if (!e.boss) e.target = attacker.id;
  }
  if (opts.knockback && !e.boss) {
    const fx = opts.fromX ?? attacker?.x ?? e.x;
    const fy = opts.fromY ?? attacker?.y ?? e.y;
    const d = Math.sqrt((e.x - fx) ** 2 + (e.y - fy) ** 2) || 1;
    const k = opts.knockback * (e.elite ? 1.5 : 2.5);
    e.kx += ((e.x - fx) / d) * k;
    e.ky += ((e.y - fy) / d) * k;
  }
  gs.event(e.x, e.y, { k: 'dmg', id: e.id, n: dmg, c: crit, col: element !== 'physical' ? elementGlow(gs, element) : null, by: attacker?.id ?? 0 });
  if (opts.status) enemies.applyStatus(gs, e, opts.status, dmg, attacker);
  else if (opts.depth === 0 && element !== 'physical' && Math.random() < 0.2) {
    const st = gs.data.elements.find((x) => x.id === element)?.status;
    if (st) enemies.applyStatus(gs, e, st, dmg, attacker);
  }
  const died = e.hp <= 0;
  if (died) killEnemy(gs, e, attacker);
  if (attacker && opts.source === 'weapon' && attacker.weapon) {
    const ctx = { target: e, damage: dmg, crit, depth: opts.depth ?? 0, x: e.x, y: e.y };
    for (const h of attacker.weapon.hooks.hit) runHitHook(gs, attacker, h, ctx);
    if (crit && !ctx.depth) for (const h of attacker.weapon.hooks.crit) runHitHook(gs, attacker, h, ctx);
    if (died) for (const h of attacker.weapon.hooks.kill) if (h.do === 'heal' && chance(h)) heal(gs, attacker, h.flat ?? 0);
  }
  return dmg;
}

export function killEnemy(gs, e, killer) {
  if (e.dead) return;
  e.dead = true;
  // Crystal creatures burst into shards when they break (as in single player).
  const burst = e.def?.deathBurst;
  if (burst) {
    for (let i = 0; i < burst.count; i++) {
      const a = (i / burst.count) * Math.PI * 2 + Math.random() * 0.4;
      spawnProjectile(gs, {
        x: e.x, y: e.y, angle: a, speed: burst.speed ?? 6, range: 3.5, size: 1, damage: e.dmg * (burst.damage ?? 0.5),
        sprite: 'shard', enemy: e.id, color: burst.color ?? e.color,
      });
    }
  }
  gs.event(e.x, e.y, { k: 'kill', id: e.id, x: e.x, y: e.y, boss: e.boss, r: e.r });
  loot.onEnemyKilled(gs, e, killer);
}

export function heal(gs, p, amount) {
  if (!p || p.dead || amount <= 0) return;
  const before = p.hp;
  p.hp = Math.min(p.maxHp, p.hp + amount);
  const gained = p.hp - before;
  p.healAcc = (p.healAcc ?? 0) + gained;
  if (p.healAcc >= 3) {
    gs.event(p.x, p.y, { k: 'heal', id: p.id, n: Math.round(p.healAcc) }, 20);
    p.healAcc = 0;
  }
}

/**
 * Damage to a player (monsters, hazards, other players). attacker = the
 * player who did it (PvP), or null.
 */
export function hurtPlayer(gs, p, amount, { element = 'physical', fromX, fromY, attacker = null, dot = false, knock = 5 } = {}) {
  const now = Date.now();
  if (p.dead || amount <= 0) return 0;
  if (!dot && (p.protectUntil > now || p.invulnUntil > now)) return 0;
  let dmg = amount;
  if (!dot) {
    dmg *= 100 / (100 + p.stats.defense * 4);
    dmg *= 1 - (p.stats.resist[element] ?? 0) / 100;
    dmg *= p.stats.damageTaken;
  }
  if (attacker) dmg *= gs.rules.pvpDamage;
  // At sea a sturdy hull takes part of the blow.
  if (p.sailing && !dot) dmg *= 1 - (players.boatOf(gs, p)?.armor ?? 0);
  dmg = Math.max(1, Math.round(dmg));
  p.hp -= dmg;
  p.lastHurtAt = now;
  if (attacker) {
    p.combatUntil = now + 15000;
    attacker.combatUntil = now + 15000;
    p.lastAttacker = attacker.id;
    p.lastAttackerAt = now;
  }
  if (!dot && fromX !== undefined && knock) {
    const d = Math.sqrt((p.x - fromX) ** 2 + (p.y - fromY) ** 2) || 1;
    p.kx += ((p.x - fromX) / d) * knock;
    p.ky += ((p.y - fromY) / d) * knock;
  }
  gs.event(p.x, p.y, { k: 'hurt', id: p.id, n: dmg, by: attacker?.id ?? 0, dot });
  if (p.hp <= 0 && abilities.tryPhoenixRevive(gs, p, now)) return dmg;
  if (p.hp <= 0) killPlayer(gs, p, attacker ?? (p.lastAttackerAt > now - 10000 ? gs.players.get(p.lastAttacker) : null));
  return dmg;
}

export function killPlayer(gs, p, killer) {
  if (p.dead) return;
  const now = Date.now();
  horses.dismount(gs, p, now, { quiet: true }); // you fall off; the horse waits there
  p.dead = true;
  p.hp = 0;
  p.respawnAt = now + 5000;
  p.kx = p.ky = 0;
  p.ch.deaths += 1;
  p.statuses = {};
  if (!inSafeZone(gs.rules, p.x, p.y)) loot.dropDeathBag(gs, p, killer);
  if (killer && killer !== p) {
    killer.ch.pvpKills += 1;
    players.markMe(killer);
    gs.toast(killer, `Du besegrade ${p.name}!`, 'boss');
    gs.toast(p, `${killer.name} besegrade dig.`, 'warn');
  }
  gs.send(p, { t: 'died', by: killer && killer !== p ? killer.name : null, respawnIn: 5 });
  gs.event(p.x, p.y, { k: 'pdeath', id: p.id, x: p.x, y: p.y });
  if (p.asleep) p.respawnAt = now; // removed right away
  players.markMe(p);
}

/** Can `attacker` hurt player `victim` right now? */
export function canHurt(gs, attacker, victim, now = Date.now()) {
  return pvpBlock(gs.rules, attacker, victim, now) === null;
}

/** The attacker chose to fight another player: their own protections end. */
function enteredPvp(gs, p) {
  const now = Date.now();
  if (p.protectUntil > now) p.protectUntil = 0;
  if (p.newbie || !p.ch.pvpOptIn) {
    if (p.newbie) gs.toast(p, 'Du anföll en spelare: ditt nybörjarskydd är borta.', 'warn');
    p.ch.pvpOptIn = true;
    p.newbie = false;
    players.markMe(p);
  }
}

// --- Attacks ------------------------------------------------------------------------------

function chance(h) {
  return h.chance == null || Math.random() * 100 < h.chance;
}

/** Validates the client's locked target and returns where to aim, lag compensated. */
function aimAt(gs, p, aim, targetId, reach) {
  if (!targetId) return aim;
  const t = gs.enemies.get(targetId) ?? gs.players.get(targetId);
  if (!t || t.dead || t === p) return aim;
  const pos = gs.positionAt(t, p.lastView);
  const d = Math.sqrt((pos.x - p.x) ** 2 + (pos.y - p.y) ** 2);
  if (d > reach + 2) return aim;
  return Math.atan2(pos.y - p.y, pos.x - p.x);
}

export function weaponDamage(p) {
  return p.weapon.stats.damage * (1 + p.stats.attackPower / 100);
}

export function tryAttack(gs, p, aim, targetId, now) {
  const w = players.heldWeapon(p);
  if (!w || p.attackCd > 0 || p.dead) return false;
  const aspd = w.stats.attackSpeed * p.stats.attackSpeedMult;
  const pattern = w.attack.pattern;
  p.attackCd = 1 / aspd;
  const angle = aimAt(gs, p, aim, targetId, w.stats.range + 3.5);
  p.facing = angle;
  p.anim = (p.anim + 1) & 255;
  const dir = p.guard;
  if (pattern === 'swing' || pattern === 'lash' || pattern === 'slam') p.guard = -dir;
  let mult = 1;
  for (const h of w.hooks.attack) if (h.do === 'sprintBonus' && p.sprinting) mult *= 1 + h.pct / 100;
  const damage = weaponDamage(p) * mult;
  const dur = attackDuration(pattern, aspd);
  const delay = MELEE_PATTERNS.has(pattern) ? impactDelay(pattern, dur) : 0;
  const view = p.lastView + Math.round(delay * TICK_RATE);
  const strike = () => {
    if (p.dead || players.heldWeapon(p) !== w) return;
    executePattern(gs, p, w, { angle, damage, view });
    abilities.ascendStrike(gs, p, angle);
    for (const h of w.hooks.attack) runAttackHook(gs, p, w, h, angle, damage);
    for (const h of w.hooks.nth) if (p.anim % h.n === 0) runAttackHook(gs, p, w, h, angle, damage);
  };
  if (delay > 0.01) gs.schedule(delay, strike);
  else strike();
  return true;
}

function executePattern(gs, p, w, { angle, damage, view }) {
  const a = w.attack;
  const range = w.stats.range;
  const x = p.x;
  const y = p.y;
  switch (a.pattern) {
    case 'swing':
      meleeArc(gs, p, { x, y, angle, range, half: ((a.arc ?? 120) * DEG) / 2, damage, view, knockback: w.stats.knockback });
      break;
    case 'lash':
      meleeArc(gs, p, { x, y, angle, range, half: ((a.arc ?? 60) * DEG) / 2, damage, view, knockback: w.stats.knockback });
      break;
    case 'thrust':
      meleeLine(gs, p, { x, y, angle, range, width: a.width ?? 0.7, damage, view, knockback: w.stats.knockback });
      break;
    case 'slam': {
      const cx = x + Math.cos(angle) * range * 0.6;
      const cy = y + Math.sin(angle) * range * 0.6;
      meleeRadius(gs, p, { x: cx, y: cy, r: a.radius ?? 1.6, damage, view, knockback: w.stats.knockback });
      break;
    }
    default:
      fireWeapon(gs, p, w, { x, y, angle, damage });
  }
}

/** Everything a melee shape can hit, filtered by `inside(x, y, r)`. */
function meleeHits(gs, p, { x, y, reach, damage, view, knockback = 0, crit = true, tool = false }, inside) {
  const w = p.weapon;
  const element = tool ? 'physical' : w?.element ?? 'physical';
  for (const e of gs.enemiesNear(x, y, reach + 3)) {
    const pos = gs.positionAt(e, view ?? p.lastView);
    if (inside(pos.x, pos.y, e.r)) {
      damageEnemy(gs, e, damage, { attacker: p, element, canCrit: crit, depth: 0, source: tool ? 'tool' : 'weapon', knockback, fromX: x, fromY: y });
    }
  }
  const now = Date.now();
  for (const v of gs.playersNear(x, y, reach + 3)) {
    if (v === p || v.dead) continue;
    const pos = gs.positionAt(v, view ?? p.lastView);
    if (!inside(pos.x, pos.y, v.r)) continue;
    if (!canHurt(gs, p, v, now)) continue;
    enteredPvp(gs, p);
    const dmg = damage * (crit && critRoll(p) ? (p.stats.critDamage ?? 150) / 100 : 1);
    hurtPlayer(gs, v, dmg, { element, fromX: x, fromY: y, attacker: p, knock: 3 + knockback * 2 });
    if (!tool && w) for (const h of w.hooks.hit) if (h.do === 'heal' && chance(h)) heal(gs, p, h.pct ? (dmg * h.pct * gs.rules.pvpDamage) / 100 : h.flat ?? 0);
  }
  // People at markets (a careless swing: the market turns on you).
  if (!tool) markets.hitNpcs(gs, p, x, y, reach, damage, inside);
  // Workers out chopping (yours too: hit one and it turns on you).
  workers.hit(gs, p, x, y, reach, damage, inside);
  // Fen plants in the way of the blow burst.
  for (const pl of plantsHit(gs.world, x, y, reach, inside)) burstPlant(gs, pl.tx, pl.ty);
  // Walls, gates and turrets of other clans (only while their base can be raided).
  const r = Math.ceil(reach + 1);
  for (let ty = Math.floor(y) - r; ty <= Math.floor(y) + r; ty++) {
    for (let tx = Math.floor(x) - r; tx <= Math.floor(x) + r; tx++) {
      const st = gs.world.structureAt(tx, ty);
      if (!st || !inside(tx + 0.5, ty + 0.5, 0.5)) continue;
      if (building.canDamage(gs, p, st, now)) building.damageStructure(gs, st, damage * gs.rules.structureDamage, p);
    }
  }
}

export function meleeArc(gs, p, { x, y, angle, range, half, damage, view, knockback = 0, crit = true, tool = false }) {
  meleeHits(gs, p, { x, y, reach: range, damage, view, knockback, crit, tool }, (ex, ey, er) => {
    const d = Math.sqrt((ex - x) ** 2 + (ey - y) ** 2);
    if (d > range + er) return false;
    if (d < er + 0.4) return true;
    return Math.abs(angleDiff(angle, angleTo(x, y, ex, ey))) <= half + Math.atan2(er, d);
  });
}

function meleeLine(gs, p, { x, y, angle, range, width, damage, view, knockback }) {
  const ex = x + Math.cos(angle) * range;
  const ey = y + Math.sin(angle) * range;
  meleeHits(gs, p, { x, y, reach: range, damage, view, knockback }, (px, py, r) => {
    const rr = width / 2 + r;
    return segmentDist2(px, py, x, y, ex, ey) <= rr * rr;
  });
}

function meleeRadius(gs, p, { x, y, r, damage, view, knockback }) {
  meleeHits(gs, p, { x, y, reach: r, damage, view, knockback }, (px, py, er) => (px - x) ** 2 + (py - y) ** 2 <= (r + er) ** 2);
}

function fireWeapon(gs, p, w, { x, y, angle, damage }) {
  const s = w.stats;
  const a = w.attack;
  const count = Math.max(1, Math.min(7, s.projectiles));
  const spreadDeg = count > 1 ? Math.max(a.spread ?? 0, 8 * (count - 1)) : a.spread ?? 0;
  const perShot = a.pattern === 'volley' || a.pattern === 'cone' || a.pattern === 'wisp' ? damage : damage * (count > 1 ? 0.75 : 1);
  for (let i = 0; i < count; i++) {
    let off = 0;
    if (count > 1) off = (i / (count - 1) - 0.5) * spreadDeg * DEG;
    else if (spreadDeg) off = (Math.random() - 0.5) * spreadDeg * DEG;
    const dir = angle + off;
    spawnProjectile(gs, {
      x, y, angle: dir, speed: s.projectileSpeed || 10, damage: perShot, range: s.range, element: w.element,
      sprite: a.projectile, size: a.size ?? 2, owner: p.id, pierce: s.pierce ?? 0, knockback: s.knockback ?? 0,
      color: w.trail, kind: a.pattern === 'lob' ? 'lob' : a.pattern === 'boomerang' ? 'boomerang' : 'shot',
      blast: a.blast ?? 1.5, source: 'weapon', bounces: w.bounces ?? 0,
    });
  }
}

// --- Weapon hooks (the subset that runs in multiplayer) ------------------------------------

function runAttackHook(gs, p, w, h, angle, damage) {
  if (!chance(h)) return;
  switch (h.do) {
    case 'projectile': {
      const count = h.count ?? 1;
      for (let i = 0; i < count; i++) {
        const off = count > 1 ? (i / (count - 1) - 0.5) * (h.spread ?? 30) * DEG : 0;
        spawnProjectile(gs, {
          x: p.x, y: p.y, angle: angle + off, speed: h.speed ?? 10, range: h.range ?? 6, size: h.size ?? 2,
          damage: (damage * h.dmg) / 100, element: h.element ?? w.element, sprite: h.sprite, owner: p.id,
          pierce: h.pierce ?? 0, color: elementGlow(gs, h.element ?? w.element), kind: 'shot', source: 'proc',
        });
      }
      break;
    }
    case 'nova':
      meleeRadius(gs, p, { x: p.x, y: p.y, r: h.radius, damage: (damage * h.dmg) / 100, view: p.lastView, knockback: 0 });
      gs.event(p.x, p.y, { k: 'fx', fx: 'ring', x: p.x, y: p.y, r: h.radius, color: elementGlow(gs, h.element) });
      break;
    case 'spin':
      meleeRadius(gs, p, { x: p.x, y: p.y, r: w.stats.range, damage: (damage * h.dmg) / 100, view: p.lastView, knockback: w.stats.knockback });
      gs.event(p.x, p.y, { k: 'fx', fx: 'spin', x: p.x, y: p.y, r: w.stats.range, color: w.trail });
      break;
    case 'selfDamage':
      p.hp = Math.max(1, p.hp - (h.flat ?? 0));
      break;
    default:
      break;
  }
}

function runHitHook(gs, p, h, ctx) {
  if (ctx.depth > 0 && h.do !== 'heal' && h.do !== 'status') return;
  if (!chance(h)) return;
  const e = ctx.target;
  switch (h.do) {
    case 'elementDamage':
      damageEnemy(gs, e, (ctx.damage * h.pct) / 100, { attacker: p, element: h.element, canCrit: false, depth: 1, source: 'proc' });
      break;
    case 'heal':
      heal(gs, p, h.pct ? (ctx.damage * h.pct) / 100 : h.flat ?? 0);
      break;
    case 'status':
      enemies.applyStatus(gs, e, h.status, ctx.damage, p);
      break;
    case 'execute':
      if (!e.dead && !e.boss && (e.hp / e.maxHp) * 100 < h.threshold) damageEnemy(gs, e, e.hp + 1, { attacker: p, canCrit: false, depth: 1, source: 'proc' });
      break;
    case 'chain': {
      let cur = e;
      const hit = new Set([e]);
      const points = [[e.x, e.y]];
      for (let i = 0; i < (h.targets ?? 2); i++) {
        let next = null;
        let best = (h.radius ?? 4) ** 2;
        for (const o of gs.enemiesNear(cur.x, cur.y, h.radius ?? 4)) {
          if (hit.has(o)) continue;
          const d = (o.x - cur.x) ** 2 + (o.y - cur.y) ** 2;
          if (d < best) {
            best = d;
            next = o;
          }
        }
        if (!next) break;
        hit.add(next);
        points.push([next.x, next.y]);
        damageEnemy(gs, next, (ctx.damage * h.dmg) / 100, { attacker: p, element: h.element ?? 'lightning', canCrit: false, depth: 1, source: 'proc' });
        cur = next;
      }
      if (points.length > 1) gs.event(e.x, e.y, { k: 'fx', fx: 'chain', points, color: elementGlow(gs, h.element ?? 'lightning') });
      break;
    }
    case 'explode':
      for (const o of gs.enemiesNear(ctx.x, ctx.y, h.radius)) {
        if (o !== e) damageEnemy(gs, o, (ctx.damage * h.dmg) / 100, { attacker: p, element: h.element ?? 'fire', canCrit: false, depth: 1, source: 'proc' });
      }
      gs.event(ctx.x, ctx.y, { k: 'fx', fx: 'boom', x: ctx.x, y: ctx.y, r: h.radius, color: elementGlow(gs, h.element ?? 'fire') });
      break;
    default:
      break;
  }
}

// --- Projectiles -----------------------------------------------------------------------------

/**
 * o: { x, y, angle, speed, damage, range, element, sprite, size, owner
 *      (player id) | enemy (enemy id), color, kind, pierce, blast, status }
 */
export function spawnProjectile(gs, o) {
  if (gs.projectiles.size >= PROJ_CAP) return null;
  const pr = {
    id: gs.newId(),
    x: o.x,
    y: o.y,
    vx: Math.cos(o.angle) * o.speed,
    vy: Math.sin(o.angle) * o.speed,
    speed: o.speed,
    range: o.range ?? 6,
    traveled: 0,
    damage: o.damage,
    element: o.element ?? 'physical',
    sprite: o.sprite ?? 'orb',
    size: o.size ?? 2,
    color: o.color ?? '#ffffff',
    owner: o.owner ?? 0,
    enemy: o.enemy ?? 0,
    turret: o.turret ?? 0,
    market: o.market ?? null, // a market turret's shot
    clanId: o.clanId ?? null, // a turret's clan: its shots fly over the clan's own walls
    kind: o.kind ?? 'shot',
    pierce: o.pierce ?? 0,
    bounces: o.bounces ?? 0, // on to the next monster after a hit (Ricochet, Prism Split)
    reflections: 0, // times a mirror crystal sent it off at an angle
    turned: false, // a monster's shot turned by a mirror: now it hits monsters
    blast: o.blast ?? 1.5,
    status: o.status ?? null,
    knockback: o.knockback ?? 0,
    source: o.source ?? 'weapon',
    homing: o.homing ?? 0,
    slow: 1, // a monster shot inside a Time Warp
    hit: new Set(),
    t0: gs.tick,
    x0: o.x,
    y0: o.y,
    returning: false,
  };
  if (pr.kind === 'lob') {
    pr.tx = o.x + Math.cos(o.angle) * pr.range * 0.8;
    pr.ty = o.y + Math.sin(o.angle) * pr.range * 0.8;
  }
  gs.projectiles.set(pr.id, pr);
  return pr;
}

/** Homing shots (Thousand Blades) turn towards the nearest monster they haven't hit. */
function steerHoming(gs, pr, dt) {
  let best = null;
  let bestD = 36;
  for (const e of gs.enemiesNear(pr.x, pr.y, 6)) {
    if (e.dead || e.submerged || pr.hit.has(e.id)) continue;
    const d = (e.x - pr.x) ** 2 + (e.y - pr.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (!best) return;
  const cur = Math.atan2(pr.vy, pr.vx);
  const want = Math.atan2(best.y - pr.y, best.x - pr.x);
  const turn = (5 + pr.homing * 2) * dt;
  const a = cur + Math.max(-turn, Math.min(turn, angleDiff(cur, want)));
  pr.vx = Math.cos(a) * pr.speed;
  pr.vy = Math.sin(a) * pr.speed;
  // Clients draw shots on straight lines: a new line every other tick.
  if (gs.tick % 2 === 0) rebase(gs, pr);
}

/** A monster shot entering or leaving a Time Warp changes speed (and the clients' line). */
function slowInWarp(gs, pr) {
  const slow = gs.areas.size ? abilities.shotSlowAt(gs, pr.x, pr.y) : 1;
  if (slow === pr.slow) return;
  pr.vx *= slow / pr.slow;
  pr.vy *= slow / pr.slow;
  pr.slow = slow;
  rebase(gs, pr);
}

function rebase(gs, pr) {
  pr.t0 = gs.tick;
  pr.x0 = pr.x;
  pr.y0 = pr.y;
}

/** Bounces a shot off the crystal it flew into; a monster's shot turns on monsters. */
function reflect(gs, pr, dt) {
  const px = pr.x - pr.vx * dt;
  const py = pr.y - pr.vy * dt;
  const sideX = Math.floor(px) !== Math.floor(pr.x);
  const sideY = Math.floor(py) !== Math.floor(pr.y);
  if (sideX || !sideY) pr.vx = -pr.vx;
  if (sideY || !sideX) pr.vy = -pr.vy;
  pr.x = px;
  pr.y = py;
  pr.reflections += 1;
  pr.damage *= 1.15;
  pr.traveled = Math.max(0, pr.traveled - 2);
  pr.hit.clear();
  if (pr.enemy) {
    pr.enemy = 0;
    pr.turned = true;
  }
  rebase(gs, pr);
  gs.event(pr.x, pr.y, { k: 'fx', fx: 'glint', x: pr.x, y: pr.y }, 20);
}

/** After a hit: off to the nearest monster it hasn't hit yet (Ricochet, Prism Split). */
function bounceOn(gs, pr) {
  let best = null;
  let bestD = 25;
  for (const e of gs.enemiesNear(pr.x, pr.y, 5)) {
    if (e.dead || e.submerged || pr.hit.has(e.id)) continue;
    const d = (e.x - pr.x) ** 2 + (e.y - pr.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (!best) return false;
  const d = Math.sqrt(bestD) || 1;
  pr.vx = ((best.x - pr.x) / d) * pr.speed;
  pr.vy = ((best.y - pr.y) / d) * pr.speed;
  pr.traveled = Math.max(0, pr.traveled - 3);
  pr.bounces -= 1;
  rebase(gs, pr);
  return true;
}

/**
 * Shots from a clan's players and turrets fly over the clan's own walls and
 * turrets (as in single player); everyone else's shots hit them.
 */
function ownStructure(gs, pr, st) {
  if (pr.market) return st.marketId === pr.market;
  if (!st.clanId) return false;
  const clanId = pr.turret ? pr.clanId : pr.owner ? gs.players.get(pr.owner)?.clanId : null;
  return clanId === st.clanId;
}

/** A fen plant bursts: a healing glow or a poison cloud (as in single player). It grows back. */
export function burstPlant(gs, tx, ty) {
  const spec = PLANT_AREAS[gs.world.blockAt(tx, ty)];
  if (!spec || !gs.removeBlock(tx, ty)) return;
  const x = tx + 0.5;
  const y = ty + 0.5;
  spawnArea(gs, {
    kind: spec.kind, x, y, r: spec.r, dur: spec.dur, healPct: spec.healPct ?? 0, dps: puffDps(gs.world.worldLevel(x, y)),
    color: spec.color, element: 'poison',
  });
  gs.event(x, y, { k: 'fx', fx: spec.kind === 'mend' ? 'bloom' : 'puff', x, y }, 24);
}

function shotBlocked(gs, x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const b = gs.world.blockAt(tx, ty);
  // A shot through a fen plant bursts it (and flies on).
  if (PLANTS.has(b)) {
    burstPlant(gs, tx, ty);
    return null;
  }
  if (b && REFLECTS.has(b) && gs.world.propAt(x, y)) return { tx, ty, st: null, mirror: true };
  if (b && BLOCKS_SHOTS.has(b) && gs.world.propAt(x, y)) return { tx, ty, st: null };
  const st = gs.world.structureAt(tx, ty);
  if (st && !st.def.walkable) return { tx, ty, st };
  return null;
}

export function updateProjectiles(gs, dt, now) {
  for (const pr of gs.projectiles.values()) {
    const steps = Math.max(1, Math.ceil((pr.speed * dt) / 0.25));
    let alive = true;
    for (let s = 0; s < steps && alive; s++) {
      const sdt = dt / steps;
      if (pr.kind === 'boomerang' && pr.returning) {
        const owner = gs.players.get(pr.owner);
        if (!owner || owner.dead) {
          alive = false;
          break;
        }
        const d = Math.sqrt((owner.x - pr.x) ** 2 + (owner.y - pr.y) ** 2);
        if (d < 0.5) {
          alive = false;
          break;
        }
        pr.vx = ((owner.x - pr.x) / d) * pr.speed;
        pr.vy = ((owner.y - pr.y) / d) * pr.speed;
        if (gs.tick % 3 === 0) rebase(gs, pr);
      }
      if (pr.homing && pr.owner && s === 0) steerHoming(gs, pr, dt);
      if (pr.enemy && s === 0) slowInWarp(gs, pr);
      pr.x += pr.vx * sdt;
      pr.y += pr.vy * sdt;
      pr.traveled += Math.hypot(pr.vx, pr.vy) * sdt;
      if (pr.kind === 'lob') {
        if (pr.traveled >= Math.sqrt((pr.tx - pr.x0) ** 2 + (pr.ty - pr.y0) ** 2)) {
          explodeAt(gs, pr, pr.x, pr.y);
          alive = false;
        }
        continue;
      }
      if (pr.traveled >= pr.range) {
        if (pr.kind === 'boomerang' && !pr.returning) {
          pr.returning = true;
          pr.hit.clear();
          rebase(gs, pr);
        } else {
          alive = false;
        }
        continue;
      }
      if (pr.kind !== 'boomerang') {
        const block = shotBlocked(gs, pr.x, pr.y);
        // Mirror crystals send shots off at an angle (as in single player).
        if (block?.mirror && pr.reflections < MAX_REFLECTIONS) {
          reflect(gs, pr, sdt);
          continue;
        }
        if (block && !(block.st && ownStructure(gs, pr, block.st))) {
          if (block.st && pr.owner) {
            const shooter = gs.players.get(pr.owner);
            if (shooter && building.canDamage(gs, shooter, block.st, now)) {
              building.damageStructure(gs, block.st, pr.damage * gs.rules.structureDamage, shooter);
            }
          } else if (block.st && pr.enemy) {
            building.damageStructure(gs, block.st, pr.damage * 0.5, null);
          }
          alive = false;
          continue;
        }
      }
      alive = projectileHits(gs, pr, now);
    }
    if (!alive) gs.projectiles.delete(pr.id);
  }
}

/** Checks what the projectile touches; returns false when it is used up. */
function projectileHits(gs, pr, now) {
  const rad = 0.18 + pr.size * 0.04;
  if (pr.enemy || pr.turret || pr.market) {
    // Monster shots (and turrets defending against raiders, or an angry market) hit players.
    for (const p of gs.playersNear(pr.x, pr.y, 1.6)) {
      if (p.dead || pr.hit.has(p.id)) continue;
      if ((p.x - pr.x) ** 2 + (p.y - pr.y) ** 2 > (rad + p.r) ** 2) continue;
      if (pr.market && !markets.isHostile(p, pr.market, now)) continue;
      if (pr.turret) {
        const st = gs.structures.get(pr.turret);
        if (!st || !building.turretMayHit(gs, st, p, now)) continue;
      }
      // A turret shooting an intruder hits like a player would (PvP damage).
      const dmg = pr.turret ? pr.damage * gs.rules.pvpDamage : pr.damage;
      hurtPlayer(gs, p, dmg, { element: pr.element, fromX: pr.x - pr.vx * 0.05, fromY: pr.y - pr.vy * 0.05, knock: 3 });
      if (pr.status && p.statuses) players.applyPlayerStatus(gs, p, pr.status, pr.damage * 0.15);
      return false;
    }
    if (pr.enemy) return true;
  }
  if (pr.owner || pr.turret || pr.market || pr.turned) {
    for (const e of gs.enemiesNear(pr.x, pr.y, 3)) {
      if (pr.hit.has(e.id)) continue;
      if ((e.x - pr.x) ** 2 + (e.y - pr.y) ** 2 > (rad + e.r) ** 2) continue;
      // A Mirror Knight's shield sends some shots straight back.
      if (e.def?.reflect && pr.owner && pr.kind === 'shot' && pr.source !== 'reflect' && Math.random() < e.def.reflect) {
        pr.vx = -pr.vx;
        pr.vy = -pr.vy;
        pr.enemy = e.id;
        pr.owner = 0;
        pr.source = 'reflect';
        pr.damage *= 0.6;
        pr.traveled = Math.max(0, pr.traveled - 3);
        pr.hit.clear();
        rebase(gs, pr);
        gs.event(e.x, e.y, { k: 'fx', fx: 'text', x: e.x, y: e.y - 1, text: 'REFLEKTERAD', color: '#e8fbff' }, 24);
        return true;
      }
      pr.hit.add(e.id);
      const shooter = gs.players.get(pr.owner) ?? null;
      damageEnemy(gs, e, pr.damage, {
        attacker: shooter, element: pr.element, canCrit: Boolean(shooter), depth: pr.source === 'weapon' ? 0 : 1,
        source: pr.turret ? 'turret' : pr.source, knockback: pr.knockback, fromX: pr.x - pr.vx, fromY: pr.y - pr.vy, status: pr.status,
      });
      if (pr.bounces > 0 && pr.kind === 'shot' && bounceOn(gs, pr)) return true;
      if (pr.kind !== 'boomerang' && pr.hit.size > pr.pierce) return false;
    }
  }
  if (pr.owner && pr.source !== 'ability') {
    const shooter = gs.players.get(pr.owner);
    if (!shooter) return true;
    if (gs.markets.size && markets.hitNpcs(gs, shooter, pr.x, pr.y, 1, pr.damage, (x, y, r) => (x - pr.x) ** 2 + (y - pr.y) ** 2 <= (rad + r) ** 2)) return false;
    if (gs.workers?.size && workers.hit(gs, shooter, pr.x, pr.y, 1, pr.damage, (x, y, r) => (x - pr.x) ** 2 + (y - pr.y) ** 2 <= (rad + r) ** 2)) return false;
    for (const v of gs.playersNear(pr.x, pr.y, 1.6)) {
      if (v === shooter || v.dead || pr.hit.has(v.id)) continue;
      if ((v.x - pr.x) ** 2 + (v.y - pr.y) ** 2 > (rad + v.r) ** 2) continue;
      if (!canHurt(gs, shooter, v, now)) continue;
      pr.hit.add(v.id);
      enteredPvp(gs, shooter);
      const crit = critRoll(shooter);
      hurtPlayer(gs, v, pr.damage * (crit ? shooter.stats.critDamage / 100 : 1), { element: pr.element, fromX: pr.x - pr.vx, fromY: pr.y - pr.vy, attacker: shooter, knock: 2 + pr.knockback });
      if (pr.kind !== 'boomerang' && pr.hit.size > pr.pierce) return false;
    }
  }
  return true;
}

function explodeAt(gs, pr, x, y) {
  const shooter = gs.players.get(pr.owner) ?? null;
  const r = pr.blast;
  for (const e of gs.enemiesNear(x, y, r + 1)) {
    if ((e.x - x) ** 2 + (e.y - y) ** 2 <= (r + e.r) ** 2) {
      damageEnemy(gs, e, pr.damage, { attacker: shooter, element: pr.element, canCrit: Boolean(shooter), depth: 0, source: pr.source });
    }
  }
  const now = Date.now();
  for (const v of gs.playersNear(x, y, r + 1)) {
    if (v.dead) continue;
    if (pr.enemy) {
      hurtPlayer(gs, v, pr.damage, { element: pr.element, fromX: x, fromY: y });
    } else if (shooter && v !== shooter && canHurt(gs, shooter, v, now)) {
      enteredPvp(gs, shooter);
      hurtPlayer(gs, v, pr.damage, { element: pr.element, fromX: x, fromY: y, attacker: shooter });
    }
  }
  gs.event(x, y, { k: 'fx', fx: 'boom', x, y, r, color: pr.color });
}

// --- Areas (boss telegraphs, burning ground) ------------------------------------------------

/** o: { x, y, r, kind: 'telegraph'|'hazard', dur, color, damage, element, enemy } */
export function spawnArea(gs, o) {
  const a = { id: gs.newId(), t0: gs.tick, t: 0, ...o };
  gs.areas.set(a.id, a);
  return a;
}

export function updateAreas(gs, dt) {
  for (const a of gs.areas.values()) {
    a.t += dt;
    if (a.ability) {
      abilities.updateArea(gs, a, dt);
      if (a.t >= a.dur) gs.areas.delete(a.id);
      continue;
    }
    if (a.kind === 'orbit' || a.kind === 'gravity') {
      bosses.updateArea(gs, a, dt);
      if (a.t >= a.dur) gs.areas.delete(a.id);
      continue;
    }
    if (a.kind === 'hazard') {
      a.tickT = (a.tickT ?? 0) - dt;
      if (a.tickT <= 0) {
        a.tickT = 0.5;
        for (const p of gs.playersNear(a.x, a.y, a.r)) if (!p.dead) hurtPlayer(gs, p, a.damage * 0.5, { element: a.element, dot: true });
      }
    }
    if (a.kind === 'mend' || a.kind === 'puff') {
      // A fen plant's glow heals the players in it; its spore cloud poisons
      // monsters (and players, half as hard).
      a.tickT = (a.tickT ?? 0) - dt;
      if (a.tickT <= 0) {
        a.tickT = 0.5;
        for (const p of gs.playersNear(a.x, a.y, a.r + 0.4)) {
          if (p.dead || (p.x - a.x) ** 2 + (p.y - a.y) ** 2 > (a.r + p.r) ** 2) continue;
          if (a.kind === 'mend') heal(gs, p, (p.maxHp * a.healPct * 0.5) / 100);
          else {
            hurtPlayer(gs, p, a.dps * 0.25, { element: 'poison', dot: true });
            players.applyPlayerStatus(gs, p, 'poison', a.dps * 0.15);
          }
        }
        if (a.kind === 'puff' && !a.fromBoss) {
          for (const e of gs.enemiesNear(a.x, a.y, a.r + 1)) {
            if (e.dead || (e.x - a.x) ** 2 + (e.y - a.y) ** 2 > (a.r + e.r) ** 2) continue;
            damageEnemy(gs, e, a.dps * 0.5, { element: 'poison', canCrit: false, depth: 2, source: 'plant' });
          }
        }
      }
    }
    if (a.t >= a.dur) {
      gs.areas.delete(a.id);
      if (a.kind === 'telegraph') {
        if (a.damage > 0) for (const p of gs.playersNear(a.x, a.y, a.r + 0.3)) hurtPlayer(gs, p, a.damage, { element: a.element, fromX: a.x, fromY: a.y });
        // (Boss attacks with their own look show it themselves.)
        if (!a.quiet) gs.event(a.x, a.y, { k: 'fx', fx: 'boom', x: a.x, y: a.y, r: a.r, color: a.color });
        a.after?.();
      }
    }
  }
}

// --- Bosses --------------------------------------------------------------------------------------

export function summonBoss(gs, p, altar, now) {
  if (gs.altarSpent(altar.key)) {
    gs.toast(p, 'Altaret är tyst: dess väktare är borta. Leta upp ett annat altare.', 'warn');
    return;
  }
  for (const e of gs.enemies.values()) {
    if (e.boss && e.altarKey === altar.key && !e.dead) {
      gs.toast(p, 'Väktaren är redan vaken!', 'warn');
      return;
    }
  }
  const boss = enemies.spawnBoss(gs, altar.bossId, altar.x, altar.y - 3.5, altar.key);
  if (!boss) return;
  const def = boss.def;
  gs.event(altar.x, altar.y, { k: 'boss', id: boss.id, name: def.name, active: true }, 60);
  for (const o of gs.playersNear(altar.x, altar.y, 40)) gs.toast(o, `${def.name} vaknar!`, 'boss');
  if (def.tip) gs.toast(p, def.tip);
  void now;
}

export const _test = { shotBlocked, CHUNK };
