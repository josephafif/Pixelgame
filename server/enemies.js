// Monsters and bosses on the server: spawning around players, simple
// readable behaviours (chase, charge, shoot, cast, swoop, blink) and boss
// attack patterns that every player near the altar fights together.

import { SpatialGrid } from './grid.js';
import { moveMode } from '../src/game/enemies.js';
import { inSafeZone } from '../src/net/rules.js';
import { mixHex } from '../src/weapons/visuals.js';
import * as combat from './combat.js';
import { updateBoss, expireClones } from './bosses.js';

const LEASH = 1.8;
const DESPAWN_DIST = 42;
// Monsters farther than this from every player rest (beyond the 30-tile view).
const REST_DIST = 34;
const SPAWN_MIN = 13;
const SPAWN_MAX = 18;

function scaleFor(level) {
  return { hp: 1 + 0.3 * (level - 1), dmg: 1 + 0.14 * (level - 1) };
}

export function spawnEnemy(gs, defId, x, y, { level = 1, elite = false, biome = null } = {}) {
  const data = gs.data;
  const def = data.byId.enemies.get(defId);
  if (!def) return null;
  let el = 'physical';
  if (biome) {
    const nonPhysical = biome.elements.filter((e) => e !== 'physical');
    if ((def.elemental || Math.random() < 0.3) && nonPhysical.length) el = nonPhysical[(Math.random() * nonPhysical.length) | 0];
  }
  const elDef = data.byId.elements.get(el);
  const elColor = el !== 'physical' ? elDef?.palette?.[1] : null;
  const color = !elColor ? def.color : def.elemental ? elColor : mixHex(def.color, elColor, 0.55);
  const s = scaleFor(level);
  const hp = Math.round(def.hp * s.hp * (elite ? 2.4 : 1));
  const e = {
    id: gs.newId(),
    kind: def.id,
    def,
    defIdx: data.enemies.indexOf(def),
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
    elementIdx: Math.max(0, data.elements.findIndex((x2) => x2.id === el)),
    color,
    elite,
    xp: Math.round(def.xp * (1 + 0.25 * (level - 1)) * (elite ? 3 : 1)),
    statuses: {},
    state: 'move',
    stateT: 0,
    facing: 1,
    atkCd: 0.5 + Math.random(),
    anim: 0,
    alertUntil: 0,
    target: 0,
    homeX: x,
    homeY: y,
    wanderX: x,
    wanderY: y,
    wanderT: Math.random() * 2,
    damageBy: new Map(),
    boss: false,
    dead: false,
    lonely: 0,
    spin: Math.random() < 0.5 ? 1 : -1,
    phase: Math.random() * 10,
    phaseT: 5 + Math.random() * 3, // a serpent's next dive
    submerged: false,
  };
  gs.enemies.set(e.id, e);
  return e;
}

export function spawnBoss(gs, bossId, x, y, altarKey) {
  const def = gs.data.byId.bosses.get(bossId);
  if (!def) return null;
  const near = [...gs.playersNear(x, y, 30)].filter((p) => !p.dead);
  const avgLevel = near.length ? near.reduce((s, p) => s + p.ch.level, 0) / near.length : 1;
  const level = Math.max(Math.round(avgLevel), gs.world.worldLevel(x, y) + 1);
  const s = scaleFor(level);
  // More players around the altar: a tougher guardian.
  const hp = Math.round(def.hp * (1 + 0.22 * (level - 1)) * (1 + 0.6 * Math.max(0, near.length - 1)));
  const boss = {
    id: gs.newId(),
    kind: def.id,
    def,
    bossDef: def,
    defIdx: gs.data.bosses.indexOf(def),
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
    elementIdx: Math.max(0, gs.data.elements.findIndex((x2) => x2.id === def.element)),
    color: def.color,
    elite: false,
    xp: Math.round(def.xp * (1 + 0.2 * (level - 1))),
    statuses: {},
    state: 'move',
    stateT: 0,
    facing: 1,
    atkCd: 1,
    anim: 0,
    alertUntil: Infinity,
    target: 0,
    damageBy: new Map(),
    boss: true,
    dead: false,
    phase: 1,
    patternIdx: 0,
    patternCd: 2.5,
    submerged: false,
    chargeX: 0,
    chargeY: 0,
    anchorX: x,
    anchorY: y,
    altarKey,
    lonely: 0,
  };
  gs.enemies.set(boss.id, boss);
  return boss;
}

