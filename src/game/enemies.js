// Enemies: spawning around the player, simple readable AI per behaviour,
// elemental variants per biome, elites, and multi-phase bosses.

import { dist2, normalize, angleTo } from '../core/math.js';
import { tickStatuses } from './status.js';
import { enemySprites, bossSprites } from '../render/sprites.js';

let nextId = 1;
const DESPAWN_DIST = 34;
// Enemies give up the chase once you are this many times their sight away.
const LEASH = 1.8;
const PACK_RADIUS = 4;

/** Collision mode: bats and wisps fly over trees and rocks, never over water. */
function moveMode(e) {
  return e.kind === 'bat' || e.kind === 'wisp' ? 'fly' : 'enemy';
}

/** No spawning inside the camp's build area (plus a margin). */
function safeRadius(game) {
  return (game.buildRadius?.() ?? 12) + 4;
}

function scaleFor(level) {
  return { hp: 1 + 0.3 * (level - 1), dmg: 1 + 0.14 * (level - 1) };
}

export function spawnEnemy(game, defId, x, y, { level = 1, element = null, elite = false, biome = null } = {}) {
  const def = game.data.byId.enemies.get(defId);
  if (!def) return null;
  let el = element;
  if (!el && biome) {
    const nonPhysical = biome.elements.filter((e) => e !== 'physical');
    if ((def.elemental || Math.random() < 0.3) && nonPhysical.length) el = nonPhysical[(Math.random() * nonPhysical.length) | 0];
  }
  el ??= 'physical';
  const elDef = game.data.byId.elements.get(el);
  const color = el !== 'physical' && elDef?.palette ? elDef.palette[1] : def.color;
  const s = scaleFor(level);
  const hp = Math.round(def.hp * s.hp * (elite ? 2.4 : 1));
  const e = {
    id: nextId++,
    kind: def.id,
    def,
    x,
    y,
    vx: 0,
    vy: 0,
    kx: 0,
    ky: 0,
    r: def.size * 0.45 * (elite ? 1.3 : 1),
    hp,
    maxHp: hp,
    dmg: def.damage * s.dmg * (elite ? 1.4 : 1),
    speed: def.speed,
    level,
    element: el,
    elite,
    xp: Math.round(def.xp * (1 + 0.25 * (level - 1)) * (elite ? 3 : 1)),
    status: {},
    flash: 0,
    atkCd: 0.5 + Math.random(),
    state: 'move',
    stateT: 0,
    facing: 1,
    phase: Math.random() * 10,
    sprites: enemySprites(def.id, color),
    color,
    boss: false,
    dead: false,
    slowMult: 1,
    scale: elite ? 1.3 : 1,
    // Perception: idle enemies wander around home until they see you.
    alert: false,
    homeX: x,
    homeY: y,
    wanderX: x,
    wanderY: y,
    wanderT: Math.random() * 2,
  };
  game.enemies.push(e);
  return e;
}

export function spawnBoss(game, bossId, x, y) {
  const def = game.data.byId.bosses.get(bossId);
  const level = Math.max(game.save.player.level, game.world.worldLevel(x, y) + 1);
  const s = scaleFor(level);
  const hp = Math.round(def.hp * (1 + 0.22 * (level - 1)));
  const boss = {
    id: nextId++,
    kind: def.id,
    def,
    bossDef: def,
    x,
    y,
    vx: 0,
    vy: 0,
    kx: 0,
    ky: 0,
    r: def.size * 0.5,
    hp,
    maxHp: hp,
    dmg: def.damage * s.dmg,
    speed: def.speed,
    level,
    element: def.element,
    elite: false,
    xp: Math.round(def.xp * (1 + 0.2 * (level - 1))),
    status: {},
    flash: 0,
    atkCd: 1,
    state: 'move',
    stateT: 0,
    facing: 1,
    phase: 1,
    patternIdx: 0,
    patternCd: 2,
    sprites: bossSprites(def.id, def.color),
    color: def.color,
    boss: true,
    dead: false,
    slowMult: 1,
    scale: 1,
    anchorX: x,
    anchorY: y,
  };
  game.enemies.push(boss);
  return boss;
}

