// Markets: rare, fortified trading posts out in the world. Every market has
// its own layout (bazaar, round fort, palisade, open oasis), walls, gates and
// turrets that keep monsters out, merchants behind stalls and villagers
// milling about. Hurt or kill anyone there and the turrets turn on you for a
// few minutes (and nobody will trade with you).
//
// Stock rotates every 20 minutes and is deterministic per world + market +
// period. Prices are steep on purpose: markets help, they don't carry you.

import { createRng, hashInts } from '../core/rng.js';
import { tileKey } from './world.js';
import { structureDef, runTurret } from './construction.js';
import { buyPrice, sellPrice, weaponValue, EPIC_CHANCE } from './economy.js';
import { researchedComponents } from '../weapons/crafting.js';
import { researchCost } from './base.js';

const ACTIVATE = 46;
const DEACTIVATE = 72;
export const RESTOCK_MS = 20 * 60 * 1000;
const HOSTILE_HURT_MS = 3 * 60 * 1000;
const HOSTILE_KILL_MS = 5 * 60 * 1000;
const NPC_HP = 60;

const MERCHANT_NAMES = [
  'Ada', 'Borin', 'Cass', 'Dagny', 'Emil', 'Freya', 'Gunnar', 'Hilda', 'Ivo', 'Juni', 'Kasper', 'Liv',
  'Mika', 'Nils', 'Otto', 'Pia', 'Rune', 'Sigrid', 'Tove', 'Ulla', 'Vera', 'Yngve',
];
const CLOAKS = ['#c8364a', '#e0a030', '#4fb04f', '#9a5cff', '#e86a2a', '#3fb0b0', '#b07a48', '#8d8a9e'];

// Market-only structures (the rest reuse the camp's walls, gates, turrets).
const MARKET_DEFS = {
  stall: { id: 'stall', name: 'Stall', kind: 'decor', hp: 999 },
  crate: { id: 'crate', name: 'Crate', kind: 'decor', hp: 999 },
};

function defFor(data, id) {
  return MARKET_DEFS[id] ?? structureDef(data, id);
}

// --- Layouts -------------------------------------------------------------------------

/**
 * Tiles (relative to the market centre) for a market's structures and NPCs.
 * Pure and deterministic, so tests can check every layout.
 */
