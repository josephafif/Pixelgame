// Client-side mirror of what the server shows us: every entity keeps a short
// history of snapshots and is drawn ~100 ms in the past, smoothly
// interpolated between two known states (so nothing stutters even when
// packets arrive unevenly).

import {
  ET, FIELDS, Q, PF, EF, PRF, PKF, AF, ALF, NPCF, HF, WF, ESTATE, PICKUP_KINDS, PROJ_SPRITES, AREA_KINDS, SLOTS, PAL_STATES,
  byteToAngle, intToColor, WORKER_ROLE_IDS,
} from '../net/protocol.js';
import { TICK_RATE } from '../net/movement.js';
import { enemySprites, bossSprites } from '../render/sprites.js';
import { creatureSprites, hasCreature } from '../render/creatures.js';
import { mixHex } from '../weapons/visuals.js';
import { BREEDS } from '../game/horses.js';

const IDX = Object.fromEntries(Object.entries(FIELDS).map(([type, list]) => [type, Object.fromEntries(list.map((f, i) => [f, i]))]));
const KEEP_TICKS = 40;

export class EntityStore {
  constructor() {
    this.ents = new Map();
  }

  /** New values for an entity at server tick `tick`. */
  push(id, type, values, tick) {
    let ent = this.ents.get(id);
    if (!ent || ent.type !== type) {
      ent = { id, type, samples: [], obj: null, born: tick };
      this.ents.set(id, ent);
    }
    const s = ent.samples;
    const last = s[s.length - 1];
    // A long gap means it stood still (nothing to send): hold the old state
    // until just before this one, so a stop-and-go isn't smeared out. Short
    // gaps are far-away entities sent 10×/s: interpolate straight across.
    if (last && tick - last.tick > 3) s.push({ tick: tick - 1, v: last.v });
    s.push({ tick, v: values.slice() });
    if (s.length > 64) s.splice(0, s.length - 64);
  }

  remove(id) {
    this.ents.delete(id);
  }

  clear() {
    this.ents.clear();
  }

  /**
   * Values at render tick `rt`: positions interpolated, everything else
   * from the latest sample at or before `rt`.
   */
  static sample(ent, rt) {
    const s = ent.samples;
    let i = s.length - 1;
    while (i > 0 && s[i].tick > rt) i--;
    const a = s[i];
    const b = s[i + 1];
    // Trim history we will never look at again.
    if (i > 2 && a.tick < rt - KEEP_TICKS) s.splice(0, i - 1);
    if (!b || a.tick > rt) return { v: a.v, x: a.v[0] / Q, y: a.v[1] / Q };
    const k = (rt - a.tick) / (b.tick - a.tick);
    return {
      v: a.v,
      x: (a.v[0] + (b.v[0] - a.v[0]) * k) / Q,
      y: (a.v[1] + (b.v[1] - a.v[1]) * k) / Q,
    };
  }
}

export function field(type, values, name) {
  return values[IDX[type][name]];
}

// --- Render objects (shaped like the single-player entities the renderer knows) ---

const spriteCache = new Map();

/** Monster colour and sprites, exactly as the single-player game makes them. */
export function enemyLook(data, defIdx, elementIdx, boss) {
  const key = `${boss ? 'b' : 'e'}${defIdx}:${elementIdx}`;
  let look = spriteCache.get(key);
  if (look) return look;
  if (boss) {
    const def = data.bosses[defIdx];
    look = { def, color: def.color, sprites: bossSprites(def.id, def.color) };
  } else {
    const def = data.enemies[defIdx];
    const el = data.elements[elementIdx]?.id ?? 'physical';
    const elColor = el !== 'physical' ? data.byId.elements.get(el)?.palette?.[1] : null;
    const color = !elColor ? def.color : def.elemental ? elColor : mixHex(def.color, elColor, 0.55);
    look = { def, color, sprites: hasCreature(def.id) ? creatureSprites(def.id, color) : enemySprites(def.id, color) };
  }
  spriteCache.set(key, look);
  return look;
}