function moveEnemy(game, e, dx, dy, dt) {
  const nx = e.x + dx * dt;
  const ny = e.y + dy * dt;
  if (e.boss) {
    e.x = nx;
    e.y = ny;
    return;
  }
  const r = Math.min(e.r, 0.45);
  const mode = moveMode(e);
  const world = game.world;
  // Pushed into water or a wall somehow: step out to the nearest open spot.
  if (!world.isFree(e.x, e.y, r, mode)) {
    const spot = world.findFreeSpot(e.x, e.y, r, mode, null);
    if (spot) {
      e.x = spot.x;
      e.y = spot.y;
    } else {
      e.dead = true;
      e.vanished = true;
    }
    return;
  }
  if (world.isFree(nx, e.y, r, mode)) e.x = nx;
  if (world.isFree(e.x, ny, r, mode)) e.y = ny;
}

/**
 * Steering around obstacles: if the straight line is blocked, try turning
 * a bit left or right (sticking to one side for a moment so enemies walk
 * around a lake instead of jittering at its shore).
 */
function steer(game, e, nx, ny) {
  const world = game.world;
  const r = Math.min(e.r, 0.45);
  const mode = moveMode(e);
  const probe = 0.55;
  const clear = (ax, ay) => world.isFree(e.x + ax * probe, e.y + ay * probe, r, mode);
  if (clear(nx, ny)) {
    e.detour = 0;
    return { x: nx, y: ny, blocked: null };
  }
  const side = e.detour || (Math.random() < 0.5 ? 1 : -1);
  for (const turn of [0.6, 1.1, 1.6, 2.2]) {
    for (const sgn of [side, -side]) {
      const a = Math.atan2(ny, nx) + turn * sgn;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      if (clear(cx, cy)) {
        e.detour = sgn;
        return { x: cx, y: cy, blocked: null };
      }
    }
  }
  // Boxed in: report the structure in the way (if any) so it can be attacked.
  const tx = Math.floor(e.x + nx * (r + 0.4));
  const ty = Math.floor(e.y + ny * (r + 0.4));
  return { x: 0, y: 0, blocked: world.structureAt(tx, ty) };
}

/** Updates alert state: see the player, lose them, alert the pack. */
function perceive(game, e, d) {
  const p = game.player;
  const sight = e.def.sight ?? 7;
  const provoked = (e.alertUntil ?? 0) > game.time;
  if (p.dead) {
    e.alert = false;
    return;
  }
  if (e.alert) {
    if (d > sight * LEASH && !provoked) {
      e.alert = false;
      e.homeX = e.x;
      e.homeY = e.y;
      e.wanderX = e.x;
      e.wanderY = e.y;
      game.fx.text(e.x, e.y - e.r - 0.6, '?', '#c8c8d8');
    }
    return;
  }
  if (d < sight || (provoked && d < sight * LEASH * 1.5)) {
    e.alert = true;
    e.siege = null;
    game.fx.text(e.x, e.y - e.r - 0.6, '!', '#ffd24a');
    // Friends nearby notice too.
    for (const o of game.enemies) {
      if (o === e || o.dead || o.alert || o.boss) continue;
      if ((o.x - e.x) ** 2 + (o.y - e.y) ** 2 < PACK_RADIUS * PACK_RADIUS) o.alert = true;
    }
  }
}

