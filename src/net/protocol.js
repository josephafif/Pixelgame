// Multiplayer wire protocol, shared by the browser client and the Node server.
//
// High-frequency traffic is binary:
//   client → server  INPUT     the last few input frames (sent 30×/s)
//   server → client  SNAPSHOT  your authoritative state + what changed nearby
// Everything else (login, inventory, chat, clans, building, world changes,
// events) is small JSON text frames: { t: 'type', ... }.
//
// Snapshots are delta-encoded per client against what that client was last
// sent. WebSocket delivery is reliable and ordered, so "last sent" is always
// what the client has.

import { Writer, Reader } from './codec.js';

export const PROTOCOL_VERSION = 8;
export const MSG = { INPUT: 1, SNAPSHOT: 2 };

/** Entity types in snapshots. */
export const ET = { PLAYER: 1, ENEMY: 2, PROJ: 3, PICKUP: 4, AREA: 5, ALLY: 6, PAL: 7, NPC: 8 };

/**
 * Fields per entity type, all integers on the wire. Position-like fields
 * ('q') are tiles × 64 and sent as deltas; the rest are sent as values.
 */
export const FIELDS = {
  [ET.PLAYER]: ['x', 'y', 'facing', 'hp', 'maxHp', 'flags', 'anim', 'slot', 'tool', 'boat'],
  [ET.ENEMY]: ['x', 'y', 'facing', 'hp', 'maxHp', 'state', 'def', 'level', 'flags', 'element', 'anim'],
  [ET.PROJ]: ['x', 'y', 'vx', 'vy', 't0', 'sprite', 'color', 'size', 'owner', 'flags'],
  [ET.PICKUP]: ['x', 'y', 'kind', 'color', 'rarity', 'ref', 'flags'],
  [ET.AREA]: ['x', 'y', 'r', 'kind', 'color', 't0', 'dur', 'extra', 'owner', 'x2', 'y2'],
  // Clones from the Mirror ability: who they copy, and their blows.
  [ET.ALLY]: ['x', 'y', 'facing', 'owner', 'anim', 'flags'],
  // Pals: species is its index in the game data; anim/work count its bites and chops.
  [ET.PAL]: ['x', 'y', 'facing', 'owner', 'species', 'level', 'hp', 'maxHp', 'state', 'anim', 'work', 'down'],
  // People at markets: their market's cell (mx, my) and their place in its layout say who they are.
  [ET.NPC]: ['x', 'y', 'facing', 'flags', 'mx', 'my', 'idx', 'hp'],
};
const Q_FIELDS = new Set(['x', 'y', 'vx', 'vy', 'r', 'x2', 'y2']);
export const Q = 64;

/** Bit flags. */
export const PF = { MOVING: 1, SPRINT: 2, DEAD: 4, ASLEEP: 8, PROTECTED: 16, TOOL: 32, EMPTY: 64, HURT: 128, ASCEND: 256 };
export const EF = { ELITE: 1, BOSS: 2, SUBMERGED: 4, STUNNED: 8, FROZEN: 16, ALERT: 32, CLONE: 64 };
export const PRF = { ENEMY: 1, LOB: 2, MINE: 4 };
export const PKF = { LOCKED: 1, MINE: 2 };
/** Your own state flags (snapshot self block). */
export const SF = { DEAD: 1, SAFE: 2, PROTECTED: 4, NEWBIE: 8, OWN_CLAIM: 16, FOREIGN_CLAIM: 32, ASLEEP: 64, BLINK: 128, SAILING: 256 };
/** Enemy animation states. */
export const ESTATE = ['move', 'windup', 'charge', 'fade', 'cast', 'idle'];
/** Pickup kinds. */
export const PICKUP_KINDS = ['essence', 'scrap', 'wood', 'stone', 'gold', 'shard', 'heart', 'weapon', 'bag', 'egg', 'component'];
/** Pal states on the wire. */
export const PAL_STATES = ['follow', 'fight', 'gather', 'down'];
/** Projectile sprites. */
export const PROJ_SPRITES = ['orb', 'arrow', 'bolt', 'knife', 'blade', 'leafblade', 'shard', 'bullet', 'boomerang', 'chakram', 'wave', 'ball', 'spit', 'rock', 'fireball', 'bone'];
/** Area kinds. */
export const AREA_KINDS = ['telegraph', 'hazard', 'cloud', 'quake', 'ring', 'portal', 'bladering', 'timewarp', 'field', 'orbit', 'gravity'];
/**
 * An area's 'extra' field: a count (blades, orbs) in the low 4 bits, flags,
 * and how fast it spins (× 2) from bit 9.
 */
export const AF = { COUNT: 15, BIG: 16, FLOWER: 32, LAVA: 64, FOLLOW: 128, LINE: 256, SPIN_SHIFT: 9 };
/** Market people's flags. */
export const NPCF = { MOVING: 1, HURT: 2 };
/** Ally flags. */
export const ALF = { MOVING: 1 };
/** Slots on the wire. */
export const SLOTS = ['main', 'secondary', 'tool', 'none'];
/** One-shot commands carried by an input frame. */
export const CMD = { NONE: 0, SLOT_MAIN: 1, SLOT_SECONDARY: 2, SLOT_TOOL: 3, SLOT_NONE: 4, SLOT_NEXT: 5, SLOT_PREV: 6 };
/** Input buttons. */
export const BTN = { ATTACK: 1, SPRINT: 2, INTERACT: 4, ABILITY: 8 };

