// Horses in multiplayer (rules in src/game/horses.js): wild herds come to
// life near players, anyone may tame a wild horse by riding it, and it is
// theirs from then on (ch.extra.horses: { owned: [records], riding: id,
// nextId }). On horseback you are faster, tougher and jump trees and rocks;
// the client predicts with the same numbers and the 'horse' movement mode.
// Leave a horse on your clan's land and it stays there; anywhere else it
// wanders off when you stay away (or log out) for a few minutes. Your horses
// are in the world while you are.

import {
  BREEDS, BREED_BY_ID, herdsNear, horseStats, herdHorseSeed, grazeSpot, describeHorse,
  MAX_HORSES, STRAY_RANGE, STRAY_SECONDS, REGROW_MS, HORSE_MODE,
} from '../src/game/horses.js';
import { claimAt } from '../src/net/rules.js';
import * as players from './players.js';

const ACTIVATE = 50;
const FORGET = 70;
const REACH = 1.8;
const CHECK_TICKS = 15;

/** The character's horses (created on first use). */
export function horsesOf(p) {
  p.ch.extra.horses ??= { owned: [], riding: null, nextId: 1 };
  return p.ch.extra.horses;
}

/** The record of the horse `p` rides, or null. */
export function ridingOf(p) {
  const st = p.ch.extra.horses;
  if (!st?.riding) return null;
  return st.owned.find((h) => h.id === st.riding) ?? null;
}

/** The breed's number on the wire (0 = none). */
export function breedIndex(id) {
  return BREEDS.findIndex((b) => b.id === id) + 1;
}

function state(gs) {
  gs.horses ??= new Map(); // eid → horse in the world
  gs.horseTaken ??= new Map(); // "herd:x,y:i" → when it was tamed
  return gs.horses;
}

/** Moves and spawns horses: wild herds near players, and everyone's own horses. */
export function update(gs, dt, now = Date.now()) {
  const horses = state(gs);
  if (gs.tick % CHECK_TICKS === 0) {
    const wanted = new Map();
    for (const p of gs.players.values()) {
      for (const herd of herdsNear(gs.world, p.x, p.y, ACTIVATE)) {
        for (let i = 0; i < herd.size; i++) {
          const key = `${herd.key}:${i}`;
          const taken = gs.horseTaken.get(key);
          if (taken && now - taken < REGROW_MS) continue;
          if (taken) gs.horseTaken.delete(key);
          wanted.set(key, { herd, i });
        }
      }
    }
    const wild = new Map();
    for (const h of horses.values()) if (h.wild) wild.set(h.key, h);
    for (const [key, { herd, i }] of wanted) if (!wild.has(key)) spawnWild(gs, herd, i);
    for (const [key, h] of wild) {
      if (!wanted.has(key) && !playerWithin(gs, h.x, h.y, FORGET)) horses.delete(h.eid);
    }
    for (const p of gs.players.values()) syncOwned(gs, p, now);
    // Horses of players who left go with them.
    for (const h of horses.values()) {
      if (h.own && gs.players.get(h.owner)?.accountId !== h.account) horses.delete(h.eid);
    }
  }
  for (const h of horses.values()) {
    if (h.wild) graze(gs, h, dt);
  }
}

function playerWithin(gs, x, y, r) {
  for (const p of gs.players.values()) if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r * r) return true;
  return false;
}

function spawnWild(gs, herd, i) {
  const stats = horseStats(herd.breeds[i], herdHorseSeed(gs.world, herd, i));
  const spot = grazeSpot(herd, i, 0);
  const h = {
    eid: gs.newId(), key: `${herd.key}:${i}`, herd, idx: i, wild: true, ...stats,
    x: spot.x, y: spot.y, facing: 0, moving: false, tx: spot.x, ty: spot.y, wanderT: Math.random() * 3, t: 0,
  };
  gs.horses.set(h.eid, h);
  return h;
}

