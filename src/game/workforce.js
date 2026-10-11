// The camp's workforce and supplies in single player: workers hired at the
// Workers' Lodge (behaviour in workers.js), the Vault's stock of wood, stone,
// scrap and essence, and the upkeep that keeps the camp running (upkeep.js).
//
// Saved in save.base: workers ([{ id, role }]), nextWorker, vault, owed,
// upkeepAt (the last whole hour charged) and unpaid. Upkeep is charged every
// hour of real time, also while you are away (up to base.upkeep.catchUpHours;
// paid workers bring in a rough share for those hours too).

import { buildingDef, buildingLevel, campRank, canAfford, pay, shortfalls } from './base.js';
import {
  workerCap, hireCost, workerStats, createWorker, stepWorker, hurtWorker, inShape, workerLook, awayYield,
  WORKER_ROLES, ROLE_NAMES,
} from './workers.js';
import { upkeepPerDay, chargeUpkeep, suppliesLast, HOUR_MS, UPKEEP_KEYS } from './upkeep.js';
import { rollDrops } from './gathering.js';

const CHECK_EVERY = 10; // seconds between upkeep checks
const RESOURCE_COLOR = { wood: '#e8c890', stone: '#d0d4e0', scrap: '#c8ccd8', essence: '#7ae0ff', shards: '#ffd24a' };