// --- Statuses ---------------------------------------------------------------------------

/** The same statuses as single player (src/game/status.js). */
export function applyStatus(gs, e, id, sourceDamage, attacker) {
  const def = gs.data.statuses[id];
  if (!def || e.dead) return;
  const now = gs.time;
  const s = e.statuses;
  const until = now + (def.duration ?? 2);
  const dot = Math.max(1, (sourceDamage * (def.dotPct ?? 0)) / 100);
  const from = attacker?.id ?? 0;
  switch (id) {
    case 'burn':
      s.burn = { until, dps: Math.max(dot, s.burn?.until > now ? s.burn.dps : 0), from };
      break;
    case 'poison':
    case 'bleed': {
      const prev = s[id]?.until > now ? s[id] : null;
      s[id] = { until, stacks: Math.min(def.maxStacks ?? 1, (prev?.stacks ?? 0) + 1), dps: Math.max(dot, prev?.dps ?? 0), from };
      break;
    }
    case 'rift':
      s.rift = { until, dps: dot, from };
      break;
    case 'chill': {
      const stacks = (s.chill?.until > now ? s.chill.stacks : 0) + 1;
      if (stacks >= (def.freezeAt ?? 3) && !e.boss) {
        delete s.chill;
        applyStatus(gs, e, 'freeze', sourceDamage, attacker);
      } else {
        s.chill = { until, stacks };
      }
      break;
    }
    case 'freeze':
      if (e.boss) {
        s.chill = { until, stacks: 1 };
      } else {
        s.freeze = { until };
        s.chill = { until: until + 1, stacks: 0 };
      }
      break;
    case 'shock':
      s.shock = { until };
      break;
    case 'stagger':
      if (!e.boss && !(s.staggerImmune > now)) {
        s.stun = { until };
        s.staggerImmune = now + (def.immunity ?? 2);
      }
      break;
    case 'gust': {
      if (e.boss || !attacker) break;
      const d = Math.hypot(e.x - attacker.x, e.y - attacker.y) || 1;
      e.kx += ((e.x - attacker.x) / d) * (def.knockback ?? 2) * 4;
      e.ky += ((e.y - attacker.y) / d) * (def.knockback ?? 2) * 4;
      break;
    }
    case 'smite':
      gs.schedule(0.2, () => {
        if (e.dead) return;
        gs.event(e.x, e.y, { k: 'fx', fx: 'smite', x: e.x, y: e.y });
        combat.damageEnemy(gs, e, (sourceDamage * (def.bonusPct ?? 25)) / 100, { attacker, element: 'holy', depth: 2, source: 'proc', canCrit: false });
      });
      break;
    case 'mark':
      s.mark = { until };
      break;
    default:
      break;
  }
}

function tickStatuses(gs, e, dt) {
  const s = e.statuses;
  let dot = 0;
  let from = 0;
  for (const id of ['burn', 'poison', 'bleed', 'rift']) {
    const st = s[id];
    if (!st) continue;
    if (st.until <= gs.time) {
      delete s[id];
      continue;
    }
    // Poison and bleeding stack; bleeding hurts more while running.
    const moving = id === 'bleed' && Math.hypot(e.vx, e.vy) > 0.2 ? 1.3 : 1;
    dot += st.dps * (st.stacks ?? 1) * moving;
    from = st.from || from;
  }
  const statuses = gs.data.statuses;
  let slow = 1;
  if (s.chill?.until > gs.time) slow *= 1 - (statuses.chill?.slow ?? 40) / 100;
  if (s.rift?.until > gs.time) slow *= 1 - (statuses.rift?.slow ?? 0) / 100;
  if (e.warpUntil > gs.time) slow *= 1 - e.warpSlow / 100; // Time Warp, Absolute Zero
  e.slowMult = slow;
  e.stunned = s.freeze?.until > gs.time || s.stun?.until > gs.time;
  if (!dot) return;
  e.dotAcc = (e.dotAcc ?? 0) + dot * dt;
  if (e.dotAcc >= 1) {
    const n = Math.floor(e.dotAcc);
    e.dotAcc -= n;
    combat.damageEnemy(gs, e, n, { attacker: gs.players.get(from) ?? null, canCrit: false, depth: 2, source: 'dot' });
  }
}

