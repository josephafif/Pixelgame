// Horses in single player (rules in horses.js): the wild herds around you,
// the horses you own (in your camp, or left out in the world) and the one you
// ride. Saved in save.horses: { owned: [{ id, breed, speed, gallop, hp, name,
// x, y, stabled, leftAt }], riding: id | null, taken: { "herd:x,y:i": time } }.

import {
  herdsNear, horseStats, herdHorseSeed, grazeSpot, BREED_BY_ID, MAX_HORSES, STRAY_RANGE, STRAY_SECONDS, REGROW_MS,
  HORSE_RADIUS, describeHorse,
} from './horses.js';
import { inBuildArea } from './construction.js';
import { dist2 } from '../core/math.js';

const ACTIVATE = 60;
const FORGET = 90;
const REACH = 1.7;

export function emptyHorses() {
  return { owned: [], riding: null, taken: {}, nextId: 1 };
}

export class Stable {
  constructor(game) {
    this.game = game;
    game.save.horses ??= emptyHorses();
    this.wild = new Map(); // "herd:x,y:i" → horse in the world
    this.checkT = 0;
    this.t = 0;
    // Saved on horseback: the horse's extra health comes back with you.
    const rec = this.riding;
    if (rec?.hp) game.buffs.push({ stat: 'maxHp', value: rec.hp, until: Infinity, source: 'horse' });
  }

  get save() {
    return this.game.save.horses;
  }

  /** The horse you are riding (its saved record), or null. */
  get riding() {
    const id = this.save.riding;
    return id ? this.save.owned.find((h) => h.id === id) ?? null : null;
  }

  /** Every horse to draw: wild ones nearby and your own (not the one you ride). */
  get list() {
    const out = [...this.wild.values()];
    for (const h of this.save.owned) if (h.id !== this.save.riding) out.push(this.#ownedView(h));
    return out;
  }

  #ownedView(h) {
    return { key: `own:${h.id}`, own: true, record: h, breed: h.breed, x: h.x, y: h.y, facing: 0, moving: false, walkT: 0, saddle: true };
  }