function graze(gs, h, dt) {
  h.t += dt;
  h.wanderT -= dt;
  if (h.wanderT <= 0) {
    h.wanderT = 3 + Math.random() * 5;
    const spot = grazeSpot(h.herd, h.idx, h.t + Math.random() * 40);
    h.tx = spot.x;
    h.ty = spot.y;
  }
  const dx = h.tx - h.x;
  const dy = h.ty - h.y;
  const d = Math.hypot(dx, dy);
  h.moving = d > 0.3;
  if (!h.moving) return;
  const step = Math.min(d, 1.6 * dt);
  const nx = h.x + (dx / d) * step;
  const ny = h.y + (dy / d) * step;
  if (gs.world.isFree(nx, h.y, 0.36, HORSE_MODE)) h.x = nx;
  if (gs.world.isFree(h.x, ny, 0.36, HORSE_MODE)) h.y = ny;
  if (Math.abs(dx) > 0.05) h.facing = dx < 0 ? -1 : 1;
}

/** Puts the player's horses in the world (not the one they ride), and lets strays go. */
function syncOwned(gs, p, now) {
  const st = p.ch.extra.horses;
  if (!st?.owned.length) return;
  const ents = (p.horseEnts ??= new Map());
  for (const rec of [...st.owned]) {
    if (rec.id === st.riding) continue;
    if (!rec.stabled) {
      const far = (rec.x - p.x) ** 2 + (rec.y - p.y) ** 2 > STRAY_RANGE * STRAY_RANGE;
      if (!far || p.asleep) rec.leftAt = now;
      else if (now - (rec.leftAt ?? now) > STRAY_SECONDS * 1000) {
        runOff(gs, p, rec, `${rec.name} tröttnade på att vänta och sprang iväg. Lämna hästar på er klans mark så stannar de.`);
        continue;
      }
    }
    let h = ents.get(rec.id);
    if (!h || !gs.horses.has(h.eid)) {
      h = { eid: gs.newId(), own: true, owner: p.id, account: p.accountId, rec, breed: rec.breed, x: rec.x, y: rec.y, facing: 1, moving: false };
      ents.set(rec.id, h);
      gs.horses.set(h.eid, h);
    }
  }
  for (const [id, h] of ents) {
    if (id === st.riding || !st.owned.some((r) => r.id === id)) {
      gs.horses.delete(h.eid);
      ents.delete(id);
    }
  }
}

function runOff(gs, p, rec, text) {
  const st = horsesOf(p);
  st.owned = st.owned.filter((r) => r !== rec);
  const h = p.horseEnts?.get(rec.id);
  if (h) gs.horses.delete(h.eid);
  p.horseEnts?.delete(rec.id);
  if (text) gs.toast(p, text, 'warn');
  players.markMe(p);
}

/**
 * When a player comes back: horses left out in the wild while they were away
 * have wandered off.
 */
export function joined(gs, p, now = Date.now()) {
  const st = p.ch.extra.horses;
  if (!st?.owned.length) return;
  for (const rec of [...st.owned]) {
    if (rec.id === st.riding || rec.stabled) continue;
    if (now - (rec.leftAt ?? now) > STRAY_SECONDS * 1000) {
      runOff(gs, p, rec, `${rec.name} sprang iväg medan du var borta. Lämna hästar på er klans mark så stannar de.`);
    }
  }
  const rec = ridingOf(p);
  p.buffs = p.buffs.filter((b) => b.source !== 'horse');
  if (rec?.hp) p.buffs.push({ stat: 'maxHp', value: rec.hp, until: Infinity, source: 'horse' });
  players.recomputeStats(gs, p);
}

