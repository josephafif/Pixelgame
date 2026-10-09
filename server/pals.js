// Pals in multiplayer: the same companions as single player
// (src/game/pals.js). Eggs drop from bosses and elite monsters, hatch in
// your clan's Pal Den (a building in your base) and grow with essence and
// materials; the pal that walks with you fights, gathers or just tags along,
// run by the server so everyone sees it. A pal's growth is capped by the
// Den's level, as in single player.
//
// The pals live in the character (ch.extra.pals), in single player's shape,
// so the same rules (src/game/pals.js) decide prices and limits.

import {
  palStats, palSpecies, findPal, activePal, addEgg, rollEgg, startHatch, hatchReady, upgradePal, PAL_MODES,
} from '../src/game/pals.js';
import { harvestInfo } from '../src/game/gathering.js';
import { mpPalSave } from '../src/net/mpsave.js';
import { damageEnemy } from './combat.js';
import { applyStatus } from './enemies.js';
import * as players from './players.js';
import * as loot from './loot.js';
import * as base from './base.js';

const TELEPORT_DIST = 14;
const HELP_RADIUS = 7;
const GATHER_RADIUS = 6;
const RETHINK = 0.3;
const HATCH_CHECK_TICKS = 30;

/** The character's pals in single player's save shape (for the shared rules). */
export function palSave(gs, p) {
  return mpPalSave(gs.data, p.ch, base.levelsFor(gs, p));
}

// --- Requests -------------------------------------------------------------------------

/** { t: 'pal', op: 'hatch'|'upgrade'|'active'|'mode', id?, mode? } → problem text or null. */
export function request(gs, p, msg) {
  const save = palSave(gs, p);
  try {
    switch (msg.op) {
      case 'hatch': {
        startHatch(gs.data, save, String(msg.id ?? ''));
        gs.toast(p, `Ägget värms i Pal Den: det kläcks om ${Math.round(gs.data.pals.hatchSeconds)} s (även om du är borta).`);
        break;
      }
      case 'upgrade': {
        const level = upgradePal(gs.data, save, String(msg.id ?? ''));
        const pal = findPal(save, msg.id);
        gs.toast(p, `${pal.name} växte till nivå ${level}!`, 'level');
        if (p.palEnt?.id === pal.id) gs.event(p.palEnt.x, p.palEnt.y, { k: 'fx', fx: 'holy', x: p.palEnt.x, y: p.palEnt.y }, 24);
        break;
      }
      case 'active': {
        const id = msg.id ? String(msg.id) : null;
        if (id && !findPal(save, id)) return 'Ingen sådan pal';
        save.pals.active = id;
        break;
      }
      case 'mode':
        if (!PAL_MODES.includes(msg.mode)) return 'Okänt läge';
        save.pals.mode = msg.mode;
        if (p.palEnt) p.palEnt.think = 0;
        break;
      default:
        return 'Okänd begäran';
    }
  } catch (err) {
    return err.message;
  }
  sync(gs, p);
  players.markMe(p);
  players.persist(gs, p);
  return null;
}

// --- Eggs --------------------------------------------------------------------------------

/** Rolls for an egg (source: 'bossFirst', 'boss', 'elite', 'serpent', 'treasure') dropped for `p`. */
export function dropEgg(gs, p, source, x, y) {
  const species = rollEgg(gs.data, source);
  if (!species) return false;
  const sp = palSpecies(gs.data, species);
  loot.addPickup(gs, 'egg', x, y, { species, color: sp?.color ?? '#9cf07a', owner: p.id, lockUntil: Date.now() + 60000 });
  gs.event(x, y, { k: 'fx', fx: 'chest', x, y }, 30);
  return true;
}

/** Picking up an egg. */
export function collectEgg(gs, p, it) {
  const save = palSave(gs, p);
  addEgg(gs.data, save, it.species);
  gs.toast(p, save.base.buildings.den
    ? 'Ett Pal-ägg! Värm det i Pal Den (Pals-panelen, H) så kläcks det.'
    : 'Ett Pal-ägg! Bygg ett djurhus i er klans bas (Bygg-menyn) för att kläcka det.', 'legendary');
  gs.event(p.x, p.y, { k: 'pick', id: p.id, kind: 'egg' }, 12);
  players.markMe(p);
  players.persist(gs, p);
}

