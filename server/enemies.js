// Monsters and bosses on the server: spawning around players, simple
// readable behaviours (chase, charge, shoot, cast, swoop, blink) and boss
// attack patterns that every player near the altar fights together.

import { moveMode } from '../src/game/enemies.js';
import { inSafeZone } from '../src/net/rules.js';
import { mixHex } from '../src/weapons/visuals.js';
import * as combat from './combat.js';

const LEASH = 1.8;
const DESPAWN_DIST = 42;
const SPAWN_MIN = 13;
const SPAWN_MAX = 18;

function scaleFor(level) {
  return { hp: 1 + 0.3 * (level - 1), dmg: 1 + 0.14 * (level - 1) };
}

export function spawnEnemy(gs, defId, x, y, { level = 1, elite = false, biome = null } = {}) {
  const data = gs.data;
  const def = data.byId.enemies.get(defId);
  if (!def || def.sea) return null;
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
    anchorX: x,
    anchorY: y,
    altarKey,
    lonely: 0,
  };
  gs.enemies.set(boss.id, boss);
  return boss;
}

// --- Statuses ---------------------------------------------------------------------------

export function applyStatus(gs, e, id, sourceDamage, attacker) {
  const def = gs.data.statuses[id];
  if (!def || e.dead) return;
  const until = gs.time + (def.duration ?? 2);
  if (def.dotPct) {
    const dps = (sourceDamage * def.dotPct) / 100;
    const cur = e.statuses[id];
    e.statuses[id] = { until, dps: Math.max(cur?.until > gs.time ? cur.dps : 0, dps), from: attacker?.id ?? 0 };
  } else if (id === 'chill') {
    const stacks = (e.statuses.chill?.until > gs.time ? e.statuses.chill.stacks : 0) + 1;
    e.statuses.chill = { until, stacks };
    if (!e.boss && stacks >= (def.freezeAt ?? 3)) {
      e.statuses.freeze = { until: gs.time + (gs.data.statuses.freeze?.duration ?? 1.2) };
      e.statuses.chill.stacks = 0;
    }
  } else if (id === 'stagger' && !e.boss) {
    e.statuses.freeze = { until: gs.time + (def.duration ?? 0.5) };
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
    dot += st.dps;
    from = st.from || from;
  }
  e.slowMult = s.chill?.until > gs.time ? 0.6 : 1;
  e.stunned = s.freeze?.until > gs.time;
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
  if (t && (t.dead || inSafeZone(gs.rules, t.x, t.y))) t = null;
  if (t) {
    const d2 = (t.x - e.x) ** 2 + (t.y - e.y) ** 2;
    const leash = sight * LEASH;
    if (d2 > leash * leash && e.alertUntil < gs.time) t = null;
  }
  if (!t) t = gs.nearestPlayer(e.x, e.y, sight, (p) => !inSafeZone(gs.rules, p.x, p.y));
  e.target = t?.id ?? 0;
  return t;
}