// --- Movement --------------------------------------------------------------------------------

function moveEnemy(gs, e, dx, dy, dt) {
  const nx = e.x + dx * dt;
  const ny = e.y + dy * dt;
  if (e.boss) {
    e.x = nx;
    e.y = ny;
    return;
  }
  const r = Math.min(e.r, 0.45);
  const mode = moveMode(e);
  const w = gs.world;
  if (!w.isFree(e.x, e.y, r, mode)) {
    const spot = w.findFreeSpot(e.x, e.y, r, mode, null);
    if (spot) {
      e.x = spot.x;
      e.y = spot.y;
    } else {
      e.dead = true;
    }
    return;
  }
  if (w.isFree(nx, e.y, r, mode)) e.x = nx;
  if (w.isFree(e.x, ny, r, mode)) e.y = ny;
}

/** Heads for (nx, ny) (a unit direction), turning around obstacles. */
function steer(gs, e, nx, ny) {
  const r = Math.min(e.r, 0.45);
  const mode = moveMode(e);
  const clear = (ax, ay) => gs.world.isFree(e.x + ax * 0.55, e.y + ay * 0.55, r, mode);
  if (clear(nx, ny)) {
    e.detour = 0;
    return { x: nx, y: ny };
  }
  const side = e.detour || (Math.random() < 0.5 ? 1 : -1);
  for (const turn of [0.6, 1.1, 1.6, 2.2]) {
    for (const sgn of [side, -side]) {
      const a = Math.atan2(ny, nx) + turn * sgn;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      if (clear(cx, cy)) {
        e.detour = sgn;
        return { x: cx, y: cy };
      }
    }
  }
  return { x: 0, y: 0 };
}

function goToward(gs, e, tx, ty, speed) {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.05) {
    e.vx = e.vy = 0;
    return;
  }
  const s = steer(gs, e, dx / d, dy / d);
  e.vx = s.x * speed;
  e.vy = s.y * speed;
  if (Math.abs(dx) > 0.05) e.facing = dx >= 0 ? 1 : -1;
}

// --- Behaviour -------------------------------------------------------------------------------

function pickTarget(gs, e) {
  const sight = e.def.sight ?? 7;
  let t = e.target ? gs.players.get(e.target) : null;
  const sea = Boolean(e.def.sea);
  if (t && (t.dead || inSafeZone(gs.rules, t.x, t.y) || (sea && !t.sailing))) t = null;
  if (t) {
    const d2 = (t.x - e.x) ** 2 + (t.y - e.y) ** 2;
    const leash = sight * LEASH;
    if (d2 > leash * leash && e.alertUntil < gs.time) t = null;
  }
  if (!t) t = gs.nearestPlayer(e.x, e.y, sight, (p) => !inSafeZone(gs.rules, p.x, p.y) && (!sea || p.sailing));
  e.target = t?.id ?? 0;
  return t;
}

function contact(gs, e, p, mult = 1) {
  if (!p || p.dead || e.atkCd > 0 || e.submerged || (e.def.sea && !p.sailing)) return;
  const rr = e.r + p.r + 0.12;
  if ((p.x - e.x) ** 2 + (p.y - e.y) ** 2 > rr * rr) return;
  e.atkCd = 1;
  e.anim = (e.anim + 1) & 255;
  combat.hurtPlayer(gs, p, e.dmg * mult, { element: e.element, fromX: e.x, fromY: e.y });
}