/** Idle: amble around home, pausing now and then. */
function wander(game, e, dt) {
  e.wanderT -= dt;
  if (e.wanderT <= 0) {
    e.wanderT = 1.5 + Math.random() * 2.5;
    const a = Math.random() * Math.PI * 2;
    const dist = Math.random() < 0.3 ? 0 : 1 + Math.random() * 3;
    e.wanderX = e.homeX + Math.cos(a) * dist;
    e.wanderY = e.homeY + Math.sin(a) * dist;
  }
  const dx = e.wanderX - e.x;
  const dy = e.wanderY - e.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.2) return { x: 0, y: 0 };
  const s = steer(game, e, dx / d, dy / d);
  const speed = e.speed * e.slowMult * 0.4;
  return { x: s.x * speed, y: s.y * speed };
}

/** Hits a structure that stands in the way (walls, gates, turrets). */
function attackStructure(game, e, st) {
  if (!st || e.atkCd > 0) return;
  e.atkCd = 1.1;
  game.damageStructure?.(st, e.dmg);
}

function enemyShoot(game, e, angle, { speed, damage, size = 2, sprite = 'orb' }) {
  game.spawnProjectile({
    x: e.x, y: e.y, angle, speed, damage, range: 12, size, sprite, owner: 'enemy',
    element: e.element, color: game.data.byId.elements.get(e.element)?.glow ?? '#ff5050', depth: 0,
    status: e.element === 'ice' ? 'chill' : e.element === 'fire' ? 'burn' : e.element === 'poison' ? 'poison' : null,
  });
}

function updateBehaviour(game, e, dt) {
  const p = game.player;
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  const n = { x: dx / d, y: dy / d };
  const speed = e.speed * e.slowMult;
  let vx = 0;
  let vy = 0;
  e.stateT += dt;
  e.atkCd -= dt;
  perceive(game, e, d);
  if (!e.alert && e.state !== 'charge') {
    // Idle, or besieging the turret that shot it.
    const st = e.siege && !e.siege.dead ? e.siege : null;
    if (st) {
      const sx = st.x + 0.5 - e.x;
      const sy = st.y + 0.5 - e.y;
      const sd = Math.hypot(sx, sy) || 1;
      if (sd < e.r + 0.9) {
        e.vx = e.vy = 0;
        attackStructure(game, e, st);
      } else {
        const s = steer(game, e, sx / sd, sy / sd);
        if (s.blocked) attackStructure(game, e, s.blocked);
        e.vx = s.x * speed * 0.8;
        e.vy = s.y * speed * 0.8;
      }
    } else {
      const w = wander(game, e, dt);
      e.vx = w.x;
      e.vy = w.y;
    }
    if (Math.abs(e.vx) > 0.05) e.facing = e.vx > 0 ? 1 : -1;
    return;
  }
  const aggro = !p.dead;

  switch (e.def.behavior) {
    case 'chase':
      if (aggro) { vx = n.x * speed; vy = n.y * speed; }
      break;
    case 'swoop': {
      if (aggro) {
        const wobble = Math.sin(game.time * 6 + e.phase) * 0.8;
        vx = (n.x - n.y * wobble) * speed;
        vy = (n.y + n.x * wobble) * speed;
      }
      break;
    }
    case 'ranged':
    case 'caster': {
      const want = (e.def.range ?? 6) * 0.75;
      if (aggro) {
        const dir = d > want + 0.5 ? 1 : d < want - 1 ? -1 : 0;
        vx = n.x * speed * dir + -n.y * speed * 0.3 * Math.sin(e.phase + game.time);
        vy = n.y * speed * dir + n.x * speed * 0.3 * Math.sin(e.phase + game.time);
        if (e.atkCd <= 0 && d < (e.def.range ?? 6) + 1) {
          e.atkCd = e.def.behavior === 'caster' ? 2.2 : 1.8;
          enemyShoot(game, e, angleTo(e.x, e.y, p.x, p.y), {
            speed: e.def.projSpeed ?? 6, damage: e.dmg, sprite: e.def.behavior === 'caster' ? 'orb' : 'bone',
          });
        }
      }
      break;
    }
    case 'charger': {
      if (e.state === 'move') {
        if (aggro) { vx = n.x * speed; vy = n.y * speed; }
        if (d < 4.5 && e.atkCd <= 0) {
          e.state = 'windup';
          e.stateT = 0;
          e.chargeDir = n;
        }
      } else if (e.state === 'windup') {
        if (e.stateT > 0.6) { e.state = 'charge'; e.stateT = 0; }
      } else if (e.state === 'charge') {
        vx = e.chargeDir.x * speed * 4.5;
        vy = e.chargeDir.y * speed * 4.5;
        if (e.stateT > 0.45) { e.state = 'move'; e.atkCd = 2.5; }
      }
      break;
    }
    default:
      if (aggro) { vx = n.x * speed; vy = n.y * speed; }
  }
  // Walk around lakes, trees and walls; hack at walls when boxed in.
  const sp = Math.hypot(vx, vy);
  if (sp > 0.01 && e.state !== 'charge') {
    const s = steer(game, e, vx / sp, vy / sp);
    if (s.blocked) attackStructure(game, e, s.blocked);
    vx = s.x * sp;
    vy = s.y * sp;
  }
  e.vx = vx;
  e.vy = vy;
  if (Math.abs(vx) > 0.05) e.facing = vx > 0 ? 1 : -1;

  // Contact damage.
  const reach = e.r + p.r;
  if (!p.dead && d < reach && (e.contactCd ?? 0) <= game.time) {
    e.contactCd = game.time + 0.9;
    game.hurtPlayer(e.dmg * (e.state === 'charge' ? 1.5 : 1), { element: e.element, fromX: e.x, fromY: e.y });
  }
}

