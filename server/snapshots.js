// Per-client snapshots: what each player can see (interest management),
// delta-encoded against what that client already has. Positions of players
// out of view are never sent, so a hacked client can't show them.

import { CHUNK } from '../src/game/world.js';
import { TICK_RATE } from '../src/net/movement.js';
import {
  ET, PF, EF, PRF, PKF, SF, AF, ALF, NPCF, HF, WF, ESTATE, PICKUP_KINDS, PROJ_SPRITES, AREA_KINDS, SLOTS, PAL_STATES,
  encodeSnapshot, changed, quantize, angleToByte, colorToInt,
} from '../src/net/protocol.js';
import { inSafeZone, claimAt } from '../src/net/rules.js';
import * as players from './players.js';
import * as horses from './horses.js';
import { SpatialGrid } from './grid.js';

const VIEW = 30; // tiles
const FAR = 16;
const CHUNK_IN = 2; // chunks around you that you get world data for
const CHUNK_OUT = 3;
const SLOW_BUFFER = 512 * 1024;

function playerValues(gs, p, now) {
  let flags = 0;
  if (p.moving) flags |= PF.MOVING;
  if (p.sprinting) flags |= PF.SPRINT;
  if (p.dead) flags |= PF.DEAD;
  if (p.asleep) flags |= PF.ASLEEP;
  if (p.protectUntil > now || p.newbie) flags |= PF.PROTECTED;
  if (p.inv.activeSlot === 'tool') flags |= PF.TOOL;
  if (p.inv.activeSlot === 'none') flags |= PF.EMPTY;
  if (now - p.lastHurtAt < 160) flags |= PF.HURT;
  if (p.ascend?.until > gs.time) flags |= PF.ASCEND;
  if (p.leapUntil > gs.time) flags |= PF.LEAP; // a horse leaping a gap in the clouds
  if (p.dashUntil > gs.time) flags |= PF.DASH; // Gale Step
  const boat = p.sailing ? p.ch.extra.boat ?? 0 : 0;
  const horse = p.sailing ? 0 : horses.breedIndex(horses.ridingOf(p)?.breed);
  return [quantize(p.x), quantize(p.y), angleToByte(p.facing), Math.ceil(Math.max(0, p.hp)), p.maxHp, flags, p.anim, SLOTS.indexOf(p.inv.activeSlot), p.ch.pickaxe, boat, Math.max(0, horse)];
}

function enemyValues(gs, e) {
  let flags = 0;
  if (e.elite) flags |= EF.ELITE;
  if (e.boss) flags |= EF.BOSS;
  if (e.cloneOf) flags |= EF.BOSS | EF.CLONE; // the Void Herald's mirror images look like it
  if (e.submerged) flags |= EF.SUBMERGED;
  if (e.stunned) flags |= EF.STUNNED;
  if (e.statuses.freeze?.until > gs.time) flags |= EF.FROZEN;
  if (e.target) flags |= EF.ALERT;
  const state = e.castT !== undefined && gs.time - e.castT < 0.3 && e.state === 'move' ? 'cast' : e.state;
  return [quantize(e.x), quantize(e.y), e.facing >= 0 ? 0 : 1, Math.ceil(Math.max(0, e.hp)), e.maxHp, Math.max(0, ESTATE.indexOf(state)),
    e.cloneOf ? e.cloneDefIdx : e.defIdx, e.level, flags, e.elementIdx, e.anim];
}

function projValues(pr) {
  let flags = 0;
  if (pr.enemy) flags |= PRF.ENEMY; // turret shots look like arrows, as in single player
  if (pr.kind === 'lob') flags |= PRF.LOB;
  return [quantize(pr.x0), quantize(pr.y0), quantize(pr.vx), quantize(pr.vy), pr.t0, Math.max(0, PROJ_SPRITES.indexOf(pr.sprite)),
    colorToInt(pr.color), pr.size, pr.owner, flags];
}

function pickupValues(it) {
  return [quantize(it.x), quantize(it.y), Math.max(0, PICKUP_KINDS.indexOf(it.kind)), colorToInt(it.color), it.rarity ?? 0, it.ref ?? 0, 0];
}

function areaValues(gs, a) {
  let extra = Math.min(AF.COUNT, a.count ?? 0);
  if (a.big) extra |= AF.BIG;
  if (a.flower) extra |= AF.FLOWER;
  if (a.lava) extra |= AF.LAVA;
  if (a.follow) extra |= AF.FOLLOW;
  if (a.shape === 'line') extra |= AF.LINE;
  if (a.laser) extra |= AF.LASER;
  if (a.spin) extra |= Math.min(15, Math.round(a.spin * 2)) << AF.SPIN_SHIFT;
  return [quantize(a.x), quantize(a.y), quantize(a.r), Math.max(0, AREA_KINDS.indexOf(a.kind)), colorToInt(a.color), a.t0, Math.round(a.dur * TICK_RATE),
    extra, a.owner ?? 0, quantize(a.x2 ?? a.x), quantize(a.y2 ?? a.y)];
}