function shoot(gs, e, p, { speed, sprite, spread = 0, count = 1, mult = 0.8 }) {
  const base = Math.atan2(p.y - e.y, p.x - e.x);
  e.anim = (e.anim + 1) & 255;
  e.castT = gs.time;
  for (let i = 0; i < count; i++) {
    const off = count > 1 ? (i / (count - 1) - 0.5) * spread : 0;
    combat.spawnProjectile(gs, {
      x: e.x, y: e.y - 0.2, angle: base + off, speed, damage: e.dmg * mult, range: 11, element: e.element,
      sprite, size: 3, enemy: e.id, color: gs.data.byId.elements.get(e.element)?.glow ?? e.color, kind: 'shot',
    });
  }
}

function wander(gs, e, dt) {
  e.wanderT -= dt;
  if (e.wanderT <= 0) {
    e.wanderT = 2 + Math.random() * 3;
    const a = Math.random() * Math.PI * 2;
    e.wanderX = e.homeX + Math.cos(a) * 3;
    e.wanderY = e.homeY + Math.sin(a) * 3;
  }
  const d2 = (e.wanderX - e.x) ** 2 + (e.wanderY - e.y) ** 2;
  if (d2 < 0.3) {
    e.vx = e.vy = 0;
    e.state = 'idle';
  } else {
    goToward(gs, e, e.wanderX, e.wanderY, e.speed * 0.4);
    e.state = 'move';
  }
}

function behave(gs, e, dt) {
  const p = pickTarget(gs, e);
  e.atkCd = Math.max(0, e.atkCd - dt);
  if (!p) {
    wander(gs, e, dt);
    return;
  }
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const speed = e.speed * (e.slowMult ?? 1);
  e.stateT += dt;
  switch (e.def.behavior) {
    case 'shark':
      shark(gs, e, p, dx, dy, d, speed, dt);
      break;
    case 'serpent':
      serpent(gs, e, p, dx, dy, d, speed, dt);
      break;
    case 'charger': {
      if (e.state === 'windup') {
        e.vx = e.vy = 0;
        if (e.stateT >= 0.6) {
          e.state = 'charge';
          e.stateT = 0;
          e.chargeX = dx / (d || 1);
          e.chargeY = dy / (d || 1);
        }
        break;
      }
      if (e.state === 'charge') {
        e.vx = e.chargeX * speed * 3.2;
        e.vy = e.chargeY * speed * 3.2;
        contact(gs, e, p, 1.4);
        if (e.stateT >= 0.7) {
          e.state = 'idle';
          e.stateT = 0;
          e.atkCd = 1.8;
        }
        break;
      }
      if (e.state === 'idle' && e.stateT < 0.5) {
        e.vx = e.vy = 0;
        break;
      }
      e.state = 'move';
      goToward(gs, e, p.x, p.y, speed);
      contact(gs, e, p);
      if (d < 5 && e.atkCd <= 0) {
        e.state = 'windup';
        e.stateT = 0;
        e.anim = (e.anim + 1) & 255;
      }
      break;
    }
    case 'ranged':
    case 'caster': {
      const range = e.def.range ?? 5;
      e.state = 'move';
      if (d < range * 0.55) goToward(gs, e, e.x - dx, e.y - dy, speed);
      else if (d > range) goToward(gs, e, p.x, p.y, speed);
      else {
        const s = steer(gs, e, (-dy / (d || 1)) * e.spin, (dx / (d || 1)) * e.spin);
        e.vx = s.x * speed * 0.5;
        e.vy = s.y * speed * 0.5;
      }
      e.facing = dx >= 0 ? 1 : -1;
      if (d <= range + 1.5 && e.atkCd <= 0) {
        const caster = e.def.behavior === 'caster';
        e.atkCd = caster ? 2.4 : 2;
        shoot(gs, e, p, {
          speed: e.def.projSpeed ?? 6,
          sprite: caster ? 'orb' : 'bolt',
          count: e.kind === 'eye' ? 3 : 1,
          spread: 0.4,
        });
      }
      break;
    }
    case 'swoop': {
      if (e.state === 'charge') {
        e.vx = e.chargeX * speed * 2.4;
        e.vy = e.chargeY * speed * 2.4;
        contact(gs, e, p);
        if (e.stateT > 0.55) {
          e.state = 'move';
          e.stateT = 0;
          e.atkCd = 1.6;
        }
        break;
      }
      goToward(gs, e, p.x + Math.cos(gs.time + e.id) * 2, p.y + Math.sin(gs.time + e.id) * 2, speed);
      if (d < 4.5 && e.atkCd <= 0) {
        e.state = 'charge';
        e.stateT = 0;
        e.chargeX = dx / (d || 1);
        e.chargeY = dy / (d || 1);
        e.anim = (e.anim + 1) & 255;
      }
      break;
    }
    case 'blinker': {
      if (e.state === 'fade') {
        e.vx = e.vy = 0;
        if (e.stateT >= 0.45) {
          const a = Math.random() * Math.PI * 2;
          const tx = p.x + Math.cos(a) * 1.6;
          const ty = p.y + Math.sin(a) * 1.6;
          if (gs.world.isFree(tx, ty, 0.4, moveMode(e))) {
            e.x = tx;
            e.y = ty;
          }
          e.state = 'move';
          e.stateT = 0;
          e.atkCd = 0.4;
        }
        break;
      }
      goToward(gs, e, p.x, p.y, speed);
      contact(gs, e, p);
      if (d > 3 && e.stateT > 3.5) {
        e.state = 'fade';
        e.stateT = 0;
      }
      break;
    }
    case 'pack': {
      const a = Math.atan2(dy, dx) + e.spin * 0.6;
      const off = d > 2.5 ? 1.2 : 0;
      goToward(gs, e, p.x - Math.cos(a) * off, p.y - Math.sin(a) * off, speed * 1.05);
      contact(gs, e, p);
      e.state = 'move';
      break;
    }
    default:
      goToward(gs, e, p.x, p.y, speed);
      contact(gs, e, p);
      e.state = 'move';
      break;
  }
}