// --- Bosses ---------------------------------------------------------------------

function bossPattern(game, b, pattern) {
  const p = game.player;
  const dmg = b.dmg * 0.8;
  const speed = b.phase === 2 ? 7 : 6;
  const color = b.color;
  switch (pattern) {
    case 'ring': {
      const waves = b.phase === 2 ? 3 : 2;
      for (let w = 0; w < waves; w++) {
        game.schedule(w * 0.45, () => {
          if (b.dead) return;
          const n = b.phase === 2 ? 18 : 14;
          const off = w * 0.2;
          for (let i = 0; i < n; i++) enemyShoot(game, b, (i / n) * Math.PI * 2 + off, { speed, damage: dmg, size: 3 });
        });
      }
      return 2;
    }
    case 'spiral': {
      const shots = b.phase === 2 ? 36 : 26;
      for (let i = 0; i < shots; i++) {
        game.schedule(i * 0.07, () => {
          if (b.dead) return;
          const a = i * 0.55;
          enemyShoot(game, b, a, { speed: speed * 0.9, damage: dmg, size: 3 });
          if (b.phase === 2) enemyShoot(game, b, a + Math.PI, { speed: speed * 0.9, damage: dmg, size: 3 });
        });
      }
      return shots * 0.07 + 1.2;
    }
    case 'charge': {
      const n = normalize(p.x - b.x, p.y - b.y);
      const len = 9;
      game.spawnArea('telegraph', {
        owner: 'enemy', shape: 'line', x: b.x, y: b.y, x2: b.x + n.x * len, y2: b.y + n.y * len,
        r: b.r, dur: 0.75, color,
        onEnd: () => {
          if (b.dead) return;
          b.state = 'charge';
          b.stateT = 0;
          b.chargeDir = n;
        },
      });
      b.state = 'windup';
      return 2.2;
    }
    case 'slam': {
      const tx = p.x;
      const ty = p.y;
      const r = b.phase === 2 ? 3 : 2.4;
      game.spawnArea('telegraph', {
        owner: 'enemy', shape: 'circle', x: tx, y: ty, r, dur: 0.95, color,
        onEnd: () => {
          if (b.dead) return;
          game.fx.add({ type: 'ring', x: tx, y: ty, r0: 0.3, r1: r, color, dur: 0.3, fill: true });
          game.shake = Math.max(game.shake, 0.35);
          game.audio.play('boom');
          if (dist2(tx, ty, p.x, p.y) <= (r + p.r) * (r + p.r)) game.hurtPlayer(b.dmg * 1.6, { element: b.element, fromX: tx, fromY: ty });
          game.spawnArea('hazard', { owner: 'enemy', x: tx, y: ty, r: r * 0.7, dur: 3, dps: b.dmg * 0.5, element: b.element });
        },
      });
      return 2;
    }
    case 'summon': {
      const biome = game.data.byId.biomes.get(b.bossDef.biome);
      const count = b.phase === 2 ? 4 : 3;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const x = b.x + Math.cos(a) * 2.5;
        const y = b.y + Math.sin(a) * 2.5;
        const kind = biome.enemies[i % biome.enemies.length];
        const minion = spawnEnemy(game, kind, x, y, { level: b.level, element: b.element });
        if (minion) minion.summoned = true;
        game.fx.emit('smoke', x, y, 6, 0.5);
      }
      return 2.5;
    }
    case 'blink': {
      const a = Math.random() * Math.PI * 2;
      const tx = p.x + Math.cos(a) * 5;
      const ty = p.y + Math.sin(a) * 5;
      game.fx.emit('void', b.x, b.y, 16, b.r * 2);
      b.x = tx;
      b.y = ty;
      game.fx.emit('void', tx, ty, 16, b.r * 2);
      game.schedule(0.4, () => !b.dead && bossPattern(game, b, 'ring'));
      return 2.4;
    }
    default:
      return 1.5;
  }
}

