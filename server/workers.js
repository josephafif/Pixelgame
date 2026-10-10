// Workers in multiplayer: hired at a clan's Workers' Lodge (Arbetarstuga),
// they chop trees and break rocks around the base and fill the clan vault.
// The behaviour is single player's (src/game/workers.js); here the server
// moves them, cuts the trees for everyone and pays their wages from the
// vault (upkeep, building.js). They work while someone in the clan is
// online and upkeep is paid. Hurt one and it turns on you.
//
// The roster ({ id, role }) lives in clan.base.workers (saved with the clan).

import {
  workerCap, hireCost, workerStats, createWorker, stepWorker, hurtWorker, workerLook, walk, WORKER_ROLES, ROLE_NAMES_SV,
} from '../src/game/workers.js';
import { isSoldier, workerCount, makeSoldier, hurtSoldier } from '../src/game/army.js';
import { rollDrops } from '../src/game/gathering.js';
import { canDo, inSafeZone } from '../src/net/rules.js';
import * as base from './base.js';
import * as clans from './clans.js';
import * as combat from './combat.js';
import * as building from './building.js';

const RES_SV = { wood: 'TRÄ', stone: 'STEN', scrap: 'SKROT', essence: 'ESSENS', shards: 'SKÄRVA' };
const RES_COLOR = { wood: '#e8c890', stone: '#d0d4e0', scrap: '#c8ccd8', essence: '#7ae0ff', shards: '#ffd24a' };

function roster(clan) {
  const b = base.clanBase(clan);
  b.workers ??= [];
  b.nextWorker ??= 1;
  return b;
}

/** A worker's (or soldier's) name and colours. */
export function lookOf(clan, id) {
  return workerLook(clan.id, id);
}

/** Room at the lodge for workers (soldiers live in the barracks). */
export function capOf(gs, level) {
  return workerCap(gs.data, level);
}

/** The clan's lodge level (0 while no lodge stands in the base). */
export function lodgeLevel(gs, clan) {
  return base.placed(gs, clan.id).has('lodge') ? Math.max(1, clan.base?.buildings?.lodge ?? 1) : 0;
}

function homeOf(st) {
  return { x: st.x + 0.5, y: st.y + 1.6 };
}

function state(gs) {
  gs.workers ??= new Map(); // entity id → worker
  gs.workerTaken ??= new Set(); // trees and rocks someone is on
  return gs.workers;
}

function release(gs, w) {
  if (w.job) gs.workerTaken.delete(`${w.job.tx},${w.job.ty}`);
}

/** Runtime workers to match a clan's roster (after a hire, a lodge built, moved or upgraded). */
export function sync(gs, clan) {
  const all = state(gs);
  const st = base.placed(gs, clan.id).get('lodge');
  const stats = workerStats(gs.data, Math.max(1, lodgeLevel(gs, clan)));
  const want = st ? roster(clan).workers : [];
  for (const [eid, w] of all) {
    if (w.clanId !== clan.id || want.some((r) => r.id === w.id)) continue;
    release(gs, w);
    all.delete(eid);
  }
  for (const rec of want) {
    let w = null;
    for (const x of all.values()) if (x.clanId === clan.id && x.id === rec.id) w = x;
    if (!w) {
      const home = homeOf(st);
      w = createWorker(rec, { x: home.x + (Math.random() - 0.5) * 2, y: home.y + Math.random() * 0.5 }, stats);
      Object.assign(w, workerLook(clan.id, rec.id), { eid: gs.newId(), clanId: clan.id, hurtT: -9 });
      all.set(w.eid, w);
    }
    const soldier = isSoldier(gs.data, rec.role);
    if (soldier && !('target' in w)) makeSoldier(w);
    if (w.role !== rec.role) {
      release(gs, w);
      w.job = null;
      w.carry = {};
      w.statsKey = null;
      w.state = soldier ? 'post' : w.state === 'go' || w.state === 'work' ? 'return' : w.state;
      w.role = rec.role;
    }
    w.training = Boolean(rec.trainingTo);
    if (!soldier) {
      w.hp = Math.min(stats.hp, w.hp + Math.max(0, stats.hp - w.maxHp));
      w.maxHp = stats.hp;
    }
  }
}

export function syncAll(gs) {
  for (const clan of gs.clans.values()) sync(gs, clan);
}

/** Is anyone in the clan playing right now? */
function online(gs, clan) {
  for (const id of clan.members.keys()) if (gs.byAccount.get(id)?.conn) return true;
  return false;
}