function palValues(gs, pal) {
  const species = Math.max(0, gs.data.pals.species.findIndex((s) => s.id === pal.species));
  const down = pal.state === 'down' ? Math.max(0, Math.ceil(pal.downUntil - gs.time)) : 0;
  return [quantize(pal.x), quantize(pal.y), pal.facing >= 0 ? 0 : 1, pal.owner, species, pal.level, Math.ceil(Math.max(0, pal.hp)), pal.stats.maxHp,
    Math.max(0, PAL_STATES.indexOf(pal.state)), pal.anim, pal.work, down];
}

function allyValues(a) {
  return [quantize(a.x), quantize(a.y), angleToByte(a.facing), a.owner, a.anim, a.moving ? ALF.MOVING : 0];
}

function selfFlags(gs, p, now, claims) {
  let f = 0;
  if (p.dead) f |= SF.DEAD;
  if (inSafeZone(gs.rules, p.x, p.y)) f |= SF.SAFE;
  if (p.protectUntil > now) f |= SF.PROTECTED;
  if (p.newbie) f |= SF.NEWBIE;
  if (gs.tick - p.blinkTick <= 1) f |= SF.BLINK;
  if (p.sailing) f |= SF.SAILING;
  else if (horses.ridingOf(p)) f |= SF.RIDING;
  const c = claimAt(gs.rules, claims, Math.floor(p.x), Math.floor(p.y));
  if (c && c.clanId === p.clanId) f |= SF.OWN_CLAIM;
  else if (c) f |= SF.FOREIGN_CLAIM;
  return f;
}

/** World data for chunks entering the player's area. */
function syncChunks(gs, p) {
  const cx = Math.floor(p.x / CHUNK);
  const cy = Math.floor(p.y / CHUNK);
  const key = `${cx},${cy}`;
  if (p.view.lastChunk === key) return;
  p.view.lastChunk = key;
  for (let y = cy - CHUNK_IN; y <= cy + CHUNK_IN; y++) {
    for (let x = cx - CHUNK_IN; x <= cx + CHUNK_IN; x++) {
      const k = `${x},${y}`;
      if (p.view.chunks.has(k)) continue;
      p.view.chunks.add(k);
      p.conn?.sendText(gs.chunkJson(x, y));
    }
  }
  for (const k of p.view.chunks) {
    const [x, y] = k.split(',').map(Number);
    if (Math.abs(x - cx) > CHUNK_OUT || Math.abs(y - cy) > CHUNK_OUT) p.view.chunks.delete(k);
  }
}

export function sendSnapshots(gs, now) {
  // Every entity's wire values, once per tick.
  const all = [];
  for (const p of gs.players.values()) all.push({ id: p.id, type: ET.PLAYER, x: p.x, y: p.y, values: playerValues(gs, p, now), ref: p });
  for (const e of gs.enemies.values()) if (!e.dead) all.push({ id: e.id, type: ET.ENEMY, x: e.x, y: e.y, values: enemyValues(gs, e), ref: e });
  for (const pr of gs.projectiles.values()) all.push({ id: pr.id, type: ET.PROJ, x: pr.x, y: pr.y, values: projValues(pr), ref: pr });
  for (const it of gs.pickups.values()) all.push({ id: it.id, type: ET.PICKUP, x: it.x, y: it.y, values: pickupValues(it), ref: it });
  for (const a of gs.areas.values()) all.push({ id: a.id, type: ET.AREA, x: a.x, y: a.y, values: areaValues(gs, a), ref: a });
  for (const a of gs.allies.values()) all.push({ id: a.id, type: ET.ALLY, x: a.x, y: a.y, values: allyValues(a), ref: a });
  for (const m of gs.markets.values()) {
    for (const n of m.npcs) {
      if (n.dead) continue;
      const flags = (n.moving ? NPCF.MOVING : 0) | (gs.time - n.hurtT < 0.15 ? NPCF.HURT : 0);
      all.push({ id: n.eid, type: ET.NPC, x: n.x, y: n.y, values: [quantize(n.x), quantize(n.y), angleToByte(n.facing), flags, m.mx, m.my, n.idx, Math.ceil(n.hp)], ref: n });
    }
  }
  for (const w of gs.workers?.values() ?? []) {
    if (w.dead) continue;
    const carry = Object.keys(w.carry)[0];
    const flags = (w.moving ? WF.MOVING : 0) | (gs.time - w.hurtT < 0.15 ? WF.HURT : 0) | (w.angry ? WF.ANGRY : 0)
      | (w.idle ? WF.IDLE : 0) | (carry === 'wood' ? WF.WOOD : carry ? WF.STONE : 0) | (w.role === 'stone' ? WF.MINER : 0);
    all.push({
      id: w.eid, type: ET.WORKER, x: w.x, y: w.y,
      values: [quantize(w.x), quantize(w.y), angleToByte(w.facing), flags, w.clanId, w.id, Math.ceil(w.hp), Math.ceil(w.maxHp), w.anim],
      ref: w,
    });
  }
  for (const h of gs.horses?.values() ?? []) {
    const flags = (h.moving ? HF.MOVING : 0) | (h.own ? HF.SADDLE : 0);
    all.push({ id: h.eid, type: ET.HORSE, x: h.x, y: h.y, values: [quantize(h.x), quantize(h.y), h.facing < 0 ? 1 : 0, horses.breedIndex(h.breed), flags, h.own ? h.owner : 0, h.own ? h.rec.id : 0], ref: h });
  }
  for (const p of gs.players.values()) {
    const pal = p.palEnt;
    if (pal && !pal.hidden) all.push({ id: pal.eid, type: ET.PAL, x: pal.x, y: pal.y, values: palValues(gs, pal), ref: pal });
  }
  // Bucketed by position: each player looks only at the cells around them.
  const grid = (gs.snapGrid ??= new SpatialGrid(16));
  grid.rebuild(all);
  const nearby = (gs.snapNearby ??= []);
  const collect = (ent) => nearby.push(ent);
  const claims = gs.claims();
  const r2 = VIEW * VIEW;
  // A tick's messages to a player (snapshot, events, world data) leave together.
  for (const p of gs.players.values()) p.conn?.cork();
  try {
    for (const p of gs.players.values()) sendTo(gs, p, now, grid, nearby, collect, claims, r2);
  } finally {
    for (const p of gs.players.values()) p.conn?.uncork();
  }
}