  update(dt) {
    const g = this.game;
    const p = g.player;
    this.t += dt;
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.5;
      const now = Date.now();
      const near = new Set();
      for (const herd of herdsNear(g.world, p.x, p.y, ACTIVATE)) {
        for (let i = 0; i < herd.size; i++) {
          const key = `${herd.key}:${i}`;
          const taken = this.save.taken[key];
          if (taken && now - taken < REGROW_MS) continue;
          if (taken) delete this.save.taken[key];
          near.add(key);
          if (!this.wild.has(key)) {
            const stats = horseStats(herd.breeds[i], herdHorseSeed(g.world, herd, i));
            const spot = grazeSpot(herd, i, 0);
            this.wild.set(key, {
              key, herd, idx: i, wild: true, ...stats, x: spot.x, y: spot.y, facing: 0, moving: false, walkT: 0,
              tx: spot.x, ty: spot.y, wanderT: Math.random() * 3,
            });
          }
        }
      }
      for (const [key, h] of this.wild) if (!near.has(key) && dist2(h.x, h.y, p.x, p.y) > FORGET * FORGET) this.wild.delete(key);
      this.#strays(now);
    }
    for (const h of this.wild.values()) this.#graze(h, dt);
  }

  /** Wild horses graze around their herd's spot, now and then trotting to a new patch. */
  #graze(h, dt) {
    const w = this.game.world;
    h.wanderT -= dt;
    if (h.wanderT <= 0) {
      h.wanderT = 3 + Math.random() * 5;
      const spot = grazeSpot(h.herd, h.idx, this.t + Math.random() * 40);
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
    if (w.isFree(nx, h.y, HORSE_RADIUS, 'horse')) h.x = nx;
    if (w.isFree(h.x, ny, HORSE_RADIUS, 'horse')) h.y = ny;
    if (Math.abs(dx) > 0.05) h.facing = dx < 0 ? Math.PI : 0;
    h.walkT += dt * 5;
  }

  /** Horses left out in the world wander off when you go far away for long. */
  #strays(now) {
    const p = this.game.player;
    for (const h of [...this.save.owned]) {
      if (h.id === this.save.riding || h.stabled) continue;
      const far = dist2(h.x, h.y, p.x, p.y) > STRAY_RANGE * STRAY_RANGE;
      if (!far) {
        h.leftAt = now;
        continue;
      }
      h.leftAt ??= now;
      if (now - h.leftAt > STRAY_SECONDS * 1000) {
        this.save.owned = this.save.owned.filter((x) => x !== h);
        this.game.toast(`${h.name} grew tired of waiting and ran off. Leave horses in your camp and they stay.`, 'warn');
        this.game.requestSave();
      }
    }
  }

  /** The horse within reach of (x, y) (wild or yours), or null. */
  near(x, y) {
    let best = null;
    let bestD = REACH * REACH;
    for (const h of this.list) {
      const d = dist2(h.x, h.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  label(h) {
    const breed = BREED_BY_ID.get(h.breed);
    return h.own ? `Ride ${h.record.name}` : `Ride the wild ${breed?.name.toLowerCase() ?? 'horse'} (${describeHorse(h).split(' · ').slice(1).join(' · ')})`;
  }

  /** Climb on: a wild horse becomes yours. */
  mount(h) {
    const g = this.game;
    if (this.save.riding) return false;
    if (g.sailing) return false;
    let rec;
    if (h.own) {
      rec = h.record;
    } else {
      if (this.save.owned.length >= MAX_HORSES) {
        g.toast(`You already have ${MAX_HORSES} horses. Let one go first (the Horses list in the camp panel).`, 'warn');
        return false;
      }
      rec = { id: this.save.nextId++, breed: h.breed, speed: h.speed, gallop: h.gallop, hp: h.hp, name: h.name, x: h.x, y: h.y, stabled: false };
      this.save.owned.push(rec);
      this.save.taken[h.key] = Date.now();
      this.wild.delete(h.key);
      g.toast(`You tame ${rec.name}, a ${BREED_BY_ID.get(rec.breed)?.name ?? 'horse'}! Ride it home to your camp and it stays there.`, 'legendary');
      g.audio.play('levelup');
    }
    this.save.riding = rec.id;
    const p = g.player;
    g.buffs = g.buffs.filter((b) => b.source !== 'horse');
    if (rec.hp) g.buffs.push({ stat: 'maxHp', value: rec.hp, until: Infinity, source: 'horse' });
    g.recomputeStats();
    g.fx.emit('dust', p.x, p.y + 0.3, 8, 0.6, 1.2);
    g.audio.play('ui');
    g.emit('riding', { on: true });
    g.requestSave();
    return true;
  }

  /** Climb off where you are; in your camp the horse stays for good. */
  dismount({ quiet = false } = {}) {
    const g = this.game;
    const rec = this.riding;
    if (!rec) return false;
    const p = g.player;
    rec.x = p.x;
    rec.y = p.y;
    rec.stabled = inBuildArea(g.data, g.save, Math.floor(p.x), Math.floor(p.y));
    rec.leftAt = Date.now();
    this.save.riding = null;
    g.buffs = g.buffs.filter((b) => b.source !== 'horse');
    g.recomputeStats();
    // Step down beside it (on foot you can't stand on a tree or a rock).
    const spot = g.world.findFreeSpot(p.x + 0.7, p.y + 0.2, p.r, 'player', { x: p.x, y: p.y });
    p.x = spot.x;
    p.y = spot.y;
    if (!quiet) {
      g.toast(rec.stabled
        ? `${rec.name} stays in your camp.`
        : `${rec.name} waits here. Out in the wild a horse wanders off if you leave it for long; your camp is safe.`, rec.stabled ? 'component' : 'info');
    }
    g.emit('riding', { on: false });
    g.requestSave();
    return true;
  }

  /** Lets a horse go (back to the wild). */
  release(id) {
    const h = this.save.owned.find((x) => x.id === id);
    if (!h || h.id === this.save.riding) return false;
    this.save.owned = this.save.owned.filter((x) => x !== h);
    this.game.requestSave();
    return true;
  }
}
