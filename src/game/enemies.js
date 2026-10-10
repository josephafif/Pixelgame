// Enemies: spawning around the player, simple readable AI per behaviour,
// elemental variants per biome, elites, and multi-phase bosses.

import { dist2, normalize, angleTo, segmentDist2 } from '../core/math.js';
import { laserField, LASER_WIDTH, windWave } from './lasers.js';
import { tickStatuses } from './status.js';
import { T } from './world.js';
import { enemySprites, bossSprites } from '../render/sprites.js';
import { creatureSprites, hasCreature } from '../render/creatures.js';
import { mixHex } from '../weapons/visuals.js';

let nextId = 1;
const DESPAWN_DIST = 34;
// Enemies give up the chase once you are this many times their sight away.
const LEASH = 1.8;
const PACK_RADIUS = 4;

/**
 * Collision mode: flyers and floaters (bats, wisps, imps, harpies, eyes,
 * shades) pass over trees and rocks (never over water); sharks swim
 * anywhere in the sea, serpents only in the deep.
 */
export function moveMode(e) {
  if (e.def?.swim) return e.def.swim === 'deep' ? 'deepswim' : 'swim';
  const body = e.def?.body;
  return body === 'fly' || body === 'float' || e.kind === 'bat' || e.kind === 'wisp' ? 'fly' : 'enemy';
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
  // Some kinds are always elites (the Mirror Knight).
  elite ||= Boolean(def.elite);
  let el = element;
  if (!el && biome) {
    const nonPhysical = biome.elements.filter((e) => e !== 'physical');
    if ((def.elemental || Math.random() < 0.3) && nonPhysical.length) el = nonPhysical[(Math.random() * nonPhysical.length) | 0];
  }
  el ??= 'physical';
  const elDef = game.data.byId.elements.get(el);
  // Elemental variants take the element's colour; creatures that aren't
  // elemental by nature keep a hint of their own so they stay recognisable.
  const elColor = el !== 'physical' ? elDef?.palette?.[1] : null;
  const color = !elColor ? def.color : def.elemental ? elColor : mixHex(def.color, elColor, 0.55);
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
    sprites: hasCreature(def.id) ? creatureSprites(def.id, color) : enemySprites(def.id, color),
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
  e.spin = Math.random() < 0.5 ? 1 : -1; // which way it circles or flanks
  if (def.swim) {
    e.trail = []; // a serpent's body follows where its head has been
    e.trailT = 0;
    e.phaseT = 4 + Math.random() * 2;
  }
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

/** The soldier this monster fights, if any (campaign.js). */
function soldierFoe(game, e, dt) {
  const b = e.brawl;
  if (b && !b.dead && !b.ghost && (b.x - e.x) ** 2 + (b.y - e.y) ** 2 < 14 * 14) return b;
  e.brawl = null;
  if (!(e.outpost || e.raid) || !game.campaign) return null;
  e.brawlScanT = (e.brawlScanT ?? 0) - dt;
  if (e.brawlScanT > 0) return null;
  e.brawlScanT = 0.5;
  const sight = e.def.sight ?? 7;
  let best = null;
  let bestD = sight * sight;
  for (const s of game.campaign.soldiers()) {
    if (s.dead || s.ghost) continue;
    const dd = (s.x - e.x) ** 2 + (s.y - e.y) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = s;
    }
  }
  e.brawl = best;
  return best;
}

/** Up close with a soldier: blows; otherwise towards it. */
function brawl(game, e, foe, speed) {
  const dx = foe.x - e.x;
  const dy = foe.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  if (Math.abs(dx) > 0.05) e.facing = dx > 0 ? 1 : -1;
  if (d < e.r + (foe.r ?? 0.3) + 0.45) {
    e.vx = e.vy = 0;
    if (e.atkCd <= 0) {
      e.atkCd = 1.1;
      e.squash = 0.6;
      game.campaign?.hurt(foe, e.dmg, e);
    }
    return;
  }
  const s = steer(game, e, dx / d, dy / d);
  e.vx = s.x * speed;
  e.vy = s.y * speed;
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
  // Your soldiers are foes too: the one fighting it, or (for an outpost's
  // guards and raiders) any soldier that comes close. Whoever is nearer.
  const foe = e.state === 'charge' ? null : soldierFoe(game, e, dt);
  if (foe && (!e.alert || p.dead || (foe.x - e.x) ** 2 + (foe.y - e.y) ** 2 < d * d)) {
    brawl(game, e, foe, speed);
    return;
  }
  if (!e.alert && e.state !== 'charge') {
    // Lost you mid-attack: calm down (a fading shade comes back).
    if (e.state === 'windup' || e.state === 'fade') {
      e.state = 'move';
      e.submerged = false;
    }
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
          e.castT = game.time;
          enemyShoot(game, e, angleTo(e.x, e.y, p.x, p.y), {
            speed: e.def.projSpeed ?? 6, damage: e.dmg, sprite: e.def.behavior === 'caster' ? 'orb' : 'bone',
          });
        }
      }
      break;
    }
    case 'charger':
    case 'pack':
    case 'scuttle':
      ({ vx, vy } = charger(game, e, d, n, speed, aggro));
      break;
    case 'blinker':
      ({ vx, vy } = blinker(game, e, d, n, speed, aggro));
      break;
    case 'shark': {
      // Circle the boat, then dart in for a bite and swing away again.
      e.circleT = (e.circleT ?? 1.2 + Math.random()) - dt;
      if (e.state === 'lunge') {
        vx = e.chargeDir.x * speed * 2.4;
        vy = e.chargeDir.y * speed * 2.4;
        if (e.stateT > 0.5) {
          e.state = 'move';
          e.stateT = 0;
          e.circleT = 1.6 + Math.random() * 1.6;
        }
      } else if (aggro) {
        const orbit = 2.8;
        const pull = Math.max(-1, Math.min(1, (d - orbit) * 0.7));
        vx = (n.x * pull - n.y * e.spin) * speed;
        vy = (n.y * pull + n.x * e.spin) * speed;
        if (e.circleT <= 0 && d < 5.5 && game.sailing) {
          e.state = 'lunge';
          e.stateT = 0;
          e.chargeDir = n;
          game.fx.emit('splash', e.x, e.y, 6, 0.4, 1.5);
        }
      }
      break;
    }
    case 'serpent':
      ({ vx, vy } = serpent(game, e, d, n, speed, aggro, dt));
      break;
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
  if ((e.state === 'windup' || e.state === 'charge') && e.chargeDir) e.facing = e.chargeDir.x >= 0 ? 1 : -1;
  else if (e.def.behavior === 'scuttle' || e.def.behavior === 'blinker') e.facing = dx >= 0 ? 1 : -1;
  else if (Math.abs(vx) > 0.05) e.facing = vx > 0 ? 1 : -1;

  // Contact damage (sea creatures only reach you out on the water).
  const reach = e.r + p.r;
  const canReach = !e.def.sea || game.sailing;
  if (!p.dead && canReach && !e.submerged && d < reach && (e.contactCd ?? 0) <= game.time) {
    e.contactCd = game.time + 0.9;
    const hard = e.state === 'charge' || e.state === 'lunge';
    const hit = game.hurtPlayer(e.dmg * (hard ? 1.5 : 1), { element: e.element, fromX: e.x, fromY: e.y });
    if (e.def.sea) game.fx.emit('splash', p.x, p.y, 8, 0.5, 2);
    if (hit && e.def.sting && Math.random() < 0.5) game.applyPlayerStatus?.(e.def.sting);
  }
}