export const quantize = (v) => Math.round(v * Q);
export const dequantize = (n) => n / Q;
export const angleToByte = (a) => ((Math.round((a / (Math.PI * 2)) * 256) % 256) + 256) % 256;
export const byteToAngle = (b) => (b / 256) * Math.PI * 2;
export const colorToInt = (hex) => (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0xffffff);
export const intToColor = (n) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

// --- Input -------------------------------------------------------------------

/**
 * frames: [{ seq, mx, my, buttons, cmd, aim, target, view }] (oldest first).
 * mx/my are int8 (-127..127), aim a byte angle, view the server tick the
 * client was showing (lag compensation), target the locked enemy/player id.
 */
export function encodeInput(frames) {
  const w = new Writer(16 + frames.length * 16);
  w.u8(MSG.INPUT).u8(frames.length);
  for (const f of frames) {
    w.uv(f.seq).i8(f.mx).i8(f.my).u8(f.buttons).u8(f.cmd ?? 0).u8(f.aim ?? 0).uv(f.target ?? 0).uv(f.view ?? 0);
  }
  return w.finish();
}

export function decodeInput(buf) {
  const r = new Reader(buf);
  if (r.u8() !== MSG.INPUT) throw new Error('not an input');
  const n = r.u8();
  if (n < 1 || n > 8) throw new Error('bad input count');
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push({ seq: r.uv(), mx: r.i8(), my: r.i8(), buttons: r.u8(), cmd: r.u8(), aim: r.u8(), target: r.uv(), view: r.uv() });
  }
  if (r.left) throw new Error('trailing bytes');
  return frames;
}

// --- Snapshot ------------------------------------------------------------------

/**
 * Writes one snapshot. `self` is the receiver's own state; `removed` lists
 * entity ids that left their view; `entities` are { id, type, values, prev }
 * where `prev` is the last sent values (null = entering: send everything).
 */
export function encodeSnapshot({ tick, ack, self, removed, entities }) {
  const w = new Writer(512);
  w.u8(MSG.SNAPSHOT).uv(tick).uv(ack);
  // Your own state goes at full precision: the client replays its inputs
  // from exactly here, and any rounding would show up as tiny corrections.
  w.f64(self.x).f64(self.y).f64(self.kx).f64(self.ky).f64(self.speed).f64(self.sprint);
  w.uv(self.hp).uv(self.maxHp).uv(self.flags);
  w.uv(removed.length);
  for (const id of removed) w.uv(id);
  // Entities with no changes are skipped by the caller.
  w.uv(entities.length);
  for (const e of entities) {
    const fields = FIELDS[e.type];
    w.uv(e.id);
    if (!e.prev) {
      w.u8(e.type | 0x80);
      for (let i = 0; i < fields.length; i++) w.sv(e.values[i]);
      continue;
    }
    w.u8(e.type);
    let mask = 0;
    for (let i = 0; i < fields.length; i++) if (e.values[i] !== e.prev[i]) mask |= 1 << i;
    w.uv(mask);
    for (let i = 0; i < fields.length; i++) {
      if (!(mask & (1 << i))) continue;
      w.sv(Q_FIELDS.has(fields[i]) ? e.values[i] - e.prev[i] : e.values[i]);
    }
  }
  return w.finish();
}

/** True when values differ from prev (or there is no prev). */
export function changed(values, prev) {
  if (!prev) return true;
  for (let i = 0; i < values.length; i++) if (values[i] !== prev[i]) return true;
  return false;
}

/**
 * Reads a snapshot. `known` maps id → { type, values } (the client's
 * current entity states); entering/updated entities are written into it.
 */
export function decodeSnapshot(buf, known) {
  const r = new Reader(buf);
  if (r.u8() !== MSG.SNAPSHOT) throw new Error('not a snapshot');
  const tick = r.uv();
  const ack = r.uv();
  const self = {
    x: r.f64(), y: r.f64(), kx: r.f64(), ky: r.f64(), speed: r.f64(), sprint: r.f64(),
    hp: r.uv(), maxHp: r.uv(), flags: r.uv(),
  };
  const removed = [];
  for (let n = r.uv(); n > 0; n--) removed.push(r.uv());
  for (const id of removed) known.delete(id);
  const updated = [];
  for (let n = r.uv(); n > 0; n--) {
    const id = r.uv();
    const head = r.u8();
    const type = head & 0x7f;
    const fields = FIELDS[type];
    if (!fields) throw new Error(`unknown entity type ${type}`);
    if (head & 0x80) {
      const values = fields.map(() => r.sv());
      known.set(id, { type, values });
      updated.push(id);
      continue;
    }
    const ent = known.get(id);
    const mask = r.uv();
    const values = ent ? ent.values.slice() : fields.map(() => 0);
    for (let i = 0; i < fields.length; i++) {
      if (!(mask & (1 << i))) continue;
      const v = r.sv();
      values[i] = Q_FIELDS.has(fields[i]) ? values[i] + v : v;
    }
    if (ent) {
      ent.values = values;
      updated.push(id);
    }
  }
  return { tick, ack, self, removed, updated };
}

/** Reads an entity's values into a { field: number } object. */
export function fieldsOf(type, values) {
  const out = {};
  FIELDS[type].forEach((f, i) => {
    out[f] = Q_FIELDS.has(f) ? values[i] / Q : values[i];
  });
  return out;
}

export function fieldIndex(type, name) {
  return FIELDS[type].indexOf(name);
}