// --- Sea creatures (as in single player) ---------------------------------------------------------

/** Sharks circle the boat, then dart in for a bite and swing away again. */
function shark(gs, e, p, dx, dy, d, speed, dt) {
  const nx = dx / (d || 1);
  const ny = dy / (d || 1);
  e.circleT = (e.circleT ?? 1.2 + Math.random()) - dt;
  let vx;
  let vy;
  if (e.state === 'lunge') {
    vx = e.chargeX * speed * 2.4;
    vy = e.chargeY * speed * 2.4;
    if (e.stateT > 0.5) {
      e.state = 'move';
      e.stateT = 0;
      e.circleT = 1.6 + Math.random() * 1.6;
    }
    contact(gs, e, p, 1.5);
  } else {
    const orbit = 2.8;
    const pull = Math.max(-1, Math.min(1, (d - orbit) * 0.7));
    vx = (nx * pull - ny * e.spin) * speed;
    vy = (ny * pull + nx * e.spin) * speed;
    if (e.circleT <= 0 && d < 5.5 && p.sailing) {
      e.state = 'lunge';
      e.stateT = 0;
      e.chargeX = nx;
      e.chargeY = ny;
      e.anim = (e.anim + 1) & 255;
      gs.event(e.x, e.y, { k: 'fx', fx: 'splash', x: e.x, y: e.y }, 24);
    }
    contact(gs, e, p);
  }
  const sp = Math.sqrt(vx * vx + vy * vy);
  if (sp > 0.01) {
    const s = steer(gs, e, vx / sp, vy / sp);
    e.vx = s.x * sp;
    e.vy = s.y * sp;
  } else {
    e.vx = e.vy = 0;
  }
  if (Math.abs(e.vx) > 0.05) e.facing = e.vx > 0 ? 1 : -1;
}