export function marketLayout(m) {
  const rng = createRng(m.seed ^ 0x51a11);
  const wall = m.material === 'stone' ? 'stone_wall' : 'wood_wall';
  const floor = m.material === 'stone' ? 'stone_floor' : 'wood_floor';
  const structs = new Map();
  const put = (id, x, y) => structs.set(`${x},${y}`, { id, x, y });
  const stalls = [];
  const stall = (x, y) => {
    put('stall', x, y);
    put('stall', x + 1, y);
    stalls.push({ x: x + 1, y: y - 1 }); // merchant stands behind (north of) the stall
  };
  const r = m.r;
  switch (m.layout) {
    case 'bazaar': {
      const s = r - 1;
      for (let d = -s; d <= s; d++) {
        put(wall, d, -s);
        put(wall, d, s);
        put(wall, -s, d);
        put(wall, s, d);
      }
      for (const [x, y] of [[0, -s], [0, s], [-s, 0], [s, 0]]) put('gate', x, y);
      for (const [x, y] of [[-s + 1, -s + 1], [s - 1, -s + 1], [-s + 1, s - 1], [s - 1, s - 1]]) put('arrow_turret', x, y);
      stall(-3, -2);
      stall(2, -2);
      stall(-3, 3);
      stall(2, 3);
      for (const [x, y] of [[-1, -s + 1], [1, -s + 1], [-1, s - 1], [1, s - 1]]) put('torch', x, y);
      put('banner', 0, -1);
      for (let d = -s + 1; d <= s - 1; d++) {
        if (!structs.has(`0,${d}`)) put(floor, 0, d);
        if (!structs.has(`${d},0`)) put(floor, d, 0);
      }
      break;
    }
    case 'fort': {
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const d = Math.hypot(x, y);
          if (d <= r - 0.5 && d > r - 1.5) put(wall, x, y);
        }
      }
      for (const [x, y] of [[0, -(r - 1)], [0, r - 1]]) {
        structs.delete(`${x},${y}`);
        put('gate', x, y);
      }
      const t = Math.round((r - 3) * 0.72);
      for (const [x, y] of [[-t, -t], [t, -t], [-t, t], [t, t]]) put(rng.next() < 0.5 ? 'flame_turret' : 'arrow_turret', x, y);
      stall(-4, -1);
      stall(2, -1);
      stall(-1, 3);
      put('crate', -2, 3);
      put('crate', 2, 3);
      put('torch', -1, -(r - 2));
      put('torch', 1, -(r - 2));
      put('banner', 0, 1);
      break;
    }
    case 'palisade': {
      const inside = (x, y) => Math.abs(x) <= r - 1 && Math.abs(y) <= r - 1 && Math.abs(x) + Math.abs(y) <= (r - 1) * 1.45;
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          if (!inside(x, y)) continue;
          if (!inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1)) put(wall, x, y);
        }
      }
      structs.delete(`0,${r - 1}`);
      put('gate', 0, r - 1);
      put('spikes', -1, r);
      put('spikes', 1, r);
      const t = r - 3;
      put('flame_turret', -t, t - 1);
      put('flame_turret', t, t - 1);
      put('arrow_turret', -t + 1, -t + 1);
      put('arrow_turret', t - 1, -t + 1);
      stall(-2, -2);
      stall(-4, 1);
      stall(3, 1);
      put('torch', -1, r - 2);
      put('torch', 1, r - 2);
      put('banner', 0, 0);
      break;
    }
    default: { // oasis: open fence ring, lots of turrets
      for (let a = 0; a < 48; a++) {
        if (Math.floor(a / 4) % 2) continue; // gaps between fence runs
        const ang = (a / 48) * Math.PI * 2;
        put(wall, Math.round(Math.cos(ang) * (r - 1)), Math.round(Math.sin(ang) * (r - 1)));
      }
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2 + 0.26;
        put(k % 2 ? 'flame_turret' : 'arrow_turret', Math.round(Math.cos(ang) * (r - 3)), Math.round(Math.sin(ang) * (r - 3)));
      }
      stall(-3, -3);
      stall(2, -3);
      stall(-1, 3);
      for (const [x, y] of [[-1, 0], [0, 0], [-1, 1], [0, 1]]) put(floor, x, y);
      put('torch', -2, 0);
      put('torch', 1, 1);
      put('banner', 1, -1);
      break;
    }
  }
  // Keep merchants' spots free.
  for (const s of stalls) structs.delete(`${s.x},${s.y}`);
  const npcs = stalls.map((s, i) => ({
    x: s.x, y: s.y, role: 'merchant',
    name: MERCHANT_NAMES[(m.seed + i * 7) % MERCHANT_NAMES.length],
    cloak: CLOAKS[(m.seed + i * 3) % CLOAKS.length],
  }));
  // Two villagers start on free tiles near the middle (floors are fine).
  const free = (x, y) => {
    const st = structs.get(`${x},${y}`);
    return (!st || st.id === floor) && !npcs.some((n) => n.x === x && n.y === y);
  };
  const spots = [[-1, -1], [1, 1], [1, -1], [-1, 1], [0, 2], [0, -2], [2, 0], [-2, 0]].filter(([x, y]) => free(x, y));
  for (let i = 0; i < 2 && i < spots.length; i++) {
    npcs.push({
      x: spots[i][0], y: spots[i][1], role: 'villager',
      name: MERCHANT_NAMES[(m.seed + 11 + i * 5) % MERCHANT_NAMES.length],
      cloak: CLOAKS[(m.seed + 5 + i) % CLOAKS.length],
    });
  }
  return { structs: [...structs.values()], npcs };
}

// --- Stock -------------------------------------------------------------------------

/**
 * What a market sells this period. Weapons are generator requests; the UI
 * turns them into weapons (cached) before showing them.
 */
export function marketStock(data, save, m, now = Date.now()) {
  const period = Math.floor(now / RESTOCK_MS);
  const seed = hashInts(save.worldSeed, m.seed, period);
  const rng = createRng(seed);
  const level = Math.max(1, save.player.level);
  const items = [];
  for (let i = 0; i < 3; i++) {
    // Now and then a trader has a legendary on display, at a fortune.
    const legendary = i === 0 && rng.next() < 0.04;
    // Epics are a rare sight too; most stock is uncommon or rare.
    const epic = !legendary && rng.next() < EPIC_CHANCE.market;
    const minRarity = legendary ? 'legendary' : epic ? 'epic' : rng.next() < 0.35 ? 'rare' : 'uncommon';
    items.push({
      kind: 'weapon',
      request: {
        seed: hashInts(seed, 0x3e11, i), level, luck: 0, source: 'market',
        unlocked: researchedComponents(save), minRarity, maxRarity: legendary ? 'legendary' : epic ? 'epic' : 'rare',
      },
      markup: legendary ? 2.2 : 1,
    });
  }
  const scale = 1 + level * 0.03;
  items.push(
    { kind: 'bundle', res: 'wood', qty: 20, price: Math.round(30 * scale) },
    { kind: 'bundle', res: 'stone', qty: 20, price: Math.round(36 * scale) },
    { kind: 'bundle', res: 'scrap', qty: 15, price: Math.round(60 * scale) },
    { kind: 'bundle', res: 'essence', qty: 25, price: Math.round(110 * scale) },
  );
  const pool = data.components.filter((c) => !c.boss && c.research > 0 && !save.components[c.id]?.researched);
  if (pool.length) {
    const c = pool[Math.floor(rng.next() * pool.length)];
    items.push({ kind: 'component', id: c.id, price: Math.round(150 + researchCost(data, save, c) * 1.5) });
  }
  if (rng.next() < 0.35) items.push({ kind: 'shard', qty: 1, price: 4000 });
  return { period, items, restockAt: (period + 1) * RESTOCK_MS };
}