/**
 * Chargers wind up, then dash at you: boars from far off, spiders leap from
 * close by, golems and yetis barrel in. Wolves circle round to your side
 * first (so a pack surrounds you) and crabs scuttle sideways, then pinch.
 */
function charger(game, e, d, n, speed, aggro) {
  const def = e.def;
  const trigger = def.trigger ?? 4.5;
  if (e.state === 'windup') {
    if (e.stateT > (def.windup ?? 0.6)) {
      e.state = 'charge';
      e.stateT = 0;
      game.fx.emit('dust', e.x, e.y + e.r * 0.6, 4, 0.3, 1.2);
    }
    return { vx: 0, vy: 0 };
  }
  if (e.state === 'charge') {
    const k = def.dash ?? 4.5;
    if (e.stateT > (def.dashTime ?? 0.45)) {
      e.state = 'move';
      e.atkCd = (def.cooldown ?? 2.5) * (0.85 + Math.random() * 0.3);
    }
    return { vx: e.chargeDir.x * speed * k, vy: e.chargeDir.y * speed * k };
  }
  if (!aggro) return { vx: 0, vy: 0 };
  let ax = n.x;
  let ay = n.y;
  if (def.behavior === 'pack' && d > trigger * 0.8) {
    const side = Math.min(1.2, (d - trigger * 0.8) / 3);
    ax = n.x - n.y * e.spin * side;
    ay = n.y + n.x * e.spin * side;
  } else if (def.behavior === 'scuttle') {
    const wob = Math.sin(game.time * 3 + e.phase) * 1.1;
    ax = n.x * 0.6 - n.y * wob;
    ay = n.y * 0.6 + n.x * wob;
  }
  const len = Math.hypot(ax, ay) || 1;
  if (d < trigger && e.atkCd <= 0) {
    e.state = 'windup';
    e.stateT = 0;
    e.chargeDir = n;
  }
  return { vx: (ax / len) * speed, vy: (ay / len) * speed };
}

/**
 * Shades drift towards you, fade out (nothing can hit them while they are
 * gone) and reappear right behind you for a quick strike.
 */
function blinker(game, e, d, n, speed, aggro) {
  const p = game.player;
  if (e.state === 'fade') {
    if (e.stateT > 0.6) {
      const r = Math.min(e.r, 0.45);
      let spot = null;
      for (const turn of [0, 0.7, -0.7, 1.4, -1.4, Math.PI]) {
        const a = (p.facing ?? 0) + Math.PI + turn;
        const x = p.x + Math.cos(a) * 1.9;
        const y = p.y + Math.sin(a) * 1.9;
        if (game.world.isFree(x, y, r, 'fly')) {
          spot = { x, y };
          break;
        }
      }
      if (spot) {
        game.fx.emit('void', e.x, e.y, 6, 0.4, 1);
        e.x = spot.x;
        e.y = spot.y;
        game.fx.emit('void', e.x, e.y, 8, 0.4, 1.4);
      }
      e.submerged = false;
      e.state = 'windup';
      e.stateT = 0;
      e.chargeDir = normalize(p.x - e.x, p.y - e.y);
    }
    return { vx: 0, vy: 0 };
  }
  if (e.state === 'windup') {
    if (e.stateT > 0.4) {
      e.state = 'charge';
      e.stateT = 0;
    }
    return { vx: 0, vy: 0 };
  }
  if (e.state === 'charge') {
    if (e.stateT > 0.25) {
      e.state = 'move';
      e.atkCd = 3.2 + Math.random();
    }
    return { vx: e.chargeDir.x * speed * 3.4, vy: e.chargeDir.y * speed * 3.4 };
  }
  if (!aggro) return { vx: 0, vy: 0 };
  if (d < 7 && d > 1.6 && e.atkCd <= 0) {
    e.state = 'fade';
    e.stateT = 0;
    e.submerged = true;
    game.fx.emit('void', e.x, e.y, 6, 0.4, 1);
    return { vx: 0, vy: 0 };
  }
  const sway = Math.sin(game.time * 2 + e.phase) * 0.5;
  return { vx: (n.x - n.y * sway) * speed * 0.7, vy: (n.y + n.x * sway) * speed * 0.7 };
}

/**
 * Sea serpent: weaves around you at range spitting water, then dives
 * (it can't be hit under water) and bursts up somewhere near you.
 */