export function makeEnemy(data, v, time) {
  const f = (n) => field(ET.ENEMY, v, n);
  const flags = f('flags');
  const boss = Boolean(flags & EF.BOSS);
  const look = enemyLook(data, f('def'), f('element'), boss);
  const def = look.def;
  const elite = Boolean(flags & EF.ELITE);
  return {
    id: 0,
    kind: def.id,
    def,
    bossDef: boss ? def : null,
    boss,
    clone: Boolean(flags & EF.CLONE), // the Void Herald's mirror images
    elite,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: boss ? def.size * 0.5 : def.size * 0.45 * (elite ? 1.3 : 1),
    hp: f('hp'),
    maxHp: f('maxHp'),
    level: f('level'),
    element: data.elements[f('element')]?.id ?? 'physical',
    color: look.color,
    sprites: look.sprites,
    facing: 1,
    state: 'move',
    stateT: 0,
    phase: Math.random() * 10,
    flash: 0,
    scale: elite ? 1.3 : 1,
    squash: 0,
    anim: f('anim'),
    dead: false,
    status: {},
    trail: def.id === 'serpent' ? [] : null, // a serpent's body follows where its head has been
    trailT: 0,
    seenAt: time,
  };
}

export function updateEnemy(o, v, x, y, dt, time) {
  const f = (n) => field(ET.ENEMY, v, n);
  // Velocity from the server's positions (o.x/o.y may be nudged for drawing).
  if (dt > 0) {
    o.vx = o.vx * 0.6 + ((x - (o.sx ?? x)) / dt) * 0.4;
    o.vy = o.vy * 0.6 + ((y - (o.sy ?? y)) / dt) * 0.4;
  }
  o.sx = x;
  o.sy = y;
  o.x = x;
  o.y = y;
  if (o.trail) {
    o.trailT -= dt;
    if (o.trailT <= 0) {
      o.trailT = 0.05;
      o.trail.unshift({ x, y });
      if (o.trail.length > 30) o.trail.pop();
    }
  }
  const hp = f('hp');
  if (hp < o.hp) {
    o.flash = 0.08;
    o.squash = 1;
  }
  o.hp = hp;
  o.maxHp = f('maxHp');
  o.facing = f('facing') ? -1 : 1;
  const state = ESTATE[f('state')] ?? 'move';
  if (state !== o.state) o.stateT = 0;
  o.state = state === 'cast' ? 'move' : state;
  if (f('anim') !== o.anim) {
    o.anim = f('anim');
    o.castT = time;
  }
  const flags = f('flags');
  o.stunned = Boolean(flags & EF.STUNNED);
  o.frozen = Boolean(flags & EF.FROZEN);
  o.tint = o.frozen ? '#dff6ff' : null;
  o.submerged = Boolean(flags & EF.SUBMERGED);
  o.alert = Boolean(flags & EF.ALERT);
  o.stateT += dt;
  o.flash = Math.max(0, o.flash - dt);
  o.squash = Math.max(0, (o.squash ?? 0) - dt * 7);
}

export function readPlayer(v) {
  const f = (n) => field(ET.PLAYER, v, n);
  const flags = f('flags');
  return {
    facing: byteToAngle(f('facing')),
    hp: f('hp'),
    maxHp: f('maxHp'),
    moving: Boolean(flags & PF.MOVING),
    sprinting: Boolean(flags & PF.SPRINT),
    dead: Boolean(flags & PF.DEAD),
    asleep: Boolean(flags & PF.ASLEEP),
    protected: Boolean(flags & PF.PROTECTED),
    hurt: Boolean(flags & PF.HURT),
    ascending: Boolean(flags & PF.ASCEND),
    leaping: Boolean(flags & PF.LEAP),
    dashing: Boolean(flags & PF.DASH),
    boat: f('boat') ?? 0, // the boat tier while sailing (0 on land)
    horse: BREEDS[(f('horse') ?? 0) - 1]?.id ?? null, // the breed you ride
    anim: f('anim'),
    slot: SLOTS[f('slot')] ?? 'main',
    pickaxe: f('tool'),
  };
}

export function readProjectile(v, rt) {
  const f = (n) => field(ET.PROJ, v, n);
  const t = (rt - f('t0')) / TICK_RATE;
  const vx = f('vx') / Q;
  const vy = f('vy') / Q;
  const flags = f('flags');
  return {
    x: f('x') / Q + vx * t,
    y: f('y') / Q + vy * t,
    vx,
    vy,
    t,
    owner: flags & PRF.ENEMY ? 'enemy' : 'player',
    ownerId: f('owner'),
    lob: Boolean(flags & PRF.LOB),
    sprite: PROJ_SPRITES[f('sprite')] ?? 'orb',
    color: intToColor(f('color')),
    size: f('size'),
    spin: t * 18,
  };
}

