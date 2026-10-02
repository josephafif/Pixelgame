// Per-client snapshots: what each player can see (interest management),
// delta-encoded against what that client already has. Positions of players
// out of view are never sent, so a hacked client can't show them.

import { CHUNK } from '../src/game/world.js';
import { TICK_RATE } from '../src/net/movement.js';
import {
  ET, PF, EF, PRF, PKF, SF, ESTATE, PICKUP_KINDS, PROJ_SPRITES, AREA_KINDS, SLOTS,
  encodeSnapshot, changed, quantize, angleToByte, colorToInt,
} from '../src/net/protocol.js';
import { inSafeZone, claimAt } from '../src/net/rules.js';
import * as players from './players.js';

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
  return [quantize(p.x), quantize(p.y), angleToByte(p.facing), Math.ceil(Math.max(0, p.hp)), p.maxHp, flags, p.anim, SLOTS.indexOf(p.inv.activeSlot), p.ch.pickaxe];
}

function enemyValues(gs, e) {
  let flags = 0;
  if (e.elite) flags |= EF.ELITE;
  if (e.boss) flags |= EF.BOSS;
  if (e.submerged) flags |= EF.SUBMERGED;
  if (e.stunned) flags |= EF.STUNNED;
  if (e.statuses.freeze?.until > gs.time) flags |= EF.FROZEN;
  if (e.target) flags |= EF.ALERT;
  const state = e.castT !== undefined && gs.time - e.castT < 0.3 && e.state === 'move' ? 'cast' : e.state;
  return [quantize(e.x), quantize(e.y), e.facing >= 0 ? 0 : 1, Math.ceil(Math.max(0, e.hp)), e.maxHp, Math.max(0, ESTATE.indexOf(state)),
    e.defIdx, e.level, flags, e.elementIdx, e.anim];
}

function projValues(pr) {
  let flags = 0;
  if (pr.enemy || pr.turret) flags |= PRF.ENEMY;
  if (pr.kind === 'lob') flags |= PRF.LOB;
  return [quantize(pr.x0), quantize(pr.y0), quantize(pr.vx), quantize(pr.vy), pr.t0, Math.max(0, PROJ_SPRITES.indexOf(pr.sprite)),
    colorToInt(pr.color), pr.size, pr.owner, flags];
}

function pickupValues(it) {
  return [quantize(it.x), quantize(it.y), Math.max(0, PICKUP_KINDS.indexOf(it.kind)), colorToInt(it.color), it.rarity ?? 0, it.ref ?? 0, 0];
}

function areaValues(gs, a) {
  return [quantize(a.x), quantize(a.y), quantize(a.r), Math.max(0, AREA_KINDS.indexOf(a.kind)), colorToInt(a.color), a.t0, Math.round(a.dur * TICK_RATE)];
}

function selfFlags(gs, p, now, claims) {
  let f = 0;
  if (p.dead) f |= SF.DEAD;
  if (inSafeZone(gs.rules, p.x, p.y)) f |= SF.SAFE;
  if (p.protectUntil > now) f |= SF.PROTECTED;
  if (p.newbie) f |= SF.NEWBIE;
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
      gs.send(p, gs.chunkPayload(x, y));
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
  const claims = gs.claims();
  const r2 = VIEW * VIEW;
  for (const p of gs.players.values()) {
    const conn = p.conn;
    if (!conn) continue;
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
      continue;
    }
    conn.slowTicks = 0;
    const known = p.view.known;
    const seen = new Set();
    const entities = [];
    for (const ent of all) {
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
    const buf = encodeSnapshot({
      tick: gs.tick,
      ack: p.lastSeq,
      self: {
        x: p.x, y: p.y, kx: p.kx, ky: p.ky, speed: p.speed, sprint: gs.data.player.sprintMultiplier,
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