/** The horse within reach of the player (wild or their own), or null. */
export function near(gs, p) {
  let best = null;
  let bestD = REACH * REACH;
  for (const h of state(gs).values()) {
    if (h.own && h.owner !== p.id) continue;
    const d = (h.x - p.x) ** 2 + (h.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best ? { h: best, d: bestD } : null;
}

/** Climbs on a horse; a wild one becomes yours. Returns true (the press was used). */
export function mount(gs, p, h, now = Date.now()) {
  if (p.dead || p.sailing || ridingOf(p)) return false;
  const st = horsesOf(p);
  let rec;
  if (h.own) {
    if (h.owner !== p.id) return false;
    rec = h.rec;
    gs.horses.delete(h.eid);
    p.horseEnts?.delete(rec.id);
  } else {
    if (st.owned.length >= MAX_HORSES) {
      gs.toast(p, `Du har redan ${MAX_HORSES} hästar. Släpp en först (Meny → Hästar).`, 'warn');
      return true;
    }
    rec = { id: st.nextId++, breed: h.breed, speed: h.speed, gallop: h.gallop, hp: h.hp, name: h.name, x: h.x, y: h.y, stabled: false };
    st.owned.push(rec);
    gs.horseTaken.set(h.key, now);
    gs.horses.delete(h.eid);
    gs.toast(p, `Du tämjer ${rec.name}! ${describeHorse(rec, true)}. Rid hem till er bas så stannar hästen där.`, 'legendary');
  }
  st.riding = rec.id;
  p.buffs = p.buffs.filter((b) => b.source !== 'horse');
  if (rec.hp) p.buffs.push({ stat: 'maxHp', value: rec.hp, until: Infinity, source: 'horse' });
  players.recomputeStats(gs, p);
  p.infoRev++;
  gs.event(p.x, p.y, { k: 'fx', fx: 'dust', x: p.x, y: p.y }, 24);
  players.markMe(p);
  players.persist(gs, p);
  return true;
}

/** Climbs off where you are; on your clan's land the horse stays for good. */
export function dismount(gs, p, now = Date.now(), { quiet = false } = {}) {
  const rec = ridingOf(p);
  if (!rec) return false;
  const st = horsesOf(p);
  st.riding = null;
  rec.x = Math.round(p.x * 100) / 100;
  rec.y = Math.round(p.y * 100) / 100;
  const claim = claimAt(gs.rules, gs.claims(), Math.floor(p.x), Math.floor(p.y));
  rec.stabled = Boolean(p.clanId && claim?.clanId === p.clanId);
  rec.leftAt = now;
  p.buffs = p.buffs.filter((b) => b.source !== 'horse');
  players.recomputeStats(gs, p);
  p.infoRev++;
  // On foot you can't stand in a tree or on a rock: step off beside it.
  if (!p.dead) {
    gs.world.gateFilter = (s) => Boolean(s.clanId) && s.clanId === p.clanId;
    const free = gs.world.isFree(p.x, p.y, p.r) ? null : gs.world.findFreeSpot(p.x, p.y, p.r, 'player', { x: p.x, y: p.y });
    gs.world.gateFilter = null;
    if (free) {
      p.x = free.x;
      p.y = free.y;
      p.kx = p.ky = 0;
      p.queue.length = 0;
      gs.send(p, { t: 'teleport', x: p.x, y: p.y });
    }
  }
  syncOwned(gs, p, now);
  if (!quiet) {
    gs.toast(p, rec.stabled
      ? `${rec.name} stannar i er bas.`
      : `${rec.name} väntar här. Ute i vildmarken springer en häst iväg om du är borta länge; på er klans mark stannar den.`,
    rec.stabled ? 'component' : 'info');
  }
  players.markMe(p);
  players.persist(gs, p);
  return true;
}

/** How you move on horseback (players.moveParams), or null on foot. */
export function moveParams(gs, p) {
  const rec = ridingOf(p);
  if (!rec || p.sailing) return null;
  const chilled = p.statuses.chill?.until > gs.time;
  return { speed: rec.speed * (chilled ? 0.65 : 1), sprint: rec.gallop, mode: HORSE_MODE };
}

/** { t: 'horse', op: 'release', id } → problem text or null. */
export function request(gs, p, msg) {
  const st = horsesOf(p);
  if (msg.op !== 'release') return 'Okänd begäran';
  const rec = st.owned.find((h) => h.id === Number(msg.id));
  if (!rec) return 'Ingen sådan häst';
  if (rec.id === st.riding) return 'Kliv av först';
  runOff(gs, p, rec, null);
  gs.toast(p, `${rec.name} galopperar ut i det vilda.`);
  players.persist(gs, p);
  return null;
}

/** The horses for the 'me' message. */
export function payload(p) {
  const st = p.ch.extra.horses;
  return st ? { owned: st.owned, riding: st.riding } : { owned: [], riding: null };
}

export { BREED_BY_ID };
