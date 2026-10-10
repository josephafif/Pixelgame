// Markets in multiplayer: the same fortified trading posts as single player
// (src/game/markets.js), shared by everyone. The world decides where they
// stand and how they look, so the server and every client build the same
// walls, gates and turrets from it; the server runs the turrets and the
// people, and checks every trade.
//
// Each player has their own stock (it rotates every 20 minutes, as in single
// player) and their own standing with each market: hurt someone there and its
// turrets turn on you, and nobody trades with you, for a few minutes.

import { marketLayout, marketStock, weaponPrice, sellPrice, SELL_BUNDLES, TOWN_CELL, marketDef, npcStuck } from '../src/game/markets.js';
import { villagerTarget } from '../src/game/villages.js';
import { tileKey, MARKET_CELL } from '../src/game/world.js';
import { generateWeapon } from '../src/weapons/generator.js';
import * as combat from './combat.js';
import * as players from './players.js';
import * as loot from './loot.js';
import * as base from './base.js';

const ACTIVATE = 46;
const DEACTIVATE = 72;
const HOSTILE_HURT_MS = 3 * 60 * 1000;
const HOSTILE_KILL_MS = 5 * 60 * 1000;
const NPC_HP = 60;
const NPC_RESPAWN_S = 300;
const TRADE_REACH = 3.2;

const defFor = marketDef;

/** The market cell (mx, my) a market belongs to (clients find it with world.marketForCell). */
export function marketCell(m) {
  if (m.town) return { mx: TOWN_CELL, my: TOWN_CELL };
  return { mx: Math.floor(m.x / MARKET_CELL), my: Math.floor(m.y / MARKET_CELL) };
}

// --- Standing ---------------------------------------------------------------------------

export function state(p, id) {
  p.ch.extra.markets ??= {};
  p.ch.extra.markets[id] ??= { visited: false, hostileUntil: 0, period: 0, bought: [] };
  return p.ch.extra.markets[id];
}

export function isHostile(p, id, now = Date.now()) {
  return (p.ch.extra.markets?.[id]?.hostileUntil ?? 0) > now;
}

/** Someone at the market was hurt by `p`: its turrets turn on them. */
function provoke(gs, p, entry, killed) {
  const st = state(p, entry.def.id);
  const now = Date.now();
  const was = st.hostileUntil > now;
  st.hostileUntil = Math.max(st.hostileUntil, now + (killed ? HOSTILE_KILL_MS : HOSTILE_HURT_MS));
  if (!was || killed) {
    gs.toast(p, killed
      ? `Du dödade någon i ${entry.def.name}! Dess torn jagar dig i ${Math.round((st.hostileUntil - now) / 60000)} minuter.`
      : `Vakterna i ${entry.def.name} vänder sina torn mot dig!`, 'boss');
  }
  players.markMe(p);
}

// --- Coming and going -------------------------------------------------------------------------

function activate(gs, m) {
  const structures = [];
  const layout = marketLayout(m);
  for (const s of layout.structs) {
    const def = defFor(gs.data, s.id);
    if (!def) continue;
    const st = {
      id: s.id, x: m.x + s.x, y: m.y + s.y, hp: def.hp, def, marketId: m.id, color: m.color,
      rt: { cd: Math.random(), aim: -Math.PI / 2, flash: 0, trig: -9, open: 0 },
    };
    const layer = def.kind === 'floor' ? gs.world.floors : gs.world.structures;
    const key = tileKey(st.x, st.y);
    // Never over a player's building.
    if (layer.has(key)) continue;
    layer.set(key, st);
    structures.push(st);
  }
  const { mx, my } = marketCell(m);
  const npcs = layout.npcs.map((n, i) => ({
    eid: gs.newId(), idx: i, marketId: m.id, role: n.role, home: n.home, route: null, wait: Math.random() * 4, x: m.x + n.x + 0.5, y: m.y + n.y + 0.5,
    homeX: m.x + n.x + 0.5, homeY: m.y + n.y + 0.5, r: 0.32, hp: NPC_HP, maxHp: NPC_HP, facing: Math.PI / 2,
    moving: false, dead: false, respawnAt: 0, wanderT: Math.random() * 3, tx: m.x + n.x + 0.5, ty: m.y + n.y + 0.5, fleeT: 0, fleeFrom: null, hurtT: -9,
  }));
  gs.markets.set(m.id, { def: m, mx, my, structures, npcs, layout });
}