/** Gold for selling resources back (a third of what they cost). */
export const SELL_BUNDLES = [
  { res: 'wood', qty: 20, price: 8 },
  { res: 'stone', qty: 20, price: 10 },
  { res: 'scrap', qty: 15, price: 18 },
  { res: 'essence', qty: 25, price: 35 },
];

export function weaponPrice(dna, markup = 1) {
  return Math.round(buyPrice(dna) * markup);
}

export { sellPrice, weaponValue };

// --- Runtime -------------------------------------------------------------------------

const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });

export class Markets {
  constructor(game) {
    this.game = game;
    this.active = new Map(); // id → { def, structures, npcs }
    this.checkT = 0;
    this.npcs = [];
    this.structures = [];
  }

  state(id) {
    const all = this.game.save.markets;
    all[id] ??= { visited: false, seen: false, hostileUntil: 0, period: 0, bought: [] };
    return all[id];
  }

  isHostile(id, now = Date.now()) {
    return (this.game.save.markets[id]?.hostileUntil ?? 0) > now;
  }

  hostileSecondsLeft(id, now = Date.now()) {
    return Math.max(0, Math.ceil(((this.game.save.markets[id]?.hostileUntil ?? 0) - now) / 1000));
  }

  update(dt) {
    const g = this.game;
    const p = g.player;
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.5;
      for (const m of g.world.marketsNear(p.x, p.y, ACTIVATE)) {
        if (!this.active.has(m.id)) this.#activate(m);
      }
      for (const [id, entry] of this.active) {
        const d = Math.hypot(entry.def.x - p.x, entry.def.y - p.y);
        if (d > DEACTIVATE) this.#deactivate(id);
        const st = this.state(id);
        if (!st.seen && d < 26) {
          st.seen = true;
          g.emit('map');
        }
        if (!st.visited && d < entry.def.r + 1) {
          st.visited = true;
          g.toast(`You found ${entry.def.name}! Merchants trade weapons and goods here.`, 'component');
          g.audio.play('chest');
          g.emit('map');
          g.requestSave();
        }
      }
    }
    for (const [id, entry] of this.active) {
      const hostile = this.isHostile(id);
      for (const st of entry.structures) {
        if (st.rt.flash > 0) st.rt.flash -= dt;
        // Angry turrets cover the whole market and a ring around its walls.
        if (st.def.kind === 'turret') runTurret(g, st, dt, { hostile, range: hostile ? entry.def.r * 1.6 + 3 : st.def.turret.range + 1 });
        else if (st.def.kind === 'gate') {
          const near = !p.dead && (p.x - st.x - 0.5) ** 2 + (p.y - st.y - 0.5) ** 2 < 1.6 * 1.6;
          st.rt.open = Math.max(0, Math.min(1, st.rt.open + (near ? dt : -dt) * 6));
        }
      }
      for (const n of entry.npcs) this.#updateNpc(n, entry.def, dt, hostile);
    }
  }

  #activate(m) {
    const g = this.game;
    const cx = m.x;
    const cy = m.y;
    const layout = marketLayout(m);
    const structures = [];
    for (const s of layout.structs) {
      const def = defFor(g.data, s.id);
      if (!def) continue;
      const st = { id: s.id, x: cx + s.x, y: cy + s.y, hp: def.hp, owner: 'market', marketId: m.id, color: m.color };
      hidden(st, 'def', def);
      hidden(st, 'rt', { cd: Math.random(), aim: -Math.PI / 2, flash: 0, trig: -9, open: 0 });
      // Never overwrite a player-built structure or block the world.
      const key = tileKey(st.x, st.y);
      if (g.world.structures.has(key)) continue;
      g.world.structures.set(key, st);
      structures.push(st);
    }
    const npcs = layout.npcs.map((n, i) => ({
      id: `${m.id}#${i}`, marketId: m.id, role: n.role, name: n.name, cloak: n.cloak,
      x: cx + n.x + 0.5, y: cy + n.y + 0.5, homeX: cx + n.x + 0.5, homeY: cy + n.y + 0.5,
      r: 0.32, hp: NPC_HP, maxHp: NPC_HP, facing: Math.PI / 2, moving: false, walkT: 0,
      hurtFlash: 0, dead: false, wanderT: Math.random() * 3, tx: cx + n.x + 0.5, ty: cy + n.y + 0.5,
    }));
    this.active.set(m.id, { def: m, structures, npcs });
    this.#refresh();
  }

  #deactivate(id) {
    const entry = this.active.get(id);
    if (!entry) return;
    for (const st of entry.structures) {
      const key = tileKey(st.x, st.y);
      if (this.game.world.structures.get(key) === st) this.game.world.structures.delete(key);
    }
    this.active.delete(id);
    this.#refresh();
  }

  #refresh() {
    this.structures = [...this.active.values()].flatMap((e) => e.structures);
    this.npcs = [...this.active.values()].flatMap((e) => e.npcs);
  }

  #updateNpc(n, m, dt, hostile) {
    const g = this.game;
    const p = g.player;
    n.hurtFlash = Math.max(0, n.hurtFlash - dt);
    if (n.dead) return;
    const dx = p.x - n.x;
    const dy = p.y - n.y;
    const near = dx * dx + dy * dy < 16;
    let mx = 0;
    let my = 0;
    if (n.fleeT > 0) {
      n.fleeT -= dt;
      const d = Math.hypot(dx, dy) || 1;
      mx = -dx / d;
      my = -dy / d;
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
    }
    const speed = n.fleeT > 0 ? 3.2 : 1.1;
    n.moving = Boolean(mx || my);
    if (n.moving) {
      const nx = n.x + mx * speed * dt;
      const ny = n.y + my * speed * dt;
      if (g.world.isFree(nx, n.y, n.r, 'enemy')) n.x = nx;
      if (g.world.isFree(n.x, ny, n.r, 'enemy')) n.y = ny;
      n.walkT += dt * 8;
      n.facing = Math.atan2(my, mx);
    } else if (near && !hostile) {
      n.facing = Math.atan2(dy, dx);
    }
  }

  /** The merchant you can talk to right now (within reach), or null. */
  merchantNear(x, y, reach = 1.6) {
    let best = null;
    let bestD = reach * reach;
    for (const n of this.npcs) {
      if (n.dead || n.role !== 'merchant') continue;
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /**
   * Your attacks can hit people at the market (auto-aim never targets
   * them, but a careless swing or a stray explosion can). Shapes:
   * { kind: 'arc', x, y, angle, range, half } | { kind: 'line', x, y, ex, ey, width } |
   * { kind: 'circle', x, y, r }.
   */
  hitNpcs(shape, damage) {
    let hit = false;
    for (const n of this.npcs) {
      if (n.dead || !this.#inShape(n, shape)) continue;
      this.#hurt(n, damage);
      hit = true;
    }
    return hit;
  }

  #inShape(n, s) {
    if (s.kind === 'circle') return (n.x - s.x) ** 2 + (n.y - s.y) ** 2 <= (s.r + n.r) ** 2;
    if (s.kind === 'arc') {
      const d = Math.hypot(n.x - s.x, n.y - s.y);
      if (d > s.range + n.r) return false;
      let diff = Math.atan2(n.y - s.y, n.x - s.x) - s.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      return d < n.r + 0.4 || Math.abs(diff) <= s.half + Math.atan2(n.r, d);
    }
    if (s.kind === 'line') {
      const vx = s.ex - s.x;
      const vy = s.ey - s.y;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((n.x - s.x) * vx + (n.y - s.y) * vy) / len2));
      const px = s.x + vx * t - n.x;
      const py = s.y + vy * t - n.y;
      return px * px + py * py <= (s.width / 2 + n.r) ** 2;
    }
    return false;
  }

  #hurt(n, damage) {
    const g = this.game;
    const dmg = Math.max(1, Math.round(damage));
    n.hp -= dmg;
    n.hurtFlash = 0.15;
    n.fleeT = 2.5;
    g.fx.number(n.x, n.y - 0.6, dmg, { color: '#ff8a8a' });
    g.fx.emit('blood', n.x, n.y - 0.3, 4, 0.3, 2);
    const killed = n.hp <= 0;
    if (killed) {
      n.dead = true;
      g.fx.emit('smoke', n.x, n.y, 10, 0.5, 1.5);
    }
    this.provoke(n.marketId, killed);
  }

  /** Someone at the market was hurt: the turrets turn on you. */
  provoke(id, killed) {
    const g = this.game;
    const st = this.state(id);
    const now = Date.now();
    const until = now + (killed ? HOSTILE_KILL_MS : HOSTILE_HURT_MS);
    const was = st.hostileUntil > now;
    st.hostileUntil = Math.max(st.hostileUntil, until);
    const m = this.active.get(id)?.def ?? g.world.marketById(id);
    if (!was || killed) {
      g.toast(killed
        ? `You killed someone at ${m?.name ?? 'the market'}! Its turrets hunt you for ${Math.round((st.hostileUntil - now) / 60000)} minutes.`
        : `The guards of ${m?.name ?? 'the market'} turn their turrets on you!`, 'boss');
      g.audio.play('boss');
    }
    g.requestSave();
  }

  // --- Trading -----------------------------------------------------------------------

  /** Marks item `i` of the current stock bought (resetting when stock rotates). */
  #markBought(id, period, i) {
    const st = this.state(id);
    if (st.period !== period) {
      st.period = period;
      st.bought = [];
    }
    st.bought.push(i);
  }

  isBought(id, period, i) {
    const st = this.game.save.markets[id];
    return Boolean(st && st.period === period && st.bought.includes(i));
  }

  /**
   * Buys stock item `i`. For weapons pass the generated `dna`; `tradeInId`
   * gives one of your weapons in part-exchange. Returns a message or throws.
   */
  buy(m, stock, i, { dna = null, tradeInId = null } = {}) {
    const g = this.game;
    const item = stock.items[i];
    if (!item) throw new Error('That item is gone');
    if (this.isHostile(m.id)) throw new Error('Nobody here will trade with you right now');
    if (this.isBought(m.id, stock.period, i)) throw new Error('Already sold');
    const res = g.save.resources;
    const inv = g.save.inventory;
    let price = item.kind === 'weapon' ? weaponPrice(dna, item.markup) : item.price;
    let tradeIn = null;
    if (tradeInId) {
      if (g.inLoadout(tradeInId)) throw new Error('Swap that weapon out of your loadout first');
      tradeIn = g.findWeapon(tradeInId);
      if (!tradeIn) throw new Error('That weapon is gone');
      price = Math.max(0, price - sellPrice(tradeIn));
    }
    if ((res.gold ?? 0) < price) throw new Error(`Needs ${price - (res.gold ?? 0)} more gold`);
    if (item.kind === 'weapon') {
      if (!tradeIn && inv.bag.length >= inv.bagSize && inv.storage.length >= inv.storageSize) throw new Error('No room for another weapon');
    }
    res.gold -= price;
    if (tradeIn) g.removeWeapon(tradeIn.id);
    switch (item.kind) {
      case 'weapon':
        g.addWeapon(dna);
        break;
      case 'bundle':
        res[item.res] = (res[item.res] ?? 0) + item.qty;
        break;
      case 'component':
        g.discoverComponent(item.id);
        break;
      case 'shard':
        res.shards = (res.shards ?? 0) + item.qty;
        break;
      default:
        break;
    }
    this.#markBought(m.id, stock.period, i);
    g.audio.play('chest');
    g.emit('inventory');
    g.saveNow();
    return price;
  }

  /** Sells a weapon from your bag/storage. */
  sellWeapon(m, id) {
    const g = this.game;
    if (this.isHostile(m.id)) throw new Error('Nobody here will trade with you right now');
    if (g.inLoadout(id)) throw new Error('Swap that weapon out of your loadout first');
    const dna = g.findWeapon(id);
    if (!dna) throw new Error('That weapon is gone');
    const price = sellPrice(dna);
    g.removeWeapon(id);
    g.save.resources.gold = (g.save.resources.gold ?? 0) + price;
    g.audio.play('pickup');
    g.emit('inventory');
    g.saveNow();
    return price;
  }

  sellBundle(m, bundle) {
    const g = this.game;
    if (this.isHostile(m.id)) throw new Error('Nobody here will trade with you right now');
    const res = g.save.resources;
    if ((res[bundle.res] ?? 0) < bundle.qty) throw new Error(`You need ${bundle.qty} ${bundle.res}`);
    res[bundle.res] -= bundle.qty;
    res.gold = (res.gold ?? 0) + bundle.price;
    g.audio.play('pickup');
    g.emit('inventory');
    g.requestSave();
    return bundle.price;
  }
}