export class Workforce {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.taken = new Set();
    this.checkT = 1;
    const base = game.save.base;
    base.vault ??= {};
    base.owed ??= {};
    base.workers ??= [];
    base.nextWorker ??= 1;
    this.sync();
  }

  get base() {
    return this.game.save.base;
  }

  lodgeLevel() {
    return buildingLevel(this.game.data, this.game.save, 'lodge');
  }

  /** In front of the lodge's door: where workers set out from and come back to. */
  home() {
    const def = buildingDef(this.game.data, 'lodge');
    return { x: def?.x ?? 0.5, y: (def?.y ?? 0.5) + 1.4 };
  }

  stats() {
    return workerStats(this.game.data, Math.max(1, this.lodgeLevel()));
  }

  cap() {
    return workerCap(this.game.data, this.lodgeLevel());
  }

  /** Runtime workers to match the roster (after a load, a hire or a lodge upgrade). */
  sync() {
    const stats = this.stats();
    const home = this.home();
    const keep = [];
    if (this.lodgeLevel() > 0) {
      for (const rec of this.base.workers) {
        let w = this.list.find((x) => x.id === rec.id);
        if (!w) {
          w = createWorker(rec, { x: home.x + (Math.random() - 0.5) * 2, y: home.y + Math.random() }, stats);
          Object.assign(w, workerLook(0, rec.id));
        }
        w.role = rec.role;
        w.hp = Math.min(stats.hp, w.hp + (stats.hp - w.maxHp));
        w.maxHp = stats.hp;
        keep.push(w);
      }
    }
    for (const w of this.list) if (!keep.includes(w) && w.job) this.taken.delete(`${w.job.tx},${w.job.ty}`);
    this.list = keep;
  }

  // --- Hiring ---------------------------------------------------------------------------------

  hireCost() {
    return hireCost(this.game.data, this.base.workers.length);
  }

  /** Why you can't hire right now (null = you can). */
  hireProblem() {
    if (this.lodgeLevel() < 1) return 'Build the Workers’ Lodge first';
    if (this.base.workers.length >= this.cap()) return 'The lodge is full: upgrade it to house more workers';
    const cost = this.hireCost();
    if (!canAfford(this.game.save.resources, cost)) return shortfalls(this.game.save.resources, cost)[0];
    return null;
  }

  hire(role = 'wood') {
    const problem = this.hireProblem();
    if (problem) throw new Error(problem);
    pay(this.game.save.resources, this.hireCost());
    const rec = { id: this.base.nextWorker++, role: WORKER_ROLES.includes(role) ? role : 'wood' };
    this.base.workers.push(rec);
    this.sync();
    return { ...rec, ...workerLook(0, rec.id) };
  }

  fire(id) {
    const i = this.base.workers.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.base.workers.splice(i, 1);
    this.sync();
    return true;
  }

  setRole(id, role) {
    const rec = this.base.workers.find((r) => r.id === id);
    if (!rec || !WORKER_ROLES.includes(role)) return false;
    rec.role = role;
    const w = this.list.find((x) => x.id === id);
    if (w && w.role !== role) {
      w.role = role;
      if (w.job) this.taken.delete(`${w.job.tx},${w.job.ty}`);
      w.job = null;
      if (w.state === 'go' || w.state === 'work') w.state = 'return';
    }
    return true;
  }

  /** What a worker is doing, for the panel. */
  describe(w) {
    if (w.angry) return 'Angry with you!';
    if (this.base.unpaid) return 'On strike: no wages';
    const carry = Object.entries(w.carry).map(([k, n]) => `${n} ${k}`).join(', ');
    switch (w.state) {
      case 'go': return `Walking to a ${w.job?.info?.name.toLowerCase() ?? 'job'}`;
      case 'work': return `${w.role === 'wood' ? 'Chopping' : 'Mining'} a ${w.job?.info?.name.toLowerCase() ?? 'tree'}`;
      case 'return': return carry ? `Carrying ${carry} home` : 'Walking home';
      default: return `Resting at the lodge (${ROLE_NAMES[w.role].toLowerCase()})`;
    }
  }

  // --- The Vault's supplies ----------------------------------------------------------------------

  /** Moves resources from your pockets into the Vault (once it is built). */
  deposit(res) {
    if (buildingLevel(this.game.data, this.game.save, 'vault') < 1) return 0;
    const mine = this.game.save.resources;
    let moved = 0;
    for (const [k, n] of Object.entries(res)) {
      if (!UPKEEP_KEYS.includes(k)) continue;
      const amount = Math.min(Math.floor(n), Math.floor(mine[k] ?? 0));
      if (amount <= 0) continue;
      mine[k] -= amount;
      this.base.vault[k] = (this.base.vault[k] ?? 0) + amount;
      moved += amount;
    }
    if (moved) this.#changed();
    return moved;
  }

  withdraw(res) {
    const mine = this.game.save.resources;
    let moved = 0;
    for (const [k, n] of Object.entries(res)) {
      const amount = Math.min(Math.floor(n), Math.floor(this.base.vault[k] ?? 0));
      if (amount <= 0) continue;
      this.base.vault[k] -= amount;
      mine[k] = (mine[k] ?? 0) + amount;
      moved += amount;
    }
    if (moved) this.#changed();
    return moved;
  }

  #changed() {
    this.game.emit('base');
    this.game.emit('inventory');
    this.game.requestSave();
  }

  // --- Upkeep ------------------------------------------------------------------------------------

  rates() {
    const { data } = this.game;
    const u = data.base.upkeep ?? {};
    return {
      perStructure: u.perStructurePerDay ?? {},
      perBuildingLevel: u.perBuildingLevelPerDay ?? {},
      perWorker: data.base.workers?.wagePerDay ?? {},
    };
  }

  counts() {
    const { data, save } = this.game;
    return { structures: save.base.structures.length, buildingLevels: campRank(data, save), workers: this.base.workers.length };
  }

  /** Upkeep per day: { structures, buildings, workers, total }. */
  perDay() {
    return upkeepPerDay(this.counts(), this.rates());
  }

  /** Hours the Vault's supplies alone cover. */
  suppliesLast() {
    return suppliesLast(this.base.vault, this.perDay().total);
  }

  /**
   * Charges every whole hour since the last charge. More than one hour at
   * once means you were away: paid workers bring in a rough day's share for
   * those hours, and hours beyond base.upkeep.catchUpHours are forgiven.
   */
  chargeDue(now = Date.now()) {
    const base = this.base;
    const cap = this.game.data.base.upkeep?.catchUpHours ?? 12;
    if (!base.upkeepAt) base.upkeepAt = now;
    let hours = Math.floor((now - base.upkeepAt) / HOUR_MS);
    if (hours <= 0) return 0;
    if (hours > cap) {
      base.upkeepAt = now - cap * HOUR_MS;
      hours = cap;
    }
    const away = hours > 1;
    const brought = {};
    for (let i = 0; i < hours; i++) {
      const perDay = this.perDay().total;
      const paid = chargeUpkeep(perDay, 1, base.owed, [base.vault, this.game.save.resources]);
      this.#setUnpaid(!paid);
      if (!paid) this.#decay();
      else if (away && i < hours - 1) {
        for (const rec of base.workers) {
          for (const [k, n] of Object.entries(awayYield(this.game.data, rec.role, this.lodgeLevel()))) {
            brought[k] = (brought[k] ?? 0) + n;
          }
        }
      }
      base.upkeepAt += HOUR_MS;
    }
    const got = Object.entries(brought).map(([k, n]) => [k, Math.floor(n)]).filter(([, n]) => n > 0);
    for (const [k, n] of got) base.vault[k] = (base.vault[k] ?? 0) + n;
    if (got.length) {
      this.game.schedule(2, () => this.game.toast(`While you were away your workers brought in ${got.map(([k, n]) => `${n} ${k}`).join(' and ')} (in the Vault).`, 'component'));
    }
    this.#changed();
    return hours;
  }

  #setUnpaid(unpaid) {
    const base = this.base;
    if (Boolean(base.unpaid) === unpaid) return;
    base.unpaid = unpaid;
    this.game.toast(unpaid
      ? 'Upkeep is not being paid: workers have stopped and your walls are starting to crumble. Put supplies in the Vault.'
      : 'Upkeep is paid again: your workers are back at work.', unpaid ? 'warn' : 'info');
  }

  /** Unpaid, the walls and the rest slowly crumble (never below a floor). */
  #decay() {
    const u = this.game.data.base.upkeep ?? {};
    const rate = u.decayPerHour ?? 0.01;
    const floor = u.decayFloor ?? 0.25;
    for (const st of this.game.save.base.structures) {
      if (!st.def) continue;
      st.hp = Math.max(Math.min(st.hp, st.def.hp * floor), st.hp - st.def.hp * rate);
      if (st.hp < st.def.hp) this.game.construction?.damaged.add(st);
    }
  }

  // --- Every frame --------------------------------------------------------------------------------

  #ctx() {
    const g = this.game;
    const stats = this.stats();
    const radius = g.buildRadius();
    return {
      world: g.world, data: g.data, time: g.time, stats, home: this.home(), clear: { x: 0.5, y: 0.5, r: radius },
      working: !this.base.unpaid, taken: this.taken,
      fell: (w, job) => {
        g.world.removeBlock(job.tx, job.ty);
        g.harvestDamage.delete(`${job.tx},${job.ty}`);
        g.fx.emit(job.info.drops.wood ? 'leaf' : 'stone', job.tx + 0.5, job.ty + 0.2, 10, 0.8, 2.2);
        if (this.#near(job.tx + 0.5, job.ty + 0.5)) g.audio.play('fell', { throttle: 200 });
        return rollDrops(job.info);
      },
      chop: (w, job) => {
        const wood = Boolean(job.info.drops.wood);
        g.fx.emit(wood ? 'wood' : 'stone', job.tx + 0.5, job.ty + 0.3, 3, 0.4, 1.5);
        if (this.#near(w.x, w.y)) g.audio.play(wood ? 'chop' : 'mine', { throttle: 120 });
      },
      deliver: (w, carry) => {
        for (const [k, n] of Object.entries(carry)) this.base.vault[k] = (this.base.vault[k] ?? 0) + n;
        const text = Object.entries(carry).map(([k, n]) => `+${n} ${k}`).join(' ');
        const top = Object.keys(carry)[0];
        if (text) g.fx.text(w.x, w.y - 1, text.toUpperCase(), RESOURCE_COLOR[top] ?? '#ffe890', 1.2);
        g.emit('base');
        g.requestSave();
      },
      target: () => g.player,
      strike: (w, foe, dmg) => {
        g.hurtPlayer(dmg, { fromX: w.x, fromY: w.y });
      },
      calmed: () => {},
    };
  }

  #near(x, y) {
    const p = this.game.player;
    return (p.x - x) ** 2 + (p.y - y) ** 2 < 14 * 14;
  }

  update(dt) {
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = CHECK_EVERY;
      this.chargeDue();
    }
    if (!this.list.length) return;
    const ctx = this.#ctx();
    for (const w of this.list) stepWorker(w, ctx, dt);
    if (this.list.some((w) => w.dead)) this.#bury();
  }

  #bury() {
    for (const w of this.list.filter((x) => x.dead)) {
      this.game.fx.emit('smoke', w.x, w.y, 10, 0.5, 1.5);
      this.game.toast(`${w.name} is dead. Hire a new worker at the Workers’ Lodge.`, 'warn');
      const i = this.base.workers.findIndex((r) => r.id === w.id);
      if (i >= 0) this.base.workers.splice(i, 1);
    }
    this.sync();
    this.game.emit('base');
    this.game.requestSave();
  }

  /** Your attacks reach workers too (a careless swing makes one angry). */
  hit(shape, damage) {
    if (!this.list.length) return false;
    let hit = false;
    const ctx = { time: this.game.time, stats: this.stats(), taken: this.taken };
    for (const w of this.list) {
      if (w.dead || !inShape(w, shape)) continue;
      const dmg = Math.max(1, Math.round(damage));
      const was = w.angry;
      hurtWorker(w, ctx, dmg, 'player');
      this.game.fx.number(w.x, w.y - 0.6, dmg, { color: '#ff8a8a' });
      this.game.fx.emit('blood', w.x, w.y - 0.3, 4, 0.3, 2);
      if (!was && !w.dead) this.game.toast(`${w.name} is angry with you! Keep away until they calm down.`, 'warn');
      hit = true;
    }
    return hit;
  }
}