function ctxFor(gs, clan, st) {
  const level = lodgeLevel(gs, clan);
  const banner = building.bannerOf(gs, clan.id);
  return {
    world: gs.world, data: gs.data, time: gs.time, stats: workerStats(gs.data, Math.max(1, level)), home: homeOf(st),
    // Inside the claim the ground stays cleared: they work outside it.
    clear: banner ? { x: banner.x + 0.5, y: banner.y + 0.5, r: gs.rules.claimRadius } : null,
    working: !clan.unpaid && online(gs, clan), taken: gs.workerTaken,
    fell: (w, job) => {
      if (!gs.removeBlock(job.tx, job.ty)) return {};
      return rollDrops(job.info);
    },
    chop: (w, job, frac) => {
      gs.event(job.tx + 0.5, job.ty + 0.5, { k: 'chop', x: job.tx + 0.5, y: job.ty + 0.5, wood: Boolean(job.info.drops.wood), frac }, 24);
    },
    deliver: (w, carry) => {
      for (const [k, n] of Object.entries(carry)) clan.vault[k] = (clan.vault[k] ?? 0) + n;
      clan.dirty = true;
      clan.workersDirty = true;
      const text = Object.entries(carry).map(([k, n]) => `+${n} ${RES_SV[k] ?? k}`).join(' ');
      if (text) gs.event(w.x, w.y, { k: 'fx', fx: 'text', x: w.x, y: w.y - 1, text, color: RES_COLOR[Object.keys(carry)[0]] ?? '#ffe890' }, 24);
    },
    target: (w) => gs.players.get(w.angry) ?? null,
    strike: (w, foe, dmg) => {
      combat.hurtPlayer(gs, foe, dmg, { fromX: w.x, fromY: w.y, knock: 3 });
    },
  };
}

export function update(gs, dt) {
  const all = state(gs);
  if (!all.size) return;
  const ctxs = new Map();
  for (const w of all.values()) {
    const clan = gs.clans.get(w.clanId);
    const st = clan ? base.placed(gs, clan.id).get('lodge') : null;
    if (!st) {
      // The clan is gone or its lodge was taken down: the workers go with it.
      release(gs, w);
      all.delete(w.eid);
      continue;
    }
    let ctx = ctxs.get(clan.id);
    if (!ctx) ctxs.set(clan.id, (ctx = ctxFor(gs, clan, st)));
    // Soldiers are server/army.js's; recruits drill at the Training Grounds.
    if (isSoldier(gs.data, w.role)) continue;
    // Workers go through their own clan's gates (and a market's), nobody else's.
    gs.world.gateFilter = (s) => Boolean(s.clanId) && s.clanId === clan.id;
    if (w.training) drill(gs, clan, w, ctx, dt);
    else stepWorker(w, ctx, dt);
    gs.world.gateFilter = null;
    if (w.dead) died(gs, clan, w, null);
  }
  // The clan panel's vault numbers follow the deliveries (at most every few seconds).
  if (gs.tick % 90 === 0) {
    for (const clan of gs.clans.values()) {
      if (!clan.workersDirty) continue;
      clan.workersDirty = false;
      clans.sendClan(gs, clan);
    }
  }
}

/** A recruit in training: off to the Training Grounds, and drilling there. */
function drill(gs, clan, w, ctx, dt) {
  const st = base.placed(gs, clan.id).get('training');
  if (!st) return;
  release(gs, w);
  w.job = null;
  w.angry = null;
  w.t += dt;
  w.clock += dt;
  const tx = st.x + 0.5 + ((w.id % 3) - 1) * 0.9;
  const ty = st.y + 2 + Math.floor((w.id % 6) / 3) * 0.8;
  if (walk(ctx, w, tx, ty, ctx.stats.speed, dt, 0.3)) {
    w.moving = false;
    w.swingT = (w.swingT ?? 0) - dt;
    if (w.swingT <= 0) {
      w.swingT = 0.8;
      w.anim = (w.anim + 1) & 255;
    }
  }
}

/** Takes someone off a clan's roster (a fallen soldier). */
export function remove(gs, clan, w, text) {
  release(gs, w);
  state(gs).delete(w.eid);
  const b = roster(clan);
  b.workers = b.workers.filter((r) => r.id !== w.id);
  clan.dirty = true;
  gs.db.saveClan(clan);
  for (const id of clan.members.keys()) {
    const m = gs.byAccount.get(id);
    if (m?.conn) gs.toast(m, text, 'warn');
  }
  clans.sendClan(gs, clan);
}

function died(gs, clan, w, killer) {
  release(gs, w);
  state(gs).delete(w.eid);
  const b = roster(clan);
  b.workers = b.workers.filter((r) => r.id !== w.id);
  clan.dirty = true;
  gs.db.saveClan(clan);
  const text = killer && killer.clanId !== clan.id
    ? `${killer.name} dödade er arbetare ${w.name}!`
    : `${w.name} är död. Anställ en ny vid arbetarstugan.`;
  for (const id of clan.members.keys()) {
    const m = gs.byAccount.get(id);
    if (m?.conn) gs.toast(m, text, 'warn');
  }
  clans.sendClan(gs, clan);
}