export function readPickup(v) {
  const f = (n) => field(ET.PICKUP, v, n);
  const flags = f('flags');
  return {
    kind: PICKUP_KINDS[f('kind')] ?? 'essence',
    color: intToColor(f('color')),
    rarity: f('rarity'),
    ref: f('ref'),
    locked: Boolean(flags & PKF.LOCKED),
    mine: Boolean(flags & PKF.MINE),
  };
}

/** An area at render tick `rt`; (x, y) is its (interpolated) position. */
export function readArea(v, rt, x = field(ET.AREA, v, 'x') / Q, y = field(ET.AREA, v, 'y') / Q) {
  const f = (n) => field(ET.AREA, v, n);
  const extra = f('extra') ?? 0;
  return {
    kind: AREA_KINDS[f('kind')] ?? 'telegraph',
    x,
    y,
    r: f('r') / Q,
    color: intToColor(f('color')),
    t: (rt - f('t0')) / TICK_RATE,
    dur: f('dur') / TICK_RATE,
    count: extra & AF.COUNT,
    big: Boolean(extra & AF.BIG),
    flower: Boolean(extra & AF.FLOWER),
    lava: Boolean(extra & AF.LAVA),
    follow: Boolean(extra & AF.FOLLOW),
    shape: extra & AF.LINE ? 'line' : 'circle',
    laser: Boolean(extra & AF.LASER),
    spin: (extra >> AF.SPIN_SHIFT) / 2 || undefined,
    owner: f('owner') ?? 0,
    x2: (f('x2') ?? 0) / Q,
    y2: (f('y2') ?? 0) / Q,
  };
}

/** A pal (species by its index in the game data). */
export function readPal(v, data) {
  const f = (n) => field(ET.PAL, v, n);
  return {
    owner: f('owner'),
    species: data.pals.species[f('species')]?.id ?? data.pals.species[0].id,
    level: f('level'),
    hp: f('hp'),
    maxHp: f('maxHp'),
    state: PAL_STATES[f('state')] ?? 'follow',
    anim: f('anim'),
    work: f('work'),
    down: f('down'),
    facing: f('facing') ? -1 : 1,
  };
}

/** A horse (wild, or someone's: owner is their player id, ref the horse's id in their stable). */
export function readHorse(v) {
  const f = (n) => field(ET.HORSE, v, n);
  const flags = f('flags');
  return {
    facing: f('facing') ? Math.PI : 0, breed: BREEDS[f('breed') - 1]?.id ?? BREEDS[0].id,
    moving: Boolean(flags & HF.MOVING), saddle: Boolean(flags & HF.SADDLE), owner: f('owner'), ref: f('ref'),
  };
}

/** A clan's worker. */
export function readWorker(v) {
  const f = (n) => field(ET.WORKER, v, n);
  const flags = f('flags');
  return {
    facing: byteToAngle(f('facing')), moving: Boolean(flags & WF.MOVING), hurt: Boolean(flags & WF.HURT),
    angry: Boolean(flags & WF.ANGRY), idle: Boolean(flags & WF.IDLE),
    carrying: flags & WF.WOOD ? 'wood' : flags & WF.STONE ? 'stone' : null,
    role: WORKER_ROLE_IDS[f('role')] ?? (flags & WF.MINER ? 'stone' : 'wood'),
    clan: f('clan'), wid: f('wid'), hp: f('hp'), maxHp: f('maxHp'), anim: f('anim'),
  };
}

/** A person at a market. */
export function readNpc(v) {
  const f = (n) => field(ET.NPC, v, n);
  const flags = f('flags');
  return {
    facing: byteToAngle(f('facing')), moving: Boolean(flags & NPCF.MOVING), hurt: Boolean(flags & NPCF.HURT),
    mx: f('mx'), my: f('my'), idx: f('idx'), hp: f('hp'),
  };
}

/** A clone (Mirror ability). */
export function readAlly(v) {
  const f = (n) => field(ET.ALLY, v, n);
  return { facing: byteToAngle(f('facing')), owner: f('owner'), anim: f('anim'), moving: Boolean(f('flags') & ALF.MOVING) };
}