function contact(gs, e, p, mult = 1) {
  if (!p || p.dead || e.atkCd > 0) return;
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

// --- Bosses ------------------------------------------------------------------------------------

const BOSS_MOVES = {
  ring: 'ring', icering: 'ring', orbs: 'ring', spiral: 'spiral', bonefan: 'fan', sandspit: 'fan', spores: 'ring',
  breath: 'fan', wave: 'fan', charge: 'charge', dash: 'charge', burrow: 'charge', slam: 'slam', quake: 'slam',
  roots: 'meteors', spikes: 'meteors', geysers: 'meteors', strikes: 'meteors', meteors: 'meteors', gravity: 'slam',
  curse: 'meteors', whirlpool: 'slam', reroot: 'slam', summon: 'summon', raise: 'summon', clones: 'summon',
  blink: 'blink', chain: 'chain',
};

function bossMove(gs, b, p) {
  const def = b.def;
  const name = def.patterns[b.patternIdx % def.patterns.length];
  b.patternIdx++;
  const move = BOSS_MOVES[name] ?? 'ring';
  const glow = gs.data.byId.elements.get(b.element)?.glow ?? b.color;
  const enraged = b.phase === 2;
  b.anim = (b.anim + 1) & 255;
  b.castT = gs.time;
  switch (move) {
    case 'ring':
    case 'spiral': {
      const n = enraged ? 18 : 12;
      const twist = move === 'spiral' ? gs.time : 0;
      for (let i = 0; i < n; i++) {
        combat.spawnProjectile(gs, {
          x: b.x, y: b.y, angle: (i / n) * Math.PI * 2 + twist, speed: 5.5, damage: b.dmg * 0.7, range: 14,
          element: b.element, sprite: 'orb', size: 4, enemy: b.id, color: glow,
        });
      }
      break;
    }
    case 'fan': {
      const base = Math.atan2(p.y - b.y, p.x - b.x);
      const n = enraged ? 9 : 7;
      for (let i = 0; i < n; i++) {
        combat.spawnProjectile(gs, {
          x: b.x, y: b.y, angle: base + (i / (n - 1) - 0.5) * 1.1, speed: 7, damage: b.dmg * 0.75, range: 13,
          element: b.element, sprite: 'orb', size: 3, enemy: b.id, color: glow,
        });
      }
      break;
    }
    case 'charge': {
      b.state = 'windup';
      b.stateT = 0;
      const d = Math.sqrt((p.x - b.x) ** 2 + (p.y - b.y) ** 2) || 1;
      b.chargeX = (p.x - b.x) / d;
      b.chargeY = (p.y - b.y) / d;
      break;
    }
    case 'slam':
      combat.spawnArea(gs, { x: b.x, y: b.y, r: b.r + 3, kind: 'telegraph', dur: 1.1, color: glow, damage: b.dmg * 1.3, element: b.element });
      break;
    case 'meteors': {
      const targets = [...gs.playersNear(b.x, b.y, 22)].filter((o) => !o.dead).slice(0, 6);
      for (const o of targets) {
        for (let k = 0; k < (enraged ? 3 : 2); k++) {
          const jx = k ? (Math.random() - 0.5) * 4 : 0;
          const jy = k ? (Math.random() - 0.5) * 4 : 0;
          combat.spawnArea(gs, { x: o.x + o.kx * 0.2 + jx, y: o.y + jy, r: 1.6, kind: 'telegraph', dur: 1, color: glow, damage: b.dmg, element: b.element });
        }
      }
      break;
    }
    case 'summon': {
      const biome = gs.world.biomeAt(Math.floor(b.x), Math.floor(b.y));
      const ids = biome.enemies.filter((id) => !gs.data.byId.enemies.get(id)?.sea);
      for (let i = 0; i < (enraged ? 4 : 3); i++) {
        const a = Math.random() * Math.PI * 2;
        const x = b.x + Math.cos(a) * (b.r + 1.5);
        const y = b.y + Math.sin(a) * (b.r + 1.5);
        if (!ids.length || !gs.world.isFree(x, y, 0.4, 'enemy')) continue;
        const e = spawnEnemy(gs, ids[(Math.random() * ids.length) | 0], x, y, { level: Math.max(1, b.level - 2), biome });
        if (e) {
          e.target = p.id;
          e.alertUntil = gs.time + 30;
          e.minion = true;
        }
      }
      break;
    }
    case 'blink': {
      const a = Math.random() * Math.PI * 2;
      b.x = p.x + Math.cos(a) * 4;
      b.y = p.y + Math.sin(a) * 4;
      gs.event(b.x, b.y, { k: 'fx', fx: 'blink', x: b.x, y: b.y, color: glow });
      break;
    }
    case 'chain': {
      const targets = [...gs.playersNear(b.x, b.y, 12)].filter((o) => !o.dead).slice(0, 3);
      const points = [[b.x, b.y]];
      for (const o of targets) {
        points.push([o.x, o.y]);
        combat.hurtPlayer(gs, o, b.dmg * 0.6, { element: b.element, fromX: b.x, fromY: b.y });
      }
      gs.event(b.x, b.y, { k: 'fx', fx: 'chain', points, color: glow });
      break;
    }
    default:
      break;
  }
}

function updateBoss(gs, b, dt) {
  const p = pickTargetBoss(gs, b);
  if (b.phase === 1 && b.hp < b.maxHp * 0.5) {
    b.phase = 2;
    gs.event(b.x, b.y, { k: 'boss', id: b.id, name: b.def.name, active: true, enraged: true }, 60);
  }
  if (!p) {
    b.vx = b.vy = 0;
    return;
  }
  b.stateT += dt;
  if (b.state === 'windup') {
    b.vx = b.vy = 0;
    if (b.stateT > 0.7) {
      b.state = 'charge';
      b.stateT = 0;
    }
  } else if (b.state === 'charge') {
    b.vx = b.chargeX * b.speed * 4.5;
    b.vy = b.chargeY * b.speed * 4.5;
    if (b.stateT > 0.8) {
      b.state = 'move';
      b.stateT = 0;
    }
  } else {
    // Stay near the altar while fighting.
    const home = (b.x - b.anchorX) ** 2 + (b.y - b.anchorY) ** 2 > 18 * 18;
    goToward(gs, b, home ? b.anchorX : p.x, home ? b.anchorY : p.y, b.speed * (b.phase === 2 ? 1.2 : 1) * (b.slowMult ?? 1));
  }
  b.patternCd -= dt;
  if (b.patternCd <= 0 && b.state === 'move') {
    b.patternCd = (b.phase === 2 ? 2.1 : 3) + Math.random() * 0.8;
    bossMove(gs, b, p);
  }
  for (const o of gs.playersNear(b.x, b.y, b.r + 1)) {
    if (o.dead || (o.bossHitAt ?? 0) > gs.time) continue;
    if ((o.x - b.x) ** 2 + (o.y - b.y) ** 2 < (b.r + o.r) ** 2) {
      o.bossHitAt = gs.time + 0.8;
      combat.hurtPlayer(gs, o, b.dmg * (b.state === 'charge' ? 1.6 : 1), { element: b.element, fromX: b.x, fromY: b.y, knock: 8 });
    }
  }
}

function pickTargetBoss(gs, b) {
  let t = b.target ? gs.players.get(b.target) : null;
  if (!t || t.dead || (t.x - b.x) ** 2 + (t.y - b.y) ** 2 > 30 * 30 || Math.random() < 0.004) {
    t = gs.nearestPlayer(b.x, b.y, 30);
  }
  b.target = t?.id ?? 0;
  return t;
}

// --- Update + spawning --------------------------------------------------------------------------

export function update(gs, dt) {
  for (const e of gs.enemies.values()) {
    if (e.dead) {
      gs.enemies.delete(e.id);
      continue;
    }
    tickStatuses(gs, e, dt);
    if (e.dead) continue;
    if (e.stunned) {
      e.vx = e.vy = 0;
    } else if (e.boss) {
      updateBoss(gs, e, dt);
    } else {
      behave(gs, e, dt);
    }
    moveEnemy(gs, e, e.vx + e.kx, e.vy + e.ky, dt);
    const damp = 0.74; // exp(-9 / 30)
    e.kx *= damp;
    e.ky *= damp;
    // Nobody around: wander off the map (bosses go home after a while).
    const near = gs.nearestPlayer(e.x, e.y, e.boss ? 45 : DESPAWN_DIST);
    e.lonely = near ? 0 : e.lonely + dt;
    if (e.lonely > (e.boss ? 20 : 8)) {
      gs.enemies.delete(e.id);
      if (e.boss) gs.event(e.x, e.y, { k: 'boss', id: e.id, active: false, victory: false }, 80);
    }
  }
  separate(gs);
}

/** Light separation so crowds don't merge into one sprite. */
function separate(gs) {
  const cells = new Map();
  for (const e of gs.enemies.values()) {
    if (e.dead) continue;
    const key = (Math.floor(e.x / 2) * 73856093) ^ (Math.floor(e.y / 2) * 19349663);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(e);
  }
  for (const list of cells.values()) {
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
        const nudge = (e, px, py) => {
          if (e.boss || gs.world.isFree(e.x + px, e.y + py, Math.min(e.r, 0.45), moveMode(e))) {
            e.x += px;
            e.y += py;
          }
        };
        nudge(a, -(dx / d) * push * wa * 2, -(dy / d) * push * wa * 2);
        nudge(b, (dx / d) * push * (1 - wa) * 2, (dy / d) * push * (1 - wa) * 2);
      }
    }
  }
}

/** Keeps a lively but fair number of monsters around everyone out in the wild. */
export function spawn(gs) {
  if (gs.enemies.size >= gs.config.maxEnemies) return;
  for (const p of gs.players.values()) {
    if (p.dead || p.asleep || inSafeZone(gs.rules, p.x, p.y)) continue;
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
      if (!gs.world.isFree(x, y, 0.45, 'enemy')) continue;
      // Never right next to another player (or inside a base's walls).
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