/** Hatches the character's eggs whose time has come (even while offline). */
function checkHatch(gs, p) {
  const save = palSave(gs, p);
  if (!save.pals.eggs.some((e) => e.hatchAt && e.hatchAt <= Date.now())) return;
  for (const pal of hatchReady(gs.data, save)) {
    const sp = palSpecies(gs.data, pal.species);
    gs.toast(p, `Ägget kläcktes: ${pal.name}, en ${({ Gatherer: 'samlare', Fighter: 'kämpe', 'All-rounder': 'allkonstnär' })[sp?.role] ?? 'pal'}!`, 'legendary');
    gs.send(p, { t: 'pal-born', id: pal.id, species: pal.species, name: pal.name });
  }
  sync(gs, p);
  players.markMe(p);
  players.persist(gs, p);
}

// --- The pal in the world --------------------------------------------------------------------

/** Creates, updates or removes the player's walking pal to match their save. */
export function sync(gs, p) {
  const save = palSave(gs, p);
  const pal = activePal(save);
  if (!pal || p.asleep) {
    p.palEnt = null;
    return;
  }
  const stats = palStats(gs.data, pal.species, pal.level);
  const cur = p.palEnt;
  if (cur && cur.id === pal.id) {
    cur.hp = Math.min(stats.maxHp, cur.hp + Math.max(0, stats.maxHp - cur.stats.maxHp));
    cur.stats = stats;
    cur.level = pal.level;
    return;
  }
  const spot = gs.world.findFreeSpot(p.x - 1, p.y + 0.5, 0.3, 'pal', null) ?? { x: p.x, y: p.y };
  p.palEnt = {
    eid: gs.newId(), id: pal.id, species: pal.species, level: pal.level, stats, owner: p.id,
    x: spot.x, y: spot.y, vx: 0, vy: 0, r: 0.3, hp: stats.maxHp, skip: new Map(),
    facing: 1, state: 'follow', target: null, tile: null, cd: 0.5, think: 0,
    anim: 0, work: 0, hurtCd: 0, downUntil: 0, stuckT: 0, detour: 0,
  };
}

function place(gs, p, pal) {
  for (const [dx, dy] of [[-1.2, 0.6], [1.2, 0.6], [0, 1.3], [-1, -1], [1, -1]]) {
    if (gs.world.isFree(p.x + dx, p.y + dy, pal.r, 'pal')) {
      pal.x = p.x + dx;
      pal.y = p.y + dy;
      return;
    }
  }
  pal.x = p.x;
  pal.y = p.y;
}

function nearestEnemy(gs, p, pal) {
  let best = null;
  let bestD = Infinity;
  const mine = p.lastTarget ? gs.enemies.get(p.lastTarget) : null;
  for (const e of gs.enemiesNear(p.x, p.y, HELP_RADIUS)) {
    if (e.dead || e.submerged || e.def?.sea) continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) > HELP_RADIUS) continue;
    // Prefer whatever you are fighting.
    const d = Math.hypot(e.x - pal.x, e.y - pal.y) - (e === mine ? 3 : 0) - (e.target ? 1 : 0);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function nearestHarvest(gs, p, pal) {
  const w = gs.world;
  let best = null;
  let bestD = Infinity;
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  for (let ty = py - GATHER_RADIUS; ty <= py + GATHER_RADIUS; ty++) {
    for (let tx = px - GATHER_RADIUS; tx <= px + GATHER_RADIUS; tx++) {
      const id = w.blockAt(tx, ty);
      if (!id) continue;
      const info = harvestInfo(gs.data, id);
      if (!info || info.tier > pal.stats.gatherTier) continue;
      if ((pal.skip.get(`${tx},${ty}`) ?? 0) > gs.time) continue;
      const d = Math.hypot(tx + 0.5 - pal.x, ty + 0.5 - pal.y) + Math.hypot(tx + 0.5 - p.x, ty + 0.5 - p.y) * 0.5;
      if (d < bestD) {
        bestD = d;
        best = { tx, ty, x: tx + 0.5, y: ty + 0.5, info };
      }
    }
  }
  return best;
}

