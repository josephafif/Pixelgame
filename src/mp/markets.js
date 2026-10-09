// Markets on the multiplayer client. The world says where every market
// stands and how it is built, so its walls, gates, turrets and stalls are
// placed here exactly as the server places them (you collide with them as
// you walk, with no waiting). The people come from the server, and every
// trade is checked there; the market panel gets its answers at once (the
// server corrects them if it disagrees).

import { marketLayout, weaponPrice, sellPrice } from '../game/markets.js';
import { structureDef } from '../game/construction.js';
import { tileKey } from '../game/world.js';

const ACTIVATE = 46;
const DEACTIVATE = 72;
const NPC_HP = 60;

const MARKET_DEFS = {
  stall: { id: 'stall', name: 'Stall', kind: 'decor', hp: 999 },
  crate: { id: 'crate', name: 'Crate', kind: 'decor', hp: 999 },
};

const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });

export class MpMarkets {
  constructor(game) {
    this.game = game;
    this.active = new Map(); // id → { def, structures, layout }
    this.structures = [];
    this.npcs = [];
    this.checkT = 0;
  }

  // --- Your standing (from the server) ------------------------------------------------

  state(id) {
    const all = (this.game.me ??= {}).markets ??= {};
    all[id] ??= { visited: false, hostileUntil: 0, period: 0, bought: [] };
    return all[id];
  }

  isHostile(id, now = Date.now()) {
    return (this.game.me?.markets?.[id]?.hostileUntil ?? 0) > now;
  }

  hostileSecondsLeft(id, now = Date.now()) {
    return Math.max(0, Math.ceil(((this.game.me?.markets?.[id]?.hostileUntil ?? 0) - now) / 1000));
  }

  isBought(id, period, i) {
    const st = this.game.me?.markets?.[id];
    return Boolean(st && st.period === period && st.bought.includes(i));
  }

  // --- Walls and turrets, placed like the server places them ----------------------------

  update(dt) {
    const g = this.game;
    const p = g.player;
    this.checkT -= dt;
    if (this.checkT <= 0 && g.world) {
      this.checkT = 0.5;
      for (const m of g.world.marketsNear(p.x, p.y, ACTIVATE)) if (!this.active.has(m.id)) this.#activate(m);
      for (const [id, entry] of this.active) {
        if (Math.hypot(entry.def.x - p.x, entry.def.y - p.y) > DEACTIVATE) this.#deactivate(id);
      }
    }
    for (const entry of this.active.values()) {
      for (const st of entry.structures) {
        if (st.rt.flash > 0) st.rt.flash -= dt;
        if (st.def.kind === 'gate') {
          let near = !p.dead && (p.x - st.x - 0.5) ** 2 + (p.y - st.y - 0.5) ** 2 < 1.6 * 1.6;
          for (const o of g.others) if ((o.x - st.x - 0.5) ** 2 + (o.y - st.y - 0.5) ** 2 < 1.6 * 1.6) near = true;
          st.rt.open = Math.max(0, Math.min(1, st.rt.open + (near ? dt : -dt) * 6));
        }
      }
    }
  }

  layoutOf(m) {
    return this.active.get(m.id)?.layout ?? marketLayout(m);
  }