/**
 * Sea serpents weave around you at range spitting water, then dive (nothing
 * can hit them under water) and burst up somewhere near you.
 */
function serpent(gs, e, p, dx, dy, d, speed, dt) {
  const nx = dx / (d || 1);
  const ny = dy / (d || 1);
  e.phaseT -= dt;
  e.facing = dx >= 0 ? 1 : -1;
  if (e.state === 'dive') {
    const tx = e.surfaceX - e.x;
    const ty = e.surfaceY - e.y;
    const dd = Math.sqrt(tx * tx + ty * ty);
    if (e.stateT > 1.6) {
      e.state = 'erupt';
      e.stateT = 0;
      const sx = e.surfaceX;
      const sy = e.surfaceY;
      // The water bulges where it comes up: get out of the way.
      combat.spawnArea(gs, {
        kind: 'telegraph', x: sx, y: sy, r: 1.5, dur: 0.75, color: '#9ad8f4', damage: e.dmg * 1.4, element: 'physical', enemy: e.id,
        after: () => {
          if (e.dead) return;
          e.submerged = false;
          e.state = 'move';
          e.stateT = 0;
          e.phaseT = 5 + Math.random() * 2.5;
          gs.event(sx, sy, { k: 'fx', fx: 'splash', x: sx, y: sy, big: true }, 30);
        },
      });
    }
    if (dd > 0.3) {
      e.vx = (tx / dd) * speed * 1.8;
      e.vy = (ty / dd) * speed * 1.8;
    } else {
      e.vx = e.vy = 0;
    }
    return;
  }
  if (e.state === 'erupt') {
    e.vx = e.vy = 0;
    return;
  }
  // Keep about five tiles away, weaving from side to side.
  const want = 5;
  const dir = d > want + 1 ? 1 : d < want - 1 ? -0.6 : 0;
  const weave = Math.sin(gs.time * 2.6 + e.phase) * 0.9;
  if (e.atkCd <= 0 && d < (e.def.range ?? 8) + 1) {
    e.atkCd = 2.4;
    shoot(gs, e, p, { speed: e.def.projSpeed ?? 7, sprite: 'orb', count: 3, spread: 0.44, mult: 0.7 });
    gs.event(e.x, e.y, { k: 'fx', fx: 'splash', x: e.x, y: e.y }, 24);
  }
  if (e.phaseT <= 0) {
    // Dive, and come up again a few tiles from you (in deep water).
    const a = Math.random() * Math.PI * 2;
    const r = 2.5 + Math.random() * 1.5;
    const spot = gs.world.findFreeSpot(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 0.5, 'deepswim', null);
    if (spot) {
      e.state = 'dive';
      e.stateT = 0;
      e.submerged = true;
      e.surfaceX = spot.x;
      e.surfaceY = spot.y;
      gs.event(e.x, e.y, { k: 'fx', fx: 'splash', x: e.x, y: e.y, big: true }, 30);
    } else {
      e.phaseT = 2;
    }
  }
  e.vx = (nx * dir - ny * weave) * speed;
  e.vy = (ny * dir + nx * weave) * speed;
}

// --- Bosses ------------------------------------------------------------------------------------

// --- Update + spawning --------------------------------------------------------------------------