/** Walks towards a point, sliding around trees, rocks and water. */
function walk(gs, pal, tx, ty, speed, stopAt, dt) {
  const dx = tx - pal.x;
  const dy = ty - pal.y;
  const d = Math.hypot(dx, dy);
  if (d <= stopAt) {
    pal.vx = pal.vy = 0;
    pal.stuckT = 0;
    return true;
  }
  const w = gs.world;
  let a = Math.atan2(dy, dx);
  const step = Math.min(speed * dt, d - stopAt);
  const look = Math.min(0.4, step + 0.1);
  const free = (ang) => w.isFree(pal.x + Math.cos(ang) * look, pal.y + Math.sin(ang) * look, pal.r, 'pal');
  if (!free(a)) {
    const side = pal.detour || 1;
    let found = false;
    for (const turn of [0.7, 1.3, 2]) {
      for (const sgn of [side, -side]) {
        if (free(a + turn * sgn)) {
          a += turn * sgn;
          pal.detour = sgn;
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }
  const nx = pal.x + Math.cos(a) * step;
  const ny = pal.y + Math.sin(a) * step;
  const bx = pal.x;
  const by = pal.y;
  if (w.isFree(nx, pal.y, pal.r, 'pal')) pal.x = nx;
  if (w.isFree(pal.x, ny, pal.r, 'pal')) pal.y = ny;
  pal.vx = (pal.x - bx) / dt;
  pal.vy = (pal.y - by) / dt;
  if (Math.abs(pal.vx) > 0.05) pal.facing = pal.vx > 0 ? 1 : -1;
  pal.stuckT = Math.hypot(pal.x - bx, pal.y - by) < step * 0.2 ? pal.stuckT + dt : 0;
  return false;
}

function attack(gs, p, pal, e) {
  const s = pal.stats;
  const sp = palSpecies(gs.data, pal.species);
  pal.cd = s.attackInterval;
  pal.anim = (pal.anim + 1) & 255;
  pal.facing = e.x >= pal.x ? 1 : -1;
  const element = s.element;
  const status = element === 'fire' && Math.random() < 0.3 ? 'burn' : element === 'lightning' && Math.random() < 0.25 ? 'shock' : null;
  damageEnemy(gs, e, s.damage, {
    attacker: p, element, depth: 1, source: 'pal', fromX: pal.x, fromY: pal.y, knockback: sp?.attack === 'bite' ? 0.5 : 0, canCrit: false,
  });
  if (status && !e.dead) applyStatus(gs, e, status, s.damage, p);
  if (sp?.attack === 'zap') {
    gs.event(pal.x, pal.y, { k: 'fx', fx: 'chain', points: [[pal.x, pal.y - 0.2], [e.x, e.y]], color: '#bff4ff' }, 30);
  }
}

function work(gs, p, pal, o) {
  pal.cd = pal.stats.attackInterval * 0.8;
  pal.work = (pal.work + 1) & 255;
  pal.facing = o.x >= pal.x ? 1 : -1;
  const key = `${o.tx},${o.ty}`;
  if (!gs.world.blockAt(o.tx, o.ty)) {
    pal.tile = null;
    return;
  }
  const now = Date.now();
  const prev = p.harvest.get(key);
  const dmg = (prev && now - prev.at < 20000 ? prev.dmg : 0) + pal.stats.gatherPower;
  p.harvest.set(key, { dmg, at: now });
  if (p.harvest.size > 32) p.harvest.delete(p.harvest.keys().next().value);
  gs.event(o.x, o.y, { k: 'chop', x: o.x, y: o.y, wood: Boolean(o.info.drops.wood), frac: Math.min(1, dmg / o.info.hp) }, 24);
  if (dmg >= o.info.hp) {
    // Your pal hands over what it chopped straight away.
    p.harvest.delete(key);
    loot.fellBlock(gs, p, o, { yield: 1 }, { direct: true });
    pal.tile = null;
  }
}

/** Monsters that bump into a pal hurt it; at 0 health it naps for a while. */
function takeHits(gs, p, pal) {
  if (pal.hurtCd > gs.time) return;
  for (const e of gs.enemiesNear(pal.x, pal.y, 2.5)) {
    if (e.dead || e.submerged || e.def?.sea) continue;
    const reach = e.r + pal.r + 0.05;
    if ((e.x - pal.x) ** 2 + (e.y - pal.y) ** 2 > reach * reach) continue;
    pal.hurtCd = gs.time + 0.8;
    const hard = e.state === 'charge';
    const dmg = Math.max(1, Math.round(e.dmg * (e.boss ? 0.8 : 0.5) * (hard ? 1.5 : 1)));
    pal.hp -= dmg;
    gs.event(pal.x, pal.y, { k: 'palhurt', id: pal.eid, n: dmg }, 24);
    if (pal.hp <= 0) {
      pal.hp = 0;
      pal.state = 'down';
      pal.downUntil = gs.time + gs.data.pals.reviveSeconds;
      pal.target = pal.tile = null;
      const name = findPal(palSave(gs, p), pal.id)?.name ?? 'Din pal';
      gs.toast(p, `${name} är utslagen och är tillbaka om ${gs.data.pals.reviveSeconds} s.`, 'warn');
    }
    return;
  }
}

/** One step of a pal's life: follow, fight, gather, nap. */
function step(gs, p, dt) {
  const pal = p.palEnt;
  if (pal.state === 'down') {
    pal.vx = pal.vy = 0;
    if (gs.time >= pal.downUntil) {
      pal.state = 'follow';
      pal.hp = pal.stats.maxHp;
      place(gs, p, pal);
      gs.event(pal.x, pal.y, { k: 'fx', fx: 'holy', x: pal.x, y: pal.y }, 24);
    } else if (Math.hypot(p.x - pal.x, p.y - pal.y) > TELEPORT_DIST * 2) {
      place(gs, p, pal);
    }
    return;
  }
  const dp = Math.hypot(p.x - pal.x, p.y - pal.y);
  if (pal.tile && pal.stuckT > 1) {
    // Can't get at that tree: try another one for a while.
    pal.skip.set(`${pal.tile.tx},${pal.tile.ty}`, gs.time + 20);
    pal.tile = null;
    pal.stuckT = 0;
  }
  if (dp > TELEPORT_DIST || pal.stuckT > 1.5 || p.dead) {
    place(gs, p, pal);
    pal.stuckT = 0;
    pal.target = pal.tile = null;
  }
  pal.cd -= dt;
  takeHits(gs, p, pal);
  if (pal.state === 'down') return;

  const mode = palSave(gs, p).pals.mode ?? 'fight';
  pal.think -= dt;
  if (pal.think <= 0) {
    pal.think = RETHINK;
    const foe = nearestEnemy(gs, p, pal);
    // Gatherers only fight back when something is right on top of them.
    const threat = foe && Math.hypot(foe.x - pal.x, foe.y - pal.y) < 2.2;
    pal.target = mode === 'fight' || (mode === 'gather' && threat) ? foe : null;
    if (mode === 'gather' && !pal.target) {
      if (!pal.tile || !gs.world.blockAt(pal.tile.tx, pal.tile.ty) || Math.hypot(pal.tile.x - p.x, pal.tile.y - p.y) > GATHER_RADIUS + 1.5) {
        pal.tile = nearestHarvest(gs, p, pal);
      }
    } else {
      pal.tile = null;
    }
  }
  const s = pal.stats;
  // Keep up with you when you sprint off.
  const catchUp = dp > 4 ? Math.max(s.speed, p.speed * 1.15) : s.speed;
  const e = pal.target && !pal.target.dead && !pal.target.submerged && gs.enemies.has(pal.target.id) ? pal.target : null;
  if (e) {
    pal.state = 'fight';
    const reach = s.range || e.r + pal.r + 0.35;
    const there = walk(gs, pal, e.x, e.y, catchUp, Math.max(0.1, reach - 0.15), dt);
    if (there || Math.hypot(e.x - pal.x, e.y - pal.y) <= reach) {
      pal.facing = e.x >= pal.x ? 1 : -1;
      if (pal.cd <= 0) attack(gs, p, pal, e);
    }
  } else if (pal.tile) {
    pal.state = 'gather';
    const o = pal.tile;
    if (walk(gs, pal, o.x, o.y, catchUp, 1.15, dt) && pal.cd <= 0) work(gs, p, pal, o);
  } else {
    pal.state = 'follow';
    // Trot along just behind you; close enough is close enough.
    if (dp < 2.2 && !(p.moving && dp > 1.6)) {
      pal.vx = pal.vy = 0;
      pal.stuckT = 0;
    } else {
      const back = Math.cos(p.facing) >= 0 ? -1 : 1;
      walk(gs, pal, p.x + back * 1.3, p.y + 0.4, catchUp, 0.6, dt);
    }
  }
  // Out of a fight, pals lick their wounds.
  if (!e && pal.hp < s.maxHp) pal.hp = Math.min(s.maxHp, pal.hp + s.maxHp * 0.03 * dt);
}

/** Every player's pal, every tick (and hatching now and then). */
export function update(gs, dt) {
  for (const p of gs.players.values()) {
    if ((gs.tick + p.id) % HATCH_CHECK_TICKS === 0 && p.conn) checkHatch(gs, p);
    if (!p.palEnt) continue;
    if (p.asleep || !p.conn) {
      p.palEnt = null;
      continue;
    }
    // Out at sea your pal rides along in the boat.
    const pal = p.palEnt;
    if (p.sailing) {
      pal.hidden = true;
      pal.x = p.x;
      pal.y = p.y;
      continue;
    }
    if (pal.hidden) {
      pal.hidden = false;
      place(gs, p, pal);
    }
    step(gs, p, dt);
  }
}