  #activate(m) {
    const g = this.game;
    const layout = marketLayout(m);
    const structures = [];
    for (const s of layout.structs) {
      const def = MARKET_DEFS[s.id] ?? structureDef(g.data, s.id);
      if (!def) continue;
      const st = { id: s.id, x: m.x + s.x, y: m.y + s.y, hp: def.hp, owner: 'market', marketId: m.id, color: m.color };
      hidden(st, 'def', def);
      hidden(st, 'rt', { cd: 0, aim: -Math.PI / 2, flash: 0, trig: -9, open: 0 });
      const layer = def.kind === 'floor' ? g.world.floors : g.world.structures;
      const key = tileKey(st.x, st.y);
      if (layer.has(key)) continue;
      layer.set(key, st);
      structures.push(st);
    }
    this.active.set(m.id, { def: m, structures, layout });
    this.structures = [...this.active.values()].flatMap((e) => e.structures);
    // First time here: it goes on your map (the server says hello too).
    g.emit('map');
  }

  #deactivate(id) {
    const g = this.game;
    const entry = this.active.get(id);
    if (!entry) return;
    for (const st of entry.structures) {
      const layer = st.def.kind === 'floor' ? g.world.floors : g.world.structures;
      const key = tileKey(st.x, st.y);
      if (layer.get(key) === st) layer.delete(key);
    }
    this.active.delete(id);
    this.structures = [...this.active.values()].flatMap((e) => e.structures);
  }

  /** A market turret fired (its aim and muzzle flash). */
  turretFired(ev) {
    const st = this.game.world.structureAt(ev.x, ev.y);
    if (!st?.marketId) return;
    st.rt.aim = ev.aim;
    st.rt.flash = 0.06;
  }

  // --- People (from the server) ------------------------------------------------------------

  /** A person from a snapshot: who they are comes from their market's layout. */
  person(obj, info, dt, time) {
    const g = this.game;
    let o = obj;
    if (!o) {
      const m = g.world.marketForCell(info.mx, info.my);
      if (!m) return null;
      const who = this.layoutOf(m).npcs[info.idx];
      if (!who) return null;
      o = {
        marketId: m.id, role: who.role, name: who.name, cloak: who.cloak, r: 0.32,
        x: info.x, y: info.y, facing: info.facing, walkT: 0, hurtFlash: 0, hp: info.hp, maxHp: NPC_HP, dead: false,
      };
    }
    o.x = info.x;
    o.y = info.y;
    o.facing = info.facing;
    o.moving = info.moving;
    if (o.moving) o.walkT += dt * 8;
    if (info.hurt) o.hurtFlash = 0.15;
    o.hurtFlash = Math.max(0, o.hurtFlash - dt);
    o.hp = info.hp;
    void time;
    return o;
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

  // --- Trading: the same checks as single player here, the final word on the server ----------

  #markBought(id, period, i) {
    const st = this.state(id);
    if (st.period !== period) {
      st.period = period;
      st.bought = [];
    }
    st.bought.push(i);
  }

  buy(m, stock, i, { dna = null, tradeInId = null } = {}) {
    const g = this.game;
    const item = stock.items[i];
    if (!item) throw new Error('That item is gone');
    if (this.isHostile(m.id)) throw new Error('Nobody here will trade with you right now');
    if (this.isBought(m.id, stock.period, i)) throw new Error('Already sold');
    const res = g.save.resources;
    let price = item.kind === 'weapon' ? weaponPrice(dna, item.markup) : item.price;
    if (tradeInId) {
      if (g.inLoadout(tradeInId)) throw new Error('Swap that weapon out of your loadout first');
      const t = g.findWeapon(tradeInId);
      if (!t) throw new Error('That weapon is gone');
      price = Math.max(0, price - sellPrice(t));
    }
    if ((res.gold ?? 0) < price) throw new Error(`Needs ${price - (res.gold ?? 0)} more gold`);
    this.#markBought(m.id, stock.period, i);
    res.gold -= price;
    g.marketRequest({ op: 'buy', id: m.id, i, tradeIn: tradeInId });
    g.audio.play('chest');
    g.emit('inventory');
    return price;
  }

  sellWeapon(m, id) {
    const g = this.game;
    if (this.isHostile(m.id)) throw new Error('Nobody here will trade with you right now');
    if (g.inLoadout(id)) throw new Error('Swap that weapon out of your loadout first');
    const dna = g.findWeapon(id);
    if (!dna) throw new Error('That weapon is gone');
    const price = sellPrice(dna);
    g.save.resources.gold = (g.save.resources.gold ?? 0) + price;
    g.marketRequest({ op: 'sell', id: m.id, weapon: id });
    g.audio.play('pickup');
    g.emit('inventory');
    return price;
  }

  sellBundle(m, bundle) {
    const g = this.game;
    if (this.isHostile(m.id)) throw new Error('Nobody here will trade with you right now');
    const res = g.save.resources;
    if ((res[bundle.res] ?? 0) < bundle.qty) throw new Error(`You need ${bundle.qty} ${bundle.res}`);
    res[bundle.res] -= bundle.qty;
    res.gold = (res.gold ?? 0) + bundle.price;
    g.marketRequest({ op: 'sellBundle', id: m.id, res: bundle.res });
    g.audio.play('pickup');
    g.emit('inventory');
    return bundle.price;
  }
}