function deactivate(gs, id) {
  const entry = gs.markets.get(id);
  if (!entry) return;
  for (const st of entry.structures) {
    const layer = st.def.kind === 'floor' ? gs.world.floors : gs.world.structures;
    const key = tileKey(st.x, st.y);
    if (layer.get(key) === st) layer.delete(key);
  }
  gs.markets.delete(id);
}

// --- Every tick ------------------------------------------------------------------------------------

export function update(gs, dt) {
  if (gs.tick % 15 === 0) {
    const near = new Set();
    const town = gs.world.town;
    for (const p of gs.players.values()) {
      if (p.asleep || !p.conn) continue;
      // Fristaden's traders, on the town square.
      if (town && p.x * p.x + p.y * p.y < ACTIVATE * ACTIVATE) {
        near.add(town.id);
        if (!gs.markets.has(town.id)) activate(gs, town);
      }
      for (const m of gs.world.marketsNear(p.x, p.y, ACTIVATE)) {
        near.add(m.id);
        if (!gs.markets.has(m.id)) activate(gs, m);
        const d = Math.hypot(m.x - p.x, m.y - p.y);
        const st = state(p, m.id);
        if (!st.visited && d < m.r + 1) {
          st.visited = true;
          gs.toast(p, m.village
            ? `Du hittade byn ${m.name}! Handlarna på ängen säljer vapen och varor.`
            : `Du hittade ${m.name}! Här handlar köpmän med vapen och varor.`, 'component');
          players.markMe(p);
        }
      }
    }
    for (const [id, entry] of gs.markets) {
      if (near.has(id)) continue;
      let anyone = false;
      for (const p of gs.playersNear(entry.def.x, entry.def.y, DEACTIVATE)) if (p.conn) anyone = true;
      if (!anyone) deactivate(gs, id);
    }
  }
  const now = Date.now();
  for (const entry of gs.markets.values()) {
    for (const st of entry.structures) if (st.def.kind === 'turret') runTurret(gs, entry, st, dt, now);
    for (const n of entry.npcs) updateNpc(gs, entry, n, dt);
  }
}