export function update(gs, dt) {
  if (gs.tick % 10 === 0) expireClones(gs);
  for (const e of gs.enemies.values()) {
    if (e.dead) {
      gs.enemies.delete(e.id);
      continue;
    }
    tickStatuses(gs, e, dt);
    if (e.dead) continue;
    const near = gs.nearestPlayer(e.x, e.y, e.boss ? 45 : DESPAWN_DIST);
    // Out of everyone's sight (and reach), a monster rests: nobody can see
    // it, and thinking for it would only cost time every tick.
    const resting = !e.boss && (!near || (near.x - e.x) ** 2 + (near.y - e.y) ** 2 > REST_DIST * REST_DIST);
    if (resting) {
      e.vx = e.vy = 0;
    } else if (e.stunned) {
      e.vx = e.vy = 0;
    } else if (e.boss) {
      updateBoss(gs, e, dt);
    } else {
      behave(gs, e, dt);
    }
    if (!resting || e.kx || e.ky) moveEnemy(gs, e, e.vx + e.kx, e.vy + e.ky, dt);
    const damp = 0.74; // exp(-9 / 30)
    e.kx = Math.abs(e.kx) < 0.01 ? 0 : e.kx * damp;
    e.ky = Math.abs(e.ky) < 0.01 ? 0 : e.ky * damp;
    // Nobody around: wander off the map (bosses go home after a while).
    e.lonely = near ? 0 : e.lonely + dt;
    if (e.lonely > (e.boss ? 20 : 8)) {
      gs.enemies.delete(e.id);
      if (e.boss) gs.event(e.x, e.y, { k: 'boss', id: e.id, active: false, victory: false }, 80);
    }
  }
  separate(gs);
  keepOffPlayers(gs);
}

/**
 * Monsters never stand inside a player: whatever walks into you (or you
 * into it) ends up at arm's length and slides around you.
 */
function keepOffPlayers(gs) {
  for (const p of gs.players.values()) {
    if (p.dead) continue;
    for (const e of gs.enemiesNear(p.x, p.y, p.r + 3)) {
      if (e.dead || e.submerged) continue;
      const rr = e.r + p.r;
      let dx = e.x - p.x;
      let dy = e.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      let d = Math.sqrt(d2);
      const push = rr - d;
      if (d < 0.001) {
        // Exactly on top: step out on its own side.
        const a = e.id * 2.39996;
        dx = Math.cos(a);
        dy = Math.sin(a);
        d = 1;
      }
      shove(gs, e, (dx / d) * push, (dy / d) * push);
    }
  }
}

/** Moves a monster by (px, py), sliding along walls rather than into them. */
function shove(gs, e, px, py) {
  if (e.boss) {
    e.x += px;
    e.y += py;
    return;
  }
  const r = Math.min(e.r, 0.45);
  const mode = moveMode(e);
  const w = gs.world;
  if (w.isFree(e.x + px, e.y + py, r, mode)) {
    e.x += px;
    e.y += py;
  } else if (w.isFree(e.x + px, e.y, r, mode)) {
    e.x += px;
  } else if (w.isFree(e.x, e.y + py, r, mode)) {
    e.y += py;
  }
}

/** Light separation so crowds don't merge into one sprite. */
function separate(gs) {
  const grid = (gs.sepGrid ??= new SpatialGrid(2));
  grid.rebuild(gs.enemies.values(), (e) => !e.dead);
  for (const list of grid.cells.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const rr = a.r + b.r;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 0.0001 || d2 >= rr * rr) continue;
        const d = Math.sqrt(d2);
        const push = (rr - d) * 0.5;
        const wa = a.boss ? 0 : b.boss ? 1 : 0.5;
        nudge(gs, a, -(dx / d) * push * wa * 2, -(dy / d) * push * wa * 2);
        nudge(gs, b, (dx / d) * push * (1 - wa) * 2, (dy / d) * push * (1 - wa) * 2);
      }
    }
  }
}

function nudge(gs, e, px, py) {
  if (e.boss || gs.world.isFree(e.x + px, e.y + py, Math.min(e.r, 0.45), moveMode(e))) {
    e.x += px;
    e.y += py;
  }
}