function updateBoss(game, b, dt) {
  const p = game.player;
  b.stateT += dt;
  if (b.phase === 1 && b.hp < b.maxHp * 0.5) {
    b.phase = 2;
    game.emit('toast', { text: `${b.bossDef.name} is enraged!`, kind: 'boss' });
    game.shake = 0.5;
    game.audio.play('boss');
  }
  const d = Math.sqrt(dist2(b.x, b.y, p.x, p.y)) || 1;
  const n = { x: (p.x - b.x) / d, y: (p.y - b.y) / d };
  if (b.state === 'charge') {
    b.vx = b.chargeDir.x * 13;
    b.vy = b.chargeDir.y * 13;
    if (b.stateT > 0.55) {
      b.state = 'move';
      b.vx = b.vy = 0;
    }
  } else if (b.state === 'windup') {
    b.vx = b.vy = 0;
  } else {
    const speed = b.speed * b.slowMult * (b.phase === 2 ? 1.25 : 1);
    const want = d > 3.5 ? 1 : 0;
    b.vx = n.x * speed * want;
    b.vy = n.y * speed * want;
    b.patternCd -= dt * (b.phase === 2 ? 1.35 : 1);
    if (b.patternCd <= 0 && !p.dead) {
      const list = b.bossDef.patterns;
      const pattern = list[b.patternIdx % list.length];
      b.patternIdx += Math.random() < 0.3 ? 2 : 1;
      b.patternCd = bossPattern(game, b, pattern);
    }
  }
  if (Math.abs(b.vx) > 0.05) b.facing = b.vx > 0 ? 1 : -1;
  if (!p.dead && d < b.r + p.r && (b.contactCd ?? 0) <= game.time) {
    b.contactCd = game.time + 0.8;
    game.hurtPlayer(b.dmg * (b.state === 'charge' ? 1.6 : 1), { element: b.element, fromX: b.x, fromY: b.y });
  }
}

// --- Update + spawning -------------------------------------------------------------