/** A market turret: monsters in range, and anyone the market is angry with (much further). */
function runTurret(gs, entry, st, dt, now) {
  const rt = st.rt;
  const spec = st.def.turret;
  rt.cd -= dt;
  const cx = st.x + 0.5;
  const cy = st.y + 0.3;
  let best = null;
  let bestD = (spec.range + 1) ** 2;
  for (const e of gs.enemiesNear(cx, cy, spec.range + 1)) {
    if (e.dead || e.submerged) continue;
    const d = (e.x - cx) ** 2 + (e.y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (!best) {
    const range = entry.def.r * 1.6 + 3;
    bestD = range * range;
    for (const p of gs.playersNear(cx, cy, range)) {
      if (p.dead || !isHostile(p, entry.def.id, now)) continue;
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  if (!best) return;
  const want = Math.atan2(best.y - cy, best.x - cx);
  let diff = want - rt.aim;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  rt.aim += Math.max(-dt * 8, Math.min(dt * 8, diff));
  if (rt.cd > 0 || Math.abs(diff) > 0.5) return;
  rt.cd = spec.interval;
  const lead = Math.sqrt(bestD) / spec.speed;
  const angle = Math.atan2(best.y + (best.vy ?? 0) * lead - cy, best.x + (best.vx ?? 0) * lead - cx);
  const level = gs.world.worldLevel(st.x, st.y);
  combat.spawnProjectile(gs, {
    x: cx, y: cy, angle, speed: spec.speed, damage: spec.damage * (1 + 0.25 * (level - 1)), range: Math.sqrt(bestD) + 2,
    size: spec.sprite === 'orb' ? 3 : 2, sprite: spec.sprite, market: entry.def.id, element: spec.element ?? 'physical',
    color: spec.color, status: spec.status ?? null, kind: 'shot', source: 'turret',
  });
  gs.event(cx, cy, { k: 'mturret', x: st.x, y: st.y, aim: angle }, 30);
}

function updateNpc(gs, entry, n, dt) {
  if (n.dead) {
    if (gs.time >= n.respawnAt) {
      Object.assign(n, { dead: false, hp: NPC_HP, x: n.homeX, y: n.homeY, eid: gs.newId(), fleeT: 0, route: null });
    }
    return;
  }
  const m = entry.def;
  let mx = 0;
  let my = 0;
  if (n.fleeT > 0) {
    n.fleeT -= dt;
    const f = n.fleeFrom ? gs.players.get(n.fleeFrom) : null;
    if (f) {
      const d = Math.hypot(n.x - f.x, n.y - f.y) || 1;
      mx = (n.x - f.x) / d;
      my = (n.y - f.y) / d;
    }
    n.route = null;
  } else if (n.role === 'villager' && m.village) {
    // Villagers walk the paths between the houses and the green.
    const t = villagerTarget(entry.layout, m, n, dt);
    if (t) {
      const d = Math.hypot(t.x - n.x, t.y - n.y) || 1;
      mx = (t.x - n.x) / d;
      my = (t.y - n.y) / d;
      npcStuck(n, d, dt, t);
    }
  } else if (n.role === 'villager') {
    n.wanderT -= dt;
    if (n.wanderT <= 0) {
      n.wanderT = 2 + Math.random() * 3;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * (m.r - 3);
      n.tx = m.x + 0.5 + Math.cos(a) * rr;
      n.ty = m.y + 0.5 + Math.sin(a) * rr;
    }
    const tx = n.tx - n.x;
    const ty = n.ty - n.y;
    const d = Math.hypot(tx, ty);
    if (d > 0.2) {
      mx = tx / d;
      my = ty / d;
    }
  } else {
    // A merchant turns towards whoever comes up to the stall.
    const p = gs.nearestPlayer(n.x, n.y, 4);
    if (p) n.facing = Math.atan2(p.y - n.y, p.x - n.x);
  }
  const speed = n.fleeT > 0 ? 3.2 : 1.1;
  n.moving = Boolean(mx || my);
  if (n.moving) {
    const nx = n.x + mx * speed * dt;
    const ny = n.y + my * speed * dt;
    if (gs.world.isFree(nx, n.y, n.r, 'enemy')) n.x = nx;
    if (gs.world.isFree(n.x, ny, n.r, 'enemy')) n.y = ny;
    n.facing = Math.atan2(my, mx);
  }
}

// --- People get hurt -------------------------------------------------------------------------------

/**
 * A player's attack may hit people at a market (auto-aim never targets
 * them, but a careless swing or a stray shot can). `inside(x, y, r)` is
 * the attack's shape. Returns true when someone was hit.
 */
export function hitNpcs(gs, p, x, y, reach, damage, inside) {
  if (!gs.markets.size) return false;
  let hit = false;
  for (const entry of gs.markets.values()) {
    if (entry.def.town) continue; // nobody gets hurt in Fristaden
    if ((entry.def.x - x) ** 2 + (entry.def.y - y) ** 2 > (entry.def.r + reach + 4) ** 2) continue;
    for (const n of entry.npcs) {
      if (n.dead || !inside(n.x, n.y, n.r)) continue;
      hurtNpc(gs, p, entry, n, damage);
      hit = true;
    }
  }
  return hit;
}

function hurtNpc(gs, p, entry, n, damage) {
  const dmg = Math.max(1, Math.round(damage));
  n.hp -= dmg;
  n.hurtT = gs.time;
  n.fleeT = 2.5;
  n.fleeFrom = p.id;
  gs.event(n.x, n.y, { k: 'npchurt', id: n.eid, n: dmg }, 24);
  const killed = n.hp <= 0;
  if (killed) {
    n.dead = true;
    n.respawnAt = gs.time + NPC_RESPAWN_S;
    gs.event(n.x, n.y, { k: 'kill', id: n.eid, x: n.x, y: n.y, r: n.r }, 24);
  }
  provoke(gs, p, entry, killed);
}

// --- Trading ---------------------------------------------------------------------------------------

/** The merchant within reach of `p`, with their market, or null. */
export function merchantNear(gs, p, reach = 2.4) {
  for (const entry of gs.markets.values()) {
    for (const n of entry.npcs) {
      if (n.dead || n.role !== 'merchant') continue;
      if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= reach * reach) return { entry, npc: n };
    }
  }
  return null;
}

function inLoadout(p, id) {
  return p.inv.equipped === id || p.inv.secondary === id;
}

function ownWeapon(p, id) {
  return p.inv.bag.find((w) => w.id === id) ?? p.inv.storage.find((w) => w.id === id) ?? null;
}

/** Takes a weapon out of the inventory for good (sold or traded in). */
function removeWeapon(gs, p, id) {
  gs.db.tx(() => {
    gs.db.deleteItem(id, p.accountId);
    players.persist(gs, p);
  });
  p.inv.bag = p.inv.bag.filter((w) => w.id !== id);
  p.inv.storage = p.inv.storage.filter((w) => w.id !== id);
  p.inv.favorites = p.inv.favorites.filter((f) => f !== id);
  gs.send(p, { t: 'inv-', id });
}

/** { t: 'market', op: 'buy'|'sell'|'sellBundle', id, i?, tradeIn?, weapon?, res? } → problem text or null. */
export function request(gs, p, msg) {
  const near = merchantNear(gs, p, TRADE_REACH);
  if (!near || near.entry.def.id !== msg.id) return 'Gå fram till en köpman';
  const m = near.entry.def;
  if (isHostile(p, m.id)) return 'Ingen här vill handla med dig just nu';
  const r = p.ch.resources;
  const save = base.saveFor(gs, p);
  const st = state(p, m.id);
  if (msg.op === 'buy') {
    const stock = marketStock(gs.data, save, m);
    const i = Number(msg.i);
    const item = stock.items[i];
    if (!item) return 'Den varan finns inte längre';
    if (st.period === stock.period && st.bought.includes(i)) return 'Redan såld';
    const dna = item.kind === 'weapon' ? generateWeapon(gs.data, item.request) : null;
    let price = item.kind === 'weapon' ? weaponPrice(dna, item.markup) : item.price;
    let tradeIn = null;
    if (msg.tradeIn) {
      const id = String(msg.tradeIn);
      if (inLoadout(p, id)) return 'Ta först bort det vapnet ur din utrustning';
      tradeIn = ownWeapon(p, id);
      if (!tradeIn) return 'Det vapnet har du inte';
      price = Math.max(0, price - sellPrice(tradeIn));
    }
    if ((r.gold ?? 0) < price) return `Kräver ${price - (r.gold ?? 0)} guld till`;
    const sizes = base.sizesFor(gs, p);
    if (item.kind === 'weapon' && !tradeIn && p.inv.bag.length >= sizes.bagSize) return 'Väskan är full';
    r.gold -= price;
    if (tradeIn) removeWeapon(gs, p, tradeIn.id);
    switch (item.kind) {
      case 'weapon':
        // A fresh id: the same stock can be on sale to someone else too.
        if (!loot.giveWeapon(gs, p, { ...dna, id: loot.newItemId() }, 'market')) {
          r.gold += price;
          return 'Väskan är full';
        }
        break;
      case 'bundle':
        r[item.res] = (r[item.res] ?? 0) + item.qty;
        break;
      case 'component':
        loot.discoverComponent(gs, p, item.id);
        break;
      case 'shard':
        r.shards = (r.shards ?? 0) + item.qty;
        break;
      default:
        break;
    }
    if (st.period !== stock.period) {
      st.period = stock.period;
      st.bought = [];
    }
    st.bought.push(i);
    gs.db.log(p.accountId, 'market-buy', null, { market: m.id, kind: item.kind, price });
    players.persist(gs, p);
    players.markMe(p);
    return null;
  }
  if (msg.op === 'sell') {
    const id = String(msg.weapon ?? '');
    if (inLoadout(p, id)) return 'Ta först bort det vapnet ur din utrustning';
    const dna = ownWeapon(p, id);
    if (!dna) return 'Det vapnet har du inte';
    const price = sellPrice(dna);
    r.gold = (r.gold ?? 0) + price;
    removeWeapon(gs, p, id);
    gs.db.log(p.accountId, 'market-sell', id, { market: m.id, price });
    players.markMe(p);
    return null;
  }
  if (msg.op === 'sellBundle') {
    const b = SELL_BUNDLES.find((x) => x.res === msg.res);
    if (!b) return 'Det köper de inte';
    if ((r[b.res] ?? 0) < b.qty) return `Du behöver ${b.qty} ${b.res}`;
    r[b.res] -= b.qty;
    r.gold = (r.gold ?? 0) + b.price;
    players.persist(gs, p);
    players.markMe(p);
    return null;
  }
  return 'Okänd begäran';
}