function sendTo(gs, p, now, grid, nearby, collect, claims, r2) {
  {
    const conn = p.conn;
    if (!conn) return;
    syncChunks(gs, p);
    if (p.meDirty) {
      p.meDirty = false;
      gs.send(p, players.mePayload(gs, p));
    }
    // A client that can't keep up gets nothing until it catches up (the
    // next snapshot is then a delta against what it really has).
    if (conn.bufferedAmount > SLOW_BUFFER) {
      conn.slowTicks = (conn.slowTicks ?? 0) + 1;
      if (conn.slowTicks > TICK_RATE * 20) conn.kick('Anslutningen är för långsam');
      p.events.length = 0;
      return;
    }
    conn.slowTicks = 0;
    const known = p.view.known;
    const seen = new Set();
    const entities = [];
    nearby.length = 0;
    grid.each(p.x, p.y, VIEW, collect);
    for (const ent of nearby) {
      if (ent.ref === p) continue;
      const dx = ent.x - p.x;
      const dy = ent.y - p.y;
      if (dx * dx + dy * dy > r2) continue;
      seen.add(ent.id);
      let values = ent.values;
      if (ent.type === ET.PICKUP) {
        const it = ent.ref;
        values = values.slice();
        values[6] = it.lockUntil > now ? (it.owner === p.id ? PKF.MINE : PKF.LOCKED) : 0;
        if (it.kind === 'weapon' && !p.view.dna.has(it.ref)) {
          if (p.view.dna.size > 400) p.view.dna.clear();
          p.view.dna.add(it.ref);
          gs.send(p, { t: 'dna', ref: it.ref, dna: it.dna });
        }
      } else if (ent.type === ET.PLAYER) {
        const other = ent.ref;
        if (p.view.pinfo.get(other.id) !== other.infoRev) {
          p.view.pinfo.set(other.id, other.infoRev);
          gs.send(p, players.infoPayload(gs, other));
        }
      }
      const prev = known.get(ent.id);
      if (prev && !changed(values, prev)) continue;
      // Far away (the edge of your screen and beyond): 10 updates a second
      // instead of 30. The client interpolates across the gap.
      if (prev && dx * dx + dy * dy > FAR * FAR && (gs.tick + ent.id) % 3 !== 0) continue;
      entities.push({ id: ent.id, type: ent.type, values, prev: prev ?? null });
      known.set(ent.id, values);
    }
    const removed = [];
    for (const id of known.keys()) {
      if (!seen.has(id)) {
        removed.push(id);
        known.delete(id);
      }
    }
    for (const id of p.view.pinfo.keys()) if (!gs.players.has(id)) p.view.pinfo.delete(id);
    const mv = players.moveParams(gs, p);
    const buf = encodeSnapshot({
      tick: gs.tick,
      ack: p.lastSeq,
      self: {
        x: p.x, y: p.y, kx: p.kx, ky: p.ky, speed: mv.speed, sprint: mv.sprint,
        hp: Math.ceil(Math.max(0, p.hp)), maxHp: p.maxHp, flags: selfFlags(gs, p, now, claims),
      },
      removed,
      entities,
    });
    conn.sendBinary(buf);
    gs.stats.sent += buf.byteLength;
    if (p.events.length) {
      gs.send(p, { t: 'ev', tick: gs.tick, list: p.events });
      p.events = [];
    }
  }
}