function serpent(game, e, d, n, speed, aggro, dt) {
  const p = game.player;
  e.phaseT -= dt;
  if (e.state === 'dive') {
    const tx = e.surfaceX - e.x;
    const ty = e.surfaceY - e.y;
    const dd = Math.hypot(tx, ty);
    if (e.stateT > 1.6) {
      e.state = 'erupt';
      e.stateT = 0;
      const sx = e.surfaceX;
      const sy = e.surfaceY;
      game.spawnArea('telegraph', {
        owner: 'enemy', shape: 'circle', x: sx, y: sy, r: 1.5, dur: 0.75, color: '#9ad8f4',
        onEnd: () => {
          if (e.dead) return;
          e.submerged = false;
          e.state = 'move';
          e.stateT = 0;
          e.phaseT = 5 + Math.random() * 2.5;
          game.fx.emit('splash', sx, sy, 22, 1, 3.5);
          game.fx.add({ type: 'ring', x: sx, y: sy, r0: 0.3, r1: 1.8, color: '#e8f8ff', dur: 0.35 });
          game.audio.play('boom', { throttle: 120 });
          if (game.sailing && (sx - p.x) ** 2 + (sy - p.y) ** 2 <= (1.5 + p.r) ** 2) {
            game.hurtPlayer(e.dmg * 1.4, { element: 'physical', fromX: sx, fromY: sy });
          }
        },
      });
    }
    return dd > 0.3 ? { vx: (tx / dd) * speed * 1.8, vy: (ty / dd) * speed * 1.8 } : { vx: 0, vy: 0 };
  }
  if (e.state === 'erupt') return { vx: 0, vy: 0 };
  if (!aggro) return { vx: 0, vy: 0 };
  // Keep about five tiles away, weaving from side to side.
  const want = 5;
  const dir = d > want + 1 ? 1 : d < want - 1 ? -0.6 : 0;
  const weave = Math.sin(game.time * 2.6 + e.phase) * 0.9;
  if (e.atkCd <= 0 && d < (e.def.range ?? 8) + 1) {
    e.atkCd = 2.4;
    const aim = angleTo(e.x, e.y, p.x, p.y);
    for (const off of [-0.22, 0, 0.22]) {
      game.spawnProjectile({
        x: e.x, y: e.y, angle: aim + off, speed: e.def.projSpeed ?? 7, damage: e.dmg * 0.7, range: 11, size: 3,
        sprite: 'orb', owner: 'enemy', element: 'physical', color: '#9ad8f4', depth: 0,
      });
    }
    game.fx.emit('splash', e.x, e.y, 6, 0.4, 1.5);
  }
  if (e.phaseT <= 0) {
    // Dive, and come up again a few tiles from you (in deep water).
    const a = Math.random() * Math.PI * 2;
    const r = 2.5 + Math.random() * 1.5;
    const spot = game.world.findFreeSpot(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 0.5, 'deepswim', null);
    if (spot) {
      e.state = 'dive';
      e.stateT = 0;
      e.submerged = true;
      e.surfaceX = spot.x;
      e.surfaceY = spot.y;
      game.fx.emit('splash', e.x, e.y, 14, 0.8, 2.5);
    } else {
      e.phaseT = 2;
    }
  }
  return { vx: (n.x * dir - n.y * weave) * speed, vy: (n.y * dir + n.x * weave) * speed };
}

// --- Bosses ---------------------------------------------------------------------

/** Removes an enemy without loot or XP (mirror images, expired summons). */
function vanish(game, e) {
  e.dead = true;
  e.hp = 0;
  game.fx.emit('void', e.x, e.y, 14, e.r * 2);
}