/**
 * A player's attack may hit workers (auto-aim never targets them). Another
 * clan's workers can only be hurt while that base can be raided.
 */
export function hit(gs, p, x, y, reach, damage, inside) {
  const all = state(gs);
  if (!all.size) return false;
  let any = false;
  for (const w of [...all.values()]) {
    if (w.dead || (w.x - x) ** 2 + (w.y - y) ** 2 > (reach + 2) ** 2 || !inside(w.x, w.y, w.r)) continue;
    if (inSafeZone(gs.rules, w.x, w.y)) continue;
    if (w.clanId !== p.clanId && !gs.raidState(w.clanId).raidable) continue;
    const clan = gs.clans.get(w.clanId);
    if (!clan) continue;
    const dmg = Math.max(1, Math.round(damage));
    if (isSoldier(gs.data, w.role)) {
      // Your own soldiers step aside from your swings; another clan's can be cut down in a raid.
      if (w.clanId === p.clanId) continue;
      gs.event(w.x, w.y, { k: 'npchurt', id: w.eid, n: dmg }, 24);
      if (hurtSoldier(w, dmg)) {
        gs.event(w.x, w.y, { k: 'kill', id: w.eid, x: w.x, y: w.y, r: w.r }, 24);
        remove(gs, clan, w, `${p.name} dödade er soldat ${w.name}!`);
      }
      any = true;
      continue;
    }
    const was = w.angry;
    const ctx = { time: gs.time, stats: workerStats(gs.data, Math.max(1, lodgeLevel(gs, clan))), taken: gs.workerTaken };
    const killed = hurtWorker(w, ctx, dmg, p.id);
    w.hurtT = gs.time;
    gs.event(w.x, w.y, { k: 'npchurt', id: w.eid, n: dmg }, 24);
    if (killed) {
      gs.event(w.x, w.y, { k: 'kill', id: w.eid, x: w.x, y: w.y, r: w.r }, 24);
      died(gs, clan, w, p);
    } else if (was !== p.id) {
      gs.toast(p, `${w.name} blir arg på dig!`, 'warn');
    }
    any = true;
  }
  return any;
}

// --- Requests ---------------------------------------------------------------------------------

/** { t: 'base', op: 'hire' | 'fire' | 'role', role?, id? } → problem text or null. */
export function request(gs, p, clan, msg) {
  const role = clan.members.get(p.accountId)?.role ?? 'member';
  if (!canDo(role, 'build')) return 'Du får inte bestämma över arbetarna';
  const level = lodgeLevel(gs, clan);
  if (level < 1) return 'Bygg en arbetarstuga i er bas först';
  const b = roster(clan);
  if (msg.op === 'hire') {
    const job = WORKER_ROLES.includes(msg.role) ? msg.role : 'wood';
    const count = workerCount(gs.data, b.workers);
    if (count >= workerCap(gs.data, level)) return 'Arbetarstugan är full: uppgradera den för att få plats med fler';
    const cost = hireCost(gs.data, count);
    const short = base.shortfall(clan, p, cost);
    if (short) return short;
    const paid = base.pay(clan, p, cost);
    const rec = { id: b.nextWorker++, role: job };
    b.workers.push(rec);
    try {
      gs.db.tx(() => {
        gs.db.saveClan(clan);
        gs.db.log(p.accountId, 'worker-hire', null, { clan: clan.id, worker: rec.id, paid });
      });
    } catch (err) {
      b.workers.pop();
      base.refund(clan, p, paid);
      gs.log.error('[workers] hire failed', err);
      return 'Kunde inte anställa';
    }
    sync(gs, clan);
    const look = workerLook(clan.id, rec.id);
    for (const id of clan.members.keys()) {
      const m = gs.byAccount.get(id);
      if (m?.conn) gs.toast(m, `${p.name} anställde ${look.name} som ${ROLE_NAMES_SV[job].toLowerCase()}!`, 'level');
    }
    clans.sendClan(gs, clan);
    return null;
  }
  const rec = b.workers.find((r) => r.id === Number(msg.id));
  if (!rec) return 'Den arbetaren finns inte';
  if (msg.op === 'fire') {
    b.workers = b.workers.filter((r) => r !== rec);
  } else if (msg.op === 'role') {
    if (!WORKER_ROLES.includes(msg.role)) return 'Okänt jobb';
    if (isSoldier(gs.data, rec.role) || rec.trainingTo) return 'Soldater styrs på strategikartan (N)';
    rec.role = msg.role;
  } else {
    return 'Okänd begäran';
  }
  gs.db.saveClan(clan);
  sync(gs, clan);
  clans.sendClan(gs, clan);
  return null;
}