/** Out at sea: sharks everywhere, now and then a serpent in the deep (as in single player). */
function spawnAtSea(gs, p) {
  const wl = gs.world.worldLevel(p.x, p.y);
  let sea = 0;
  let serpents = 0;
  for (const e of gs.enemiesNear(p.x, p.y, 22)) {
    if (e.dead || !e.def.sea) continue;
    sea++;
    if (e.kind === 'serpent') serpents++;
  }
  if (sea >= Math.round(Math.min(6, 2 + Math.floor(wl / 2)))) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const d = 11 + Math.random() * 5;
    const x = p.x + Math.cos(a) * d;
    const y = p.y + Math.sin(a) * d;
    if (!gs.world.isFree(x, y, 0.5, 'swim')) continue;
    const deep = gs.world.isFree(x, y, 0.6, 'deepswim');
    const level = Math.max(wl, p.ch.level - 1);
    if (deep && serpents === 0 && wl >= 3 && Math.random() < 0.22) {
      spawnEnemy(gs, 'serpent', x, y, { level });
      for (const o of gs.playersNear(p.x, p.y, 20)) if (o.sailing) gs.toast(o, 'Något enormt rör sig under vågorna…', 'boss');
      return;
    }
    const group = Math.random() < 0.3 ? 2 : 1;
    for (let g = 0; g < group; g++) {
      const gx = x + (Math.random() - 0.5) * 2;
      const gy = y + (Math.random() - 0.5) * 2;
      if (gs.world.isFree(gx, gy, 0.45, 'swim')) spawnEnemy(gs, 'shark', gx, gy, { level });
    }
    return;
  }
}

/** Keeps a lively but fair number of monsters around everyone out in the wild. */
export function spawn(gs) {
  if (gs.enemies.size >= gs.config.maxEnemies) return;
  // Never inside a clan's base (its claim, plus a margin for the group).
  const claims = gs.claims();
  const baseR2 = (gs.rules.claimRadius + 4) ** 2;
  const inBase = (x, y) => claims.some((c) => (x - c.x) ** 2 + (y - c.y) ** 2 <= baseR2);
  for (const p of gs.players.values()) {
    if (p.dead || p.asleep || inSafeZone(gs.rules, p.x, p.y)) continue;
    if (p.sailing) {
      spawnAtSea(gs, p);
      continue;
    }
    const wl = gs.world.worldLevel(p.x, p.y);
    let alive = 0;
    let others = 0;
    for (const e of gs.enemiesNear(p.x, p.y, 20)) if (!e.boss) alive++;
    for (const o of gs.playersNear(p.x, p.y, 20)) if (o !== p && !o.dead) others++;
    // Groups share the monsters around them (a bit more than alone, not double).
    const target = Math.round(Math.min(22, 5 + wl * 1.6) * (1 + others * 0.35));
    if (alive >= target) continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = p.x + Math.cos(a) * d;
      const y = p.y + Math.sin(a) * d;
      if (inSafeZone(gs.rules, x, y) || (x * x + y * y) < (gs.rules.safeRadius + 6) ** 2) continue;
      if (!gs.world.isFree(x, y, 0.45, 'enemy') || inBase(x, y)) continue;
      // Never right next to another player.
      if (gs.nearestPlayer(x, y, 10)) continue;
      const biome = gs.world.biomeAt(Math.floor(x), Math.floor(y));
      const candidates = biome.enemies.map((id) => gs.data.byId.enemies.get(id)).filter((c) => c && !c.sea);
      if (!candidates.length) break;
      let total = 0;
      for (const c of candidates) total += c.weight;
      let r = Math.random() * total;
      let def = candidates[0];
      for (const c of candidates) {
        if (r < c.weight) {
          def = c;
          break;
        }
        r -= c.weight;
      }
      const level = Math.max(gs.world.worldLevel(x, y), Math.min(p.ch.level - 1, gs.world.worldLevel(x, y) + 3));
      const [gMin, gMax] = def.group ?? [1, 3];
      const group = gMin + ((Math.random() * (gMax - gMin + 1)) | 0);
      for (let g = 0; g < group && alive + g < target; g++) {
        const gx = x + (Math.random() - 0.5) * 1.5;
        const gy = y + (Math.random() - 0.5) * 1.5;
        if (gs.world.isFree(gx, gy, 0.4, 'enemy')) spawnEnemy(gs, def.id, gx, gy, { level, biome, elite: Math.random() < 0.05 + level * 0.004 });
      }
      break;
    }
  }
}