function bossPattern(game, b, pattern) {
  const p = game.player;
  const dmg = b.dmg * 0.8;
  const speed = b.phase === 2 ? 7 : 6;
  const color = b.color;
  switch (pattern) {
    case 'mirebloom': {
      // The fen fights for its heart: puffballs burst around you, while a
      // healing bloom opens a few steps away (use it).
      const n = b.phase === 2 ? 4 : 3;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 1 + Math.random() * 2.2;
        const tx = p.x + Math.cos(a) * d;
        const ty = p.y + Math.sin(a) * d;
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 1.6, dur: 0.9 + i * 0.2, color: '#b8d84a',
          onEnd: () => {
            if (b.dead) return;
            game.spawnArea('puff', { owner: 'enemy', x: tx, y: ty, r: 2, dur: 3.5, dps: b.dmg * 0.6, color: '#b8d84a', element: 'poison', fromBoss: true });
            game.fx.emit('smoke', tx, ty, 14, 0.8, 2);
            game.audio.play('whirl', { throttle: 100 });
          },
        });
      }
      const away = Math.atan2(p.y - b.y, p.x - b.x) + (Math.random() - 0.5) * 1.6;
      const mx = p.x + Math.cos(away) * 4.5;
      const my = p.y + Math.sin(away) * 4.5;
      game.spawnArea('mend', { owner: 'plant', x: mx, y: my, r: 1.8, dur: 5, healPct: 5, color: '#9affc8' });
      game.fx.emit('sparkle', mx, my, 16, 0.8, 2);
      return b.phase === 2 ? 3.4 : 3;
    }
    case 'skydive': {
      // It climbs out of reach, then dives on you: run from the shadow.
      b.submerged = true;
      b.state = 'windup';
      game.fx.emit('glint', b.x, b.y, 20, b.r * 1.5, 3, ['#ffffff', '#e8d8a8']);
      game.audio.play('whirl');
      const dive = (k) => {
        if (b.dead) return;
        const tx = p.x;
        const ty = p.y;
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 2.3, dur: 1.1, color: '#e8d8a8',
          onEnd: () => {
            if (b.dead) return;
            b.x = tx;
            b.y = ty;
            game.shake = Math.max(game.shake, 0.45);
            game.fx.add({ type: 'ring', x: tx, y: ty, r0: 0.4, r1: 2.6, color: '#ffffff', dur: 0.35, fill: true });
            game.fx.emit('dust', tx, ty, 22, 1.6, 4);
            game.audio.play('boom');
            if (dist2(tx, ty, p.x, p.y) <= (2.3 + p.r) ** 2) game.hurtPlayer(b.dmg * 1.6, { element: 'wind', fromX: tx, fromY: ty });
            // Feathers of wind fly out in a ring.
            for (let i = 0; i < 12; i++) enemyShoot(game, b, (i / 12) * Math.PI * 2, { speed: 6, damage: dmg * 0.5, size: 2 });
            if (b.phase === 2 && k === 0) {
              game.schedule(0.5, () => dive(1));
            } else {
              b.submerged = false;
              b.state = 'move';
            }
          },
        });
      };
      game.schedule(0.8, () => dive(0));
      return b.phase === 2 ? 4.2 : 3.2;
    }
    case 'windwave': {
      // Walls of wind sweep out from the Roc and throw you back; one lane stays calm.
      for (const w of windWave(b.x, b.y, b.r, p.x, p.y)) {
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'line', laser: true, x: w.x, y: w.y, x2: w.x2, y2: w.y2, r: 0.55, dur: w.delay, color: '#e8f4ff',
          onEnd: () => {
            if (b.dead) return;
            game.fx.add({ type: 'line', points: [[w.x, w.y], [w.x2, w.y2]], color: '#ffffff', dur: 0.2, width: 5 });
            if (segmentDist2(p.x, p.y, w.x, w.y, w.x2, w.y2) <= (0.55 + p.r) ** 2) {
              game.hurtPlayer(b.dmg * 0.9, { element: 'wind', fromX: b.x, fromY: b.y });
              p.kx += w.dx * 9;
              p.ky += w.dy * 9;
            }
          },
        });
      }
      game.audio.play('whirl');
      return 3;
    }
    case 'lasers': {
      // Laser fields: glowing lines across the arena, then they fire. Stand in a gap.
      for (const beam of laserField(p.x, p.y, b.phase)) {
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'line', laser: true, x: beam.x, y: beam.y, x2: beam.x2, y2: beam.y2, r: LASER_WIDTH, dur: beam.delay, color: beam.color,
          onEnd: () => {
            if (b.dead) return;
            game.fx.add({ type: 'line', points: [[beam.x, beam.y], [beam.x2, beam.y2]], color: beam.color, dur: 0.25, width: 4 });
            game.audio.play('zap', { throttle: 80 });
            if (segmentDist2(p.x, p.y, beam.x, beam.y, beam.x2, beam.y2) <= (LASER_WIDTH + p.r) ** 2) {
              game.hurtPlayer(b.dmg * 1.2, { element: b.element, fromX: b.x, fromY: b.y });
            }
          },
        });
      }
      game.audio.play('hum');
      return b.phase === 2 ? 3.2 : 2.6;
    }
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
      // Mirror images vanish when the real Herald moves.
      for (const e of game.enemies) if (e.cloneOf === b && !e.dead) vanish(game, e);
      game.schedule(0.4, () => !b.dead && bossPattern(game, b, 'ring'));
      return 2.4;
    }

    // --- Inferno Titan: meteors rain on the arena --------------------------------
    case 'meteors': {
      const n = b.phase === 2 ? 9 : 6;
      for (let i = 0; i < n; i++) {
        game.schedule(i * 0.14, () => {
          if (b.dead) return;
          const a = Math.random() * Math.PI * 2;
          const d = i === 0 ? 0 : 1 + Math.random() * 4;
          const tx = p.x + Math.cos(a) * d;
          const ty = p.y + Math.sin(a) * d;
          game.spawnArea('telegraph', {
            owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 1.3, dur: 1.05, color,
            onEnd: () => {
              if (b.dead) return;
              game.fx.add({ type: 'pillar', x: tx, y: ty, r: 0.5, color: '#ff9a3a', dur: 0.3 });
              game.fx.add({ type: 'ring', x: tx, y: ty, r0: 0.2, r1: 1.4, color: '#ff6a2a', dur: 0.3, fill: true });
              game.fx.emit('ember', tx, ty, 12, 0.8, 3);
              game.audio.play('boom', { throttle: 90 });
              game.shake = Math.max(game.shake, 0.15);
              if (dist2(tx, ty, p.x, p.y) <= (1.3 + p.r) ** 2) game.hurtPlayer(b.dmg * 1.1, { element: 'fire', fromX: tx, fromY: ty });
              game.spawnArea('hazard', { owner: 'enemy', x: tx, y: ty, r: 0.8, dur: 2.2, dps: b.dmg * 0.35, element: 'fire' });
            },
          });
        });
      }
      return 2.6;
    }

    // --- Frost Warden: breath, a closing ring of ice, spike lines ----------------
    case 'breath': {
      const aim = Math.atan2(p.y - b.y, p.x - b.x);
      const shots = b.phase === 2 ? 30 : 22;
      b.state = 'windup';
      game.fx.emit('frost', b.x + Math.cos(aim) * b.r, b.y + Math.sin(aim) * b.r, 14, 0.6, 1.5);
      for (let i = 0; i < shots; i++) {
        game.schedule(0.45 + i * 0.05, () => {
          if (b.dead) return;
          const sweep = -0.55 + (i / (shots - 1)) * 1.1;
          enemyShoot(game, b, aim + sweep + (Math.random() - 0.5) * 0.12, { speed: 5.5, damage: dmg * 0.55, size: 2 });
          if (i === shots - 1) b.state = 'move';
        });
      }
      return 0.45 + shots * 0.05 + 1;
    }
    case 'icering': {
      const cx = p.x;
      const cy = p.y;
      const n = 22;
      const gap = Math.floor(Math.random() * n);
      const gapSize = b.phase === 2 ? 3 : 4;
      game.fx.add({ type: 'ring', x: cx, y: cy, r0: 7, r1: 6.6, color: '#bfeaff', dur: 0.6 });
      for (let i = 0; i < n; i++) {
        if ((i - gap + n) % n < gapSize) continue;
        const a = (i / n) * Math.PI * 2;
        const sx = cx + Math.cos(a) * 7;
        const sy = cy + Math.sin(a) * 7;
        game.schedule(0.5, () => {
          if (b.dead) return;
          game.spawnProjectile({
            x: sx, y: sy, angle: a + Math.PI, speed: 3.4, damage: dmg * 0.8, range: 8, size: 3, sprite: 'orb',
            owner: 'enemy', element: 'ice', color: '#bfeaff', status: 'chill', depth: 0,
          });
        });
      }
      return 3;
    }
    case 'spikes': {
      const dirs = b.phase === 2 ? 8 : 4;
      const base = Math.atan2(p.y - b.y, p.x - b.x);
      for (let k = 0; k < dirs; k++) {
        const a = base + (k / dirs) * Math.PI * 2;
        for (let j = 0; j < 7; j++) {
          const d = b.r + 0.8 + j * 1.35;
          const tx = b.x + Math.cos(a) * d;
          const ty = b.y + Math.sin(a) * d;
          game.schedule(j * 0.09, () => {
            if (b.dead) return;
            game.spawnArea('telegraph', {
              owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 0.75, dur: 0.7, color: '#bfeaff',
              onEnd: () => {
                game.fx.add({ type: 'spike', x: tx, y: ty, color: '#bfeaff', dur: 0.35 });
                game.fx.emit('frost', tx, ty, 5, 0.4, 1.5);
                if (dist2(tx, ty, p.x, p.y) <= (0.75 + p.r) ** 2) {
                  game.hurtPlayer(b.dmg * 0.9, { element: 'ice', fromX: tx, fromY: ty });
                  game.applyPlayerStatus('chill');
                }
              },
            });
          });
        }
      }
      return 2.4;
    }

    // --- Storm Colossus: lightning where you stand, dashes, static orbs ----------
    case 'strikes': {
      const n = b.phase === 2 ? 8 : 5;
      for (let i = 0; i < n; i++) {
        game.schedule(i * 0.38, () => {
          if (b.dead || p.dead) return;
          const tx = p.x + p.vx * 0.2;
          const ty = p.y + p.vy * 0.2;
          game.spawnArea('telegraph', {
            owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 1.1, dur: 0.72, color: '#ffe45c',
            onEnd: () => {
              if (b.dead) return;
              game.fx.add({ type: 'line', points: [[tx + (Math.random() - 0.5) * 2, ty - 7], [tx, ty]], color: '#fffbd0', dur: 0.22, jagged: true });
              game.fx.add({ type: 'ring', x: tx, y: ty, r0: 0.2, r1: 1.2, color: '#ffe45c', dur: 0.25, fill: true });
              game.fx.emit('spark', tx, ty, 10, 0.6, 3);
              game.audio.play('zap', { throttle: 60 });
              if (dist2(tx, ty, p.x, p.y) <= (1.1 + p.r) ** 2) game.hurtPlayer(b.dmg * 1.05, { element: 'lightning', fromX: tx, fromY: ty });
            },
          });
        });
      }
      return n * 0.38 + 1.2;
    }
    case 'dash': {
      const dashes = b.phase === 2 ? 4 : 3;
      const one = (k) => {
        if (b.dead || k >= dashes) {
          if (!b.dead) b.state = 'move';
          return;
        }
        const n = normalize(p.x - b.x, p.y - b.y);
        const len = 7;
        b.state = 'windup';
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'line', x: b.x, y: b.y, x2: b.x + n.x * len, y2: b.y + n.y * len,
          r: b.r * 0.8, dur: 0.38, color: '#ffe45c',
          onEnd: () => {
            if (b.dead) return;
            b.state = 'charge';
            b.stateT = 0.2; // a short, fast dash
            b.chargeDir = n;
            b.chargeSpeed = 17;
            game.schedule(0.42, () => one(k + 1));
          },
        });
      };
      one(0);
      return dashes * 0.8 + 1.4;
    }
    case 'orbs': {
      game.spawnArea('orbit', {
        owner: 'enemy', x: b.x, y: b.y, r: 2.8, dur: 7, count: b.phase === 2 ? 4 : 3, follow: b,
        hit: b.dmg * 0.7, element: 'lightning', color: '#ffe45c',
      });
      game.audio.play('zap');
      return 2.2;
    }
    case 'chain': {
      const aim = Math.atan2(p.y - b.y, p.x - b.x);
      const n = b.phase === 2 ? 7 : 5;
      for (let i = 0; i < n; i++) {
        const a = aim + (i - (n - 1) / 2) * 0.16;
        enemyShoot(game, b, a, { speed: 11, damage: dmg * 0.7, size: 2 });
      }
      game.audio.play('zap');
      return 1.6;
    }

    // --- Void Herald: mirror images and a pulling singularity --------------------
    case 'clones': {
      const n = b.phase === 2 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const spot = game.world.findFreeSpot(p.x + Math.cos(a) * 5, p.y + Math.sin(a) * 5, 0.5, 'fly', { x: b.x, y: b.y });
        const c = spawnEnemy(game, 'wisp', spot.x, spot.y, { level: b.level, element: 'void' });
        if (!c) continue;
        Object.assign(c, {
          sprites: b.sprites, r: b.r * 0.9, hp: Math.round(b.maxHp * 0.05), maxHp: Math.round(b.maxHp * 0.05),
          summoned: true, xp: 0, cloneOf: b, expireAt: game.time + 10, color: b.color, sight: 30,
        });
        game.fx.emit('void', spot.x, spot.y, 16, 1);
      }
      // The real Herald slips to a new spot too, so you have to look.
      game.schedule(0.2, () => !b.dead && bossPattern(game, b, 'blinkQuiet'));
      return 3.2;
    }
    case 'blinkQuiet': {
      const a = Math.random() * Math.PI * 2;
      game.fx.emit('void', b.x, b.y, 12, b.r * 2);
      const spot = game.world.findFreeSpot(p.x + Math.cos(a) * 5, p.y + Math.sin(a) * 5, 0.5, 'fly', { x: b.x, y: b.y });
      b.x = spot.x;
      b.y = spot.y;
      return 1;
    }
    case 'gravity': {
      const tx = (b.x + p.x) / 2;
      const ty = (b.y + p.y) / 2;
      game.spawnArea('gravity', {
        owner: 'enemy', x: tx, y: ty, r: 3.4, dur: 3.6, pull: b.phase === 2 ? 3.2 : 2.5,
        dps: b.dmg * 0.9, element: 'void', color: '#9a5cff',
      });
      game.audio.play('whirl');
      return 3;
    }

    // --- Bone King: the dead rise around you, fans of bone, delayed curses -------
    case 'raise': {
      const n = b.phase === 2 ? 4 : 3;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random();
        const spot = game.world.findFreeSpot(p.x + Math.cos(a) * 3.2, p.y + Math.sin(a) * 3.2, 0.4, 'enemy', null);
        if (!spot) continue;
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'circle', x: spot.x, y: spot.y, r: 0.6, dur: 0.9, color: '#e8e4d4',
          onEnd: () => {
            if (b.dead) return;
            const m = spawnEnemy(game, 'skeleton', spot.x, spot.y, { level: b.level, element: 'physical' });
            if (m) Object.assign(m, { summoned: true, alert: true, xp: Math.round(m.xp * 0.3) });
            game.fx.emit('dust', spot.x, spot.y, 10, 0.5, 2);
          },
        });
      }
      return 2.6;
    }
    case 'bonefan': {
      const volleys = b.phase === 2 ? 3 : 2;
      for (let v = 0; v < volleys; v++) {
        game.schedule(v * 0.5, () => {
          if (b.dead) return;
          const aim = Math.atan2(p.y - b.y, p.x - b.x) + (v % 2 ? 0.085 : 0);
          for (let i = 0; i < 7; i++) {
            enemyShoot(game, b, aim + (i - 3) * 0.17, { speed: 7.5, damage: dmg * 0.8, size: 2, sprite: 'bone' });
          }
        });
      }
      return volleys * 0.5 + 1.2;
    }
    case 'curse': {
      const n = b.phase === 2 ? 5 : 3;
      for (let i = 0; i < n; i++) {
        game.schedule(i * 0.3, () => {
          if (b.dead || p.dead) return;
          const tx = p.x;
          const ty = p.y;
          game.spawnArea('telegraph', {
            owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 1.5, dur: 1.1, color: '#d0263a',
            onEnd: () => {
              if (b.dead) return;
              game.fx.add({ type: 'ring', x: tx, y: ty, r0: 0.3, r1: 1.6, color: '#d0263a', dur: 0.3, fill: true });
              game.fx.emit('hit', tx, ty, 8, 0.6, 2);
              if (dist2(tx, ty, p.x, p.y) <= (1.5 + p.r) ** 2) {
                game.hurtPlayer(b.dmg * 1.1, { element: 'bleed', fromX: tx, fromY: ty });
                game.applyPlayerStatus('bleed');
              }
            },
          });
        });
      }
      return n * 0.3 + 1.6;
    }

    // --- Thornmother: roots race towards you, spore clouds, she re-roots ---------
    case 'roots': {
      const lines = b.phase === 2 ? 5 : 3;
      const aim = Math.atan2(p.y - b.y, p.x - b.x);
      for (let k = 0; k < lines; k++) {
        const a = aim + (k - (lines - 1) / 2) * 0.32;
        for (let j = 0; j < 9; j++) {
          const d = b.r + 0.6 + j * 1.2;
          const tx = b.x + Math.cos(a) * d;
          const ty = b.y + Math.sin(a) * d;
          game.schedule(j * 0.11, () => {
            if (b.dead) return;
            game.spawnArea('telegraph', {
              owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 0.7, dur: 0.55, color: '#6ac04a',
              onEnd: () => {
                game.fx.add({ type: 'spike', x: tx, y: ty, color: '#7a5232', dur: 0.4 });
                game.fx.emit('leaf', tx, ty, 3, 0.4, 1.5);
                if (dist2(tx, ty, p.x, p.y) <= (0.7 + p.r) ** 2) {
                  game.hurtPlayer(b.dmg * 0.9, { element: 'poison', fromX: tx, fromY: ty });
                  game.applyPlayerStatus('poison');
                }
              },
            });
          });
        }
      }
      return 2.6;
    }
    case 'spores': {
      const n = b.phase === 2 ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
        const d = i === 0 ? 0 : 1.6 + Math.random() * 2.4;
        const tx = p.x + Math.cos(a) * d;
        const ty = p.y + Math.sin(a) * d;
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 1.3, dur: 0.8, color: '#9ae05a',
          onEnd: () => {
            if (b.dead) return;
            game.spawnArea('hazard', { owner: 'enemy', x: tx, y: ty, r: 1.3, dur: 4.5, dps: b.dmg * 0.45, element: 'poison' });
          },
        });
      }
      return 2.4;
    }
    case 'reroot': {
      // She sinks into the ground and bursts up somewhere else, roots first.
      const a = Math.random() * Math.PI * 2;
      const spot = game.world.findFreeSpot(p.x + Math.cos(a) * 6, p.y + Math.sin(a) * 6, b.r * 0.6, 'fly', { x: b.x, y: b.y });
      game.fx.emit('leaf', b.x, b.y, 18, b.r * 1.5, 2);
      b.submerged = true;
      b.state = 'windup';
      game.spawnArea('telegraph', {
        owner: 'enemy', shape: 'circle', x: spot.x, y: spot.y, r: b.r + 0.6, dur: 1, color: '#6ac04a',
        onEnd: () => {
          if (b.dead) return;
          b.x = spot.x;
          b.y = spot.y;
          b.submerged = false;
          b.state = 'move';
          game.shake = Math.max(game.shake, 0.3);
          game.fx.emit('leaf', b.x, b.y, 20, b.r * 1.5, 3);
          if (dist2(b.x, b.y, p.x, p.y) <= (b.r + 0.6 + p.r) ** 2) game.hurtPlayer(b.dmg * 1.3, { element: 'poison', fromX: b.x, fromY: b.y });
        },
      });
      return 2.2;
    }

    // --- Sand Wyrm: dives under the sand, quakes, spits sand ---------------------
    case 'burrow': {
      b.submerged = true;
      b.state = 'windup';
      game.fx.emit('dust', b.x, b.y, 20, b.r * 1.5, 3);
      game.audio.play('boom');
      const erupt = (k) => {
        if (b.dead) return;
        const tx = p.x;
        const ty = p.y;
        game.spawnArea('telegraph', {
          owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 2, dur: 1.05, color: '#d8a858',
          onEnd: () => {
            if (b.dead) return;
            b.x = tx;
            b.y = ty;
            game.shake = Math.max(game.shake, 0.45);
            game.fx.add({ type: 'ring', x: tx, y: ty, r0: 0.4, r1: 2.4, color: '#d8a858', dur: 0.35, fill: true });
            game.fx.emit('dust', tx, ty, 26, 1.6, 4);
            if (dist2(tx, ty, p.x, p.y) <= (2 + p.r) ** 2) game.hurtPlayer(b.dmg * 1.6, { element: 'earth', fromX: tx, fromY: ty });
            // Debris flies out in a ring.
            for (let i = 0; i < 10; i++) enemyShoot(game, b, (i / 10) * Math.PI * 2, { speed: 5, damage: dmg * 0.6, size: 2 });
            if (b.phase === 2 && k === 0) {
              game.schedule(0.6, () => erupt(1));
            } else {
              b.submerged = false;
              b.state = 'move';
            }
          },
        });
      };
      game.schedule(0.9, () => erupt(0));
      return b.phase === 2 ? 4.4 : 3.2;
    }
    case 'quake': {
      const waves = b.phase === 2 ? 4 : 3;
      for (let w = 0; w < waves; w++) {
        game.schedule(w * 0.7, () => {
          if (b.dead) return;
          const cx = b.x;
          const cy = b.y;
          game.shake = Math.max(game.shake, 0.2);
          game.fx.add({ type: 'ring', x: cx, y: cy, r0: b.r, r1: 9, color: '#d8a858', dur: 1.1 });
          game.audio.play('boom', { throttle: 200 });
          // The ripple hits whatever it passes (once): step over the gap between rings.
          let hit = false;
          for (let k = 1; k <= 10; k++) {
            game.schedule(k * 0.11, () => {
              if (hit || b.dead || p.dead) return;
              const rad = b.r + (9 - b.r) * (k / 10);
              const d = Math.sqrt(dist2(cx, cy, p.x, p.y));
              if (Math.abs(d - rad) < 0.55) {
                hit = true;
                game.hurtPlayer(b.dmg * 0.9, { element: 'earth', fromX: cx, fromY: cy });
              }
            });
          }
        });
      }
      return waves * 0.7 + 1.4;
    }
    case 'sandspit': {
      const shots = b.phase === 2 ? 5 : 3;
      for (let i = 0; i < shots; i++) {
        game.schedule(i * 0.35, () => {
          if (b.dead || p.dead) return;
          const tx = p.x + p.vx * 0.5;
          const ty = p.y + p.vy * 0.5;
          game.spawnArea('telegraph', {
            owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 1.4, dur: 0.9, color: '#e8c890',
            onEnd: () => {
              if (b.dead) return;
              game.fx.emit('dust', tx, ty, 14, 1, 3);
              if (dist2(tx, ty, p.x, p.y) <= (1.4 + p.r) ** 2) game.hurtPlayer(b.dmg, { element: 'earth', fromX: tx, fromY: ty });
              game.spawnArea('hazard', { owner: 'enemy', x: tx, y: ty, r: 1.1, dur: 2.5, dps: b.dmg * 0.3, element: 'earth' });
            },
          });
        });
      }
      return shots * 0.35 + 1.4;
    }

    // --- Tide Leviathan: walls of water, geysers, whirlpools ----------------------
    case 'wave': {
      const waves = b.phase === 2 ? 3 : 2;
      for (let w = 0; w < waves; w++) {
        game.schedule(w * 1.1, () => {
          if (b.dead || p.dead) return;
          // A wall of water rolls in from one side, with a gap to slip through.
          const from = Math.random() * Math.PI * 2;
          const dirX = -Math.cos(from);
          const dirY = -Math.sin(from);
          const ox = p.x + Math.cos(from) * 8;
          const oy = p.y + Math.sin(from) * 8;
          const gap = Math.floor(Math.random() * 9) - 4;
          for (let k = -7; k <= 7; k++) {
            if (Math.abs(k - gap) <= 1) continue;
            game.spawnProjectile({
              x: ox - dirY * k * 0.9, y: oy + dirX * k * 0.9, angle: Math.atan2(dirY, dirX), speed: 4.2, damage: dmg * 0.8,
              range: 17, size: 3, sprite: 'orb', owner: 'enemy', element: 'ice', color: '#9ad8f4', status: 'chill', depth: 0,
            });
          }
          game.fx.emit('splash', ox, oy, 12, 3, 2);
        });
      }
      return waves * 1.1 + 2;
    }
    case 'geysers': {
      const n = b.phase === 2 ? 7 : 5;
      const cx = p.x;
      const cy = p.y;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
        const d = i === 0 ? 0 : 2.2;
        const tx = cx + Math.cos(a) * d;
        const ty = cy + Math.sin(a) * d;
        game.schedule(i * 0.12, () => {
          if (b.dead) return;
          game.spawnArea('telegraph', {
            owner: 'enemy', shape: 'circle', x: tx, y: ty, r: 1, dur: 0.9, color: '#7ad8ff',
            onEnd: () => {
              if (b.dead) return;
              game.fx.add({ type: 'pillar', x: tx, y: ty, r: 0.8, color: '#bfe8ff', dur: 0.4 });
              game.fx.emit('splash', tx, ty, 14, 0.5, 4);
              if (dist2(tx, ty, p.x, p.y) <= (1 + p.r) ** 2) {
                game.hurtPlayer(b.dmg * 1.05, { element: 'ice', fromX: tx, fromY: ty });
                game.applyPlayerStatus('chill');
              }
            },
          });
        });
      }
      return 2.6;
    }
    case 'whirlpool': {
      game.spawnArea('gravity', {
        owner: 'enemy', x: p.x + (Math.random() - 0.5) * 2, y: p.y + (Math.random() - 0.5) * 2, r: 3.2, dur: 3.4,
        pull: b.phase === 2 ? 3 : 2.3, dps: b.dmg * 0.8, element: 'ice', color: '#3a9ad8', particles: 'splash',
      });
      game.audio.play('whirl');
      return 3;
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
    const cs = b.chargeSpeed ?? 13;
    b.vx = b.chargeDir.x * cs;
    b.vy = b.chargeDir.y * cs;
    // The Titan's charge leaves burning ground; the Colossus leaves sparks.
    const trail = b.bossDef.trail;
    if (trail && (b.trailT = (b.trailT ?? 0) - dt) <= 0) {
      b.trailT = 0.09;
      game.spawnArea('hazard', { owner: 'enemy', x: b.x, y: b.y, r: 0.8, dur: trail === 'fire' ? 3 : 1.2, dps: b.dmg * 0.4, element: trail });
    }
    if (b.stateT > 0.55) {
      b.state = 'move';
      b.vx = b.vy = 0;
      b.chargeSpeed = null;
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
  // The Frost Warden's aura chills anyone who stays close.
  if (b.bossDef.aura === 'chill') {
    if (Math.random() < 0.3) game.fx.emit('frost', b.x, b.y, 1, b.r * 3, 0.5);
    if (!p.dead && d < 4.5 && (b.auraCd ?? 0) <= game.time) {
      b.auraCd = game.time + 1;
      game.applyPlayerStatus('chill');
    }
  }
  if (!p.dead && !b.submerged && d < b.r + p.r && (b.contactCd ?? 0) <= game.time) {
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
    // A Mire Troll mends in the bog: lure it out onto firm ground.
    if (e.def?.bogRegen && e.hp < e.maxHp && game.world.groundAt(Math.floor(e.x), Math.floor(e.y)) === T.BOG) {
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * e.def.bogRegen * dt);
    }
    e.flash = Math.max(0, e.flash - dt);
    if (e.squash) e.squash = Math.max(0, e.squash - dt * 7);
    if (e.expireAt && game.time >= e.expireAt) {
      vanish(game, e);
      continue;
    }
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
    if (e.trail) {
      e.trailT -= dt;
      if (e.trailT <= 0) {
        e.trailT = 0.05;
        e.trail.unshift({ x: e.x, y: e.y });
        if (e.trail.length > 30) e.trail.pop();
      }
    }
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
  // Enemies never stand inside you: whatever walks into you (or you into
  // it) ends up at arm's length and slides around you.
  if (!p.dead) {
    for (const e of list) {
      if (e.dead || e.submerged) continue;
      const rr = e.r + p.r;
      let dx = e.x - p.x;
      let dy = e.y - p.y;
      const d2v = dx * dx + dy * dy;
      if (d2v >= rr * rr) continue;
      let d = Math.sqrt(d2v);
      const push = rr - d;
      if (d < 0.001) {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a);
        dy = Math.sin(a);
        d = 1;
      }
      const px = (dx / d) * push;
      const py = (dy / d) * push;
      const r = Math.min(e.r, 0.45);
      const mode = moveMode(e);
      if (e.boss || game.world.isFree(e.x + px, e.y + py, r, mode)) {
        e.x += px;
        e.y += py;
      } else if (game.world.isFree(e.x + px, e.y, r, mode)) {
        e.x += px;
      } else if (game.world.isFree(e.x, e.y + py, r, mode)) {
        e.y += py;
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

/** Out at sea: sharks everywhere, now and then a serpent in the deep. */
function spawnAtSea(game) {
  const p = game.player;
  const wl = game.world.worldLevel(p.x, p.y);
  const sea = game.enemies.filter((e) => !e.dead && e.def.sea);
  const target = Math.round(Math.min(6, 2 + Math.floor(wl / 2)) * game.quality.enemyFactor);
  if (sea.length >= target) return;
  const serpents = sea.filter((e) => e.kind === 'serpent').length;
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const d = 11 + Math.random() * 5;
    const x = p.x + Math.cos(a) * d;
    const y = p.y + Math.sin(a) * d;
    if (!game.world.isFree(x, y, 0.5, 'swim')) continue;
    const deep = game.world.isFree(x, y, 0.6, 'deepswim');
    const level = Math.max(wl, game.save.player.level - 1);
    if (deep && serpents === 0 && wl >= 3 && Math.random() < 0.22) {
      spawnEnemy(game, 'serpent', x, y, { level });
      game.toast('Something huge moves beneath the waves…', 'boss');
      return;
    }
    const group = Math.random() < 0.3 ? 2 : 1;
    for (let g = 0; g < group; g++) {
      const gx = x + (Math.random() - 0.5) * 2;
      const gy = y + (Math.random() - 0.5) * 2;
      if (game.world.isFree(gx, gy, 0.45, 'swim')) spawnEnemy(game, 'shark', gx, gy, { level });
    }
    return;
  }
}

export function updateSpawner(game, dt) {
  const p = game.player;
  if (p.dead) return;
  game.spawnTimer -= dt;
  if (game.spawnTimer > 0) return;
  game.spawnTimer = 0.45;
  if (game.sailing) {
    spawnAtSea(game);
    return;
  }
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
    const [gMin, gMax] = def.group ?? [1, 3];
    const group = gMin + ((Math.random() * (gMax - gMin + 1)) | 0);
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