export function updateEnemies(game, dt) {
  const list = game.enemies;
  const p = game.player;
  for (const e of list) {
    if (e.dead) continue;
    tickStatuses(game, e, dt);
    if (e.dead) continue;
    e.flash = Math.max(0, e.flash - dt);
    if (e.squash) e.squash = Math.max(0, e.squash - dt * 7);
    if (e.stunned) {
      e.vx = e.vy = 0;
    } else if (e.boss) {
      updateBoss(game, e, dt);
    } else {
      updateBehaviour(game, e, dt);
    }
    const kx = e.kx;
    const ky = e.ky;
    moveEnemy(game, e, e.vx + kx, e.vy + ky, dt);
    const damp = Math.exp(-9 * dt);
    e.kx *= damp;
    e.ky *= damp;
  }
  // Light separation so crowds don't collapse into one sprite. A push never
  // shoves an enemy into water or a wall (that is how they used to get stuck).
  const nudge = (e, px, py) => {
    const nx = e.x + px;
    const ny = e.y + py;
    if (e.boss || game.world.isFree(nx, ny, Math.min(e.r, 0.45), moveMode(e))) {
      e.x = nx;
      e.y = ny;
    }
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.dead) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b.dead) continue;
      const rr = a.r + b.r;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2v = dx * dx + dy * dy;
      if (d2v > 0.0001 && d2v < rr * rr) {
        const d = Math.sqrt(d2v);
        const push = (rr - d) * 0.5;
        const wa = a.boss ? 0 : b.boss ? 1 : 0.5;
        const wb = 1 - wa;
        nudge(a, -(dx / d) * push * wa * 2, -(dy / d) * push * wa * 2);
        nudge(b, (dx / d) * push * wb * 2, (dy / d) * push * wb * 2);
      }
    }
  }
  // Remove dead and far-away enemies.
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const far = !e.boss && dist2(e.x, e.y, p.x, p.y) > DESPAWN_DIST * DESPAWN_DIST;
    if (e.dead || far) list.splice(i, 1);
  }
}

export function updateSpawner(game, dt) {
  const p = game.player;
  if (p.dead) return;
  game.spawnTimer -= dt;
  if (game.spawnTimer > 0) return;
  game.spawnTimer = 0.45;
  const safe = safeRadius(game);
  if (Math.hypot(p.x, p.y) < safe - 2) return;
  // Markets are safe havens too.
  if (game.world.marketAt(p.x, p.y, 6)) return;
  const wl = game.world.worldLevel(p.x, p.y);
  const bossActive = Boolean(game.boss);
  const quality = game.quality.enemyFactor;
  const target = Math.round(Math.min(26, 5 + wl * 2 + Math.floor(game.save.player.level / 2)) * quality * (bossActive ? 0.3 : 1));
  const alive = game.enemies.filter((e) => !e.dead && !e.boss).length;
  if (alive >= target) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const d = 12 + Math.random() * 5;
    const x = p.x + Math.cos(a) * d;
    const y = p.y + Math.sin(a) * d;
    if (Math.hypot(x, y) < safe || !game.world.isFree(x, y, 0.45, 'enemy') || game.world.marketAt(x, y, 8)) continue;
    const biome = game.world.biomeAt(Math.floor(x), Math.floor(y));
    const candidates = biome.enemies.map((id) => game.data.byId.enemies.get(id)).filter(Boolean);
    let total = 0;
    for (const c of candidates) total += c.weight;
    let r = Math.random() * total;
    let def = candidates[0];
    for (const c of candidates) {
      if (r < c.weight) { def = c; break; }
      r -= c.weight;
    }
    const level = Math.max(game.world.worldLevel(x, y), game.save.player.level - 1);
    const group = def.id === 'brute' ? 1 : 1 + ((Math.random() * 3) | 0);
    const element = null;
    for (let g = 0; g < group && alive + g < target; g++) {
      const gx = x + (Math.random() - 0.5) * 1.5;
      const gy = y + (Math.random() - 0.5) * 1.5;
      if (!game.world.isFree(gx, gy, 0.4, 'enemy')) continue;
      spawnEnemy(game, def.id, gx, gy, { level, element, biome, elite: Math.random() < 0.05 + level * 0.004 });
    }
    return;
  }
}

/** Marks an enemy dead and hands out rewards. */
export function killEnemy(game, e) {
  if (e.dead) return;
  e.dead = true;
  game.onEnemyKilled(e);
}
