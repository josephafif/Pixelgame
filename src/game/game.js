// The Game ties the systems together: fixed-timestep simulation, player
// control, interactions, progression, discovery, crafting/research, and
// persistence. UI talks to it through methods and a tiny event bus.

import { CONFIG } from '../config.js';
import { hashInts } from '../core/rng.js';
import { angleTo, dist2 } from '../core/math.js';
import { World } from './world.js';
import { Fx } from './fx.js';
import { computePlayerStats, xpToNext } from './stats.js';
import {
  compileWeapon, dealDamage, hurtPlayer, healPlayer, tryAttack, acquireTarget, weaponDamage, explosion,
} from './combat.js';
import { spawnProjectile, updateProjectiles } from './projectiles.js';
import { spawnArea, updateAreas, projectileSlowAt } from './areas.js';
import { updateEnemies, updateSpawner, spawnBoss } from './enemies.js';
import {
  castAbility, restoreCooldowns, persistCooldowns, tryPhoenixRevive, updateAllies, abilityProgress,
} from './abilities.js';
import {
  onEnemyKilledLoot, updatePickups, openChestLoot, salvageValue, addPickup, componentColor, requestWeaponDrop,
} from './loot.js';
import { validateCraft, buildCraftRequest, craftCost, isCraftingUnlocked } from '../weapons/crafting.js';

const STEP = 1 / 60;
const MAX_STEPS = 5;
const INTERACT_RADIUS = 1.5;
const BOSS_LEASH = 42;

const QUALITY = {
  high: { particles: 650, glow: true, enemyFactor: 1, resolution: 1 },
  low: { particles: 220, glow: false, enemyFactor: 0.75, resolution: 0.8 },
};

export class Game {
  constructor({ data, save, saveManager, weapons, renderer, input, audio, sync }) {
    this.data = data;
    this.save = save;
    this.saveManager = saveManager;
    this.weapons = weapons;
    this.renderer = renderer;
    this.input = input;
    this.audio = audio;
    this.sync = sync;
    this.listeners = new Map();

    this.world = new World(data, save.worldSeed);
    this.fx = new Fx();
    this.time = 0;
    this.frame = 0;
    this.enemies = [];
    this.projectiles = [];
    this.areas = [];
    this.pickups = [];
    this.allies = [];
    this.timers = [];
    this.buffs = [];
    this.boss = null;
    this.shake = 0;
    this.hitstop = 0;
    this.spawnTimer = 1;
    this.pendingDrops = 0;
    this.abilityReadyAt = new Map();
    this.discoveryQueue = [];
    this.discoveryOpen = false;
    this.pauseReasons = new Set();
    this.suppressAttack = false;
    this.interactTarget = null;
    this.target = null;
    this.hudTimer = 0;
    this.lastAutosave = performance.now();
    this.frameMs = 16;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.qualityLevel = 'high';
    this.godMode = false;
    this.running = false;

    this.damageEnemy = (e, amount, opts) => dealDamage(this, e, amount, opts);
    input.onUiCommand = (cmd) => this.emit('ui', cmd);
    this.weapon = null;
    this.player = {
      x: save.player.x, y: save.player.y, r: 0.32, vx: 0, vy: 0, kx: 0, ky: 0, facing: 0,
      hp: 1, dead: false, invuln: 1, attackCd: 0, attackAnim: null, attackCount: 0, sprinting: false,
      moving: false, walkT: 0, hurtFlash: 0, respawnT: 0, statuses: {},
    };
    this.pstats = computePlayerStats(data, save, null, []);
    this.#applySettings();
    this.#equipFromSave();
    this.player.hp = save.player.hp ?? this.pstats.maxHp;
    if (!this.world.isFree(this.player.x, this.player.y, this.player.r)) {
      Object.assign(this.player, this.world.findFreeSpot(this.player.x, this.player.y));
    }
    restoreCooldowns(this);
  }

  // --- Events ----------------------------------------------------------------

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name).delete(fn);
  }

  emit(name, payload) {
    for (const fn of this.listeners.get(name) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[game] listener for ${name} failed`, err);
      }
    }
  }

  toast(text, kind = 'info') {
    this.emit('toast', { text, kind });
  }

  // --- Lifecycle ---------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    const loop = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const elapsed = Math.min(250, now - this.last);
      this.last = now;
      this.#trackPerformance(elapsed);
      if (this.hitstop > 0 && !this.paused) {
        // Hit-stop: freeze the simulation for a few frames on heavy hits.
        this.hitstop -= elapsed / 1000;
      } else if (!this.paused) {
        this.acc += elapsed / 1000;
        let steps = 0;
        while (this.acc >= STEP && steps < MAX_STEPS) {
          this.update(STEP);
          this.acc -= STEP;
          steps += 1;
        }
        if (steps === MAX_STEPS) this.acc = 0;
      }
      this.renderer.draw(this);
      this.#maybeAutosave(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  get paused() {
    return this.pauseReasons.size > 0;
  }

  pause(reason) {
    this.pauseReasons.add(reason);
    this.input.reset();
    this.emit('pause', { paused: true, reasons: [...this.pauseReasons] });
  }

  resume(reason) {
    this.pauseReasons.delete(reason);
    // Never "catch up" on time that passed while paused/backgrounded.
    this.last = performance.now();
    this.acc = 0;
    this.emit('pause', { paused: this.paused, reasons: [...this.pauseReasons] });
  }

  #trackPerformance(elapsed) {
    this.frameMs = this.frameMs * 0.95 + elapsed * 0.05;
    if (this.save.settings.quality !== 'auto' || this.paused) return;
    if (this.frameMs > 24) {
      this.slowFrames += 1;
      this.fastFrames = 0;
      if (this.slowFrames > 120 && this.qualityLevel === 'high') this.setQuality('low');
    } else if (this.frameMs < 14) {
      this.fastFrames += 1;
      this.slowFrames = 0;
      if (this.fastFrames > 900 && this.qualityLevel === 'low') this.setQuality('high');
    }
  }

  setQuality(level) {
    this.qualityLevel = level;
    this.quality = QUALITY[level];
    this.fx.setBudget(this.quality.particles);
    this.renderer.setResolution(this.quality.resolution);
    this.slowFrames = this.fastFrames = 0;
  }

  #applySettings() {
    const s = this.save.settings;
    this.audio.configure({ volume: s.volume, sfx: s.sfx });
    this.fx.damageNumbers = s.damageNumbers;
    const level = s.quality === 'low' ? 'low' : s.quality === 'high' ? 'high' : this.qualityLevel;
    this.setQuality(level);
  }

  updateSettings(patch) {
    Object.assign(this.save.settings, patch);
    this.#applySettings();
    this.saveNow();
  }

  // --- Scheduling / helpers used by systems -----------------------------------

  schedule(delay, fn) {
    this.timers.push({ at: this.time + delay, fn });
  }

  #runTimers() {
    if (!this.timers.length) return;
    const due = [];
    this.timers = this.timers.filter((t) => {
      if (t.at <= this.time) {
        due.push(t);
        return false;
      }
      return true;
    });
    for (const t of due) {
      try {
        t.fn();
      } catch (err) {
        console.error('[game] timer failed', err);
      }
    }
  }

  spawnArea(kind, o) {
    return spawnArea(this, kind, o);
  }

  spawnProjectile(o) {
    return spawnProjectile(this, o);
  }

  explode(x, y, radius, damage, element) {
    explosion(this, x, y, radius, damage, element === 'physical' ? 'fire' : element, 0);
  }

  weaponDamage() {
    return this.weapon ? weaponDamage(this) : 10;
  }

  enemyProjectileSlow(p) {
    return projectileSlowAt(this, p);
  }

  hurtPlayer(amount, opts) {
    return hurtPlayer(this, amount, opts);
  }

  heal(amount) {
    healPlayer(this, amount);
  }

  addHitstop(seconds) {
    if (this.time - (this.lastHitstopAt ?? -1) < 0.12) return;
    this.lastHitstopAt = this.time;
    this.hitstop = Math.max(this.hitstop ?? 0, seconds);
  }

  vibrate(ms) {
    if (this.save.settings.vibration && this.input.mode === 'touch') navigator.vibrate?.(ms);
  }

  addBuff(stat, value, duration) {
    const existing = this.buffs.find((b) => b.stat === stat);
    if (existing) existing.until = this.time + duration;
    else this.buffs.push({ stat, value, until: this.time + duration });
    this.recomputeStats();
  }

  applyPlayerStatus(id) {
    const s = this.player.statuses;
    if (id === 'burn') s.burn = { until: this.time + 2, dps: 2 + this.save.player.level * 0.6 };
    if (id === 'poison') s.poison = { until: this.time + 3, dps: 1.5 + this.save.player.level * 0.4 };
    if (id === 'chill') s.chill = { until: this.time + 1.5 };
  }

  recomputeStats() {
    const before = this.pstats?.maxHp ?? 0;
    this.pstats = computePlayerStats(this.data, this.save, this.weapon?.dna ?? null, this.buffs);
    if (before && this.pstats.maxHp !== before) {
      this.player.hp = Math.min(this.pstats.maxHp, this.player.hp * (this.pstats.maxHp / before));
    }
  }

  // --- Inventory ----------------------------------------------------------------

  allWeapons() {
    return [...this.save.inventory.bag, ...this.save.inventory.storage];
  }

  findWeapon(id) {
    return this.allWeapons().find((w) => w.id === id) ?? null;
  }

  #equipFromSave() {
    const id = this.save.inventory.equipped;
    const dna = id ? this.save.inventory.bag.find((w) => w.id === id) : null;
    this.weapon = dna ? compileWeapon(dna) : null;
    this.recomputeStats();
  }

  equip(id) {
    const inv = this.save.inventory;
    let dna = inv.bag.find((w) => w.id === id);
    if (!dna) {
      const idx = inv.storage.findIndex((w) => w.id === id);
      if (idx < 0) return false;
      if (inv.bag.length >= inv.bagSize) {
        this.toast('Your bag is full', 'warn');
        return false;
      }
      [dna] = inv.storage.splice(idx, 1);
      inv.bag.push(dna);
    }
    inv.equipped = dna.id;
    this.weapon = compileWeapon(dna);
    this.player.attackCd = 0.2;
    this.recomputeStats();
    this.emit('inventory');
    this.emit('equip', dna);
    this.saveNow();
    return true;
  }

  moveWeapon(id, to) {
    const inv = this.save.inventory;
    const from = to === 'storage' ? inv.bag : inv.storage;
    const dest = to === 'storage' ? inv.storage : inv.bag;
    const cap = to === 'storage' ? inv.storageSize : inv.bagSize;
    const idx = from.findIndex((w) => w.id === id);
    if (idx < 0) return false;
    if (dest.length >= cap) {
      this.toast(to === 'storage' ? 'Storage is full' : 'Your bag is full', 'warn');
      return false;
    }
    if (inv.equipped === id) {
      this.toast('Unequip by equipping another weapon first', 'warn');
      return false;
    }
    dest.push(...from.splice(idx, 1));
    this.emit('inventory');
    this.saveNow();
    return true;
  }

  salvage(id) {
    const inv = this.save.inventory;
    if (inv.equipped === id) {
      this.toast("You can't salvage the weapon you are holding", 'warn');
      return null;
    }
    for (const list of [inv.bag, inv.storage]) {
      const idx = list.findIndex((w) => w.id === id);
      if (idx >= 0) {
        const [dna] = list.splice(idx, 1);
        const value = salvageValue(dna);
        this.save.resources.scrap += value.scrap;
        this.save.resources.essence += value.essence;
        this.emit('inventory');
        this.saveNow();
        return value;
      }
    }
    return null;
  }

  // --- Discovery ------------------------------------------------------------------

  #registerDiscovery(dna) {
    const codex = this.save.codex;
    const isNew = !codex.weapons[dna.id];
    codex.weapons[dna.id] = {
      name: dna.name.text, rarity: dna.rarity, archetype: dna.archetype, element: dna.element,
      seed: dna.seed, gen: dna.gen, data: dna.data, ctx: dna.ctx, at: Date.now(),
    };
    const add = (list, id) => {
      if (!list.includes(id)) list.push(id);
    };
    for (const m of dna.modifiers) add(codex.modifiers, m.id);
    for (const e of dna.effects) add(codex.effects, e.id);
    if (dna.ability) add(codex.abilities, dna.ability.id);
    return isNew;
  }

  discoverWeapon(dna) {
    this.#registerDiscovery(dna);
    this.discoveryQueue.push(dna);
    if (!this.discoveryOpen) this.#openNextDiscovery();
  }

  #openNextDiscovery() {
    const dna = this.discoveryQueue.shift();
    if (!dna) return;
    this.discoveryOpen = true;
    this.pause('discovery');
    this.audio.play('discover');
    this.vibrate(40);
    const inv = this.save.inventory;
    this.emit('discovery', {
      dna,
      canKeep: inv.bag.length < inv.bagSize,
      canStore: inv.storage.length < inv.storageSize,
      salvage: salvageValue(dna),
      equipped: this.weapon?.dna ?? null,
    });
  }

  /** choice: 'equip' | 'keep' | 'storage' | 'salvage' */
  resolveDiscovery(dna, choice) {
    const inv = this.save.inventory;
    const bagFull = inv.bag.length >= inv.bagSize;
    const storageFull = inv.storage.length >= inv.storageSize;
    if ((choice === 'keep' || choice === 'equip') && bagFull) choice = storageFull ? 'salvage' : 'storage';
    if (choice === 'storage' && storageFull) choice = 'salvage';
    if (choice === 'salvage') {
      const v = salvageValue(dna);
      this.save.resources.scrap += v.scrap;
      this.save.resources.essence += v.essence;
      this.toast(`Salvaged for ${v.scrap} scrap and ${v.essence} essence`);
    } else if (choice === 'storage') {
      inv.storage.push(dna);
      this.toast(`${dna.name.text} sent to storage`);
    } else {
      inv.bag.push(dna);
      if (choice === 'equip') {
        inv.equipped = dna.id;
        this.weapon = compileWeapon(dna);
        this.recomputeStats();
        this.emit('equip', dna);
      }
    }
    this.emit('inventory');
    this.discoveryOpen = false;
    this.resume('discovery');
    this.saveNow();
    if (this.discoveryQueue.length) setTimeout(() => this.#openNextDiscovery(), 150);
  }

  // --- Components & research --------------------------------------------------

  discoverComponent(id) {
    const def = this.data.byId.components.get(id);
    if (!def) return;
    const entry = this.save.components[id] ?? { found: 0, researched: false };
    this.save.components[id] = entry;
    entry.found += 1;
    if (entry.found > 1 && entry.researched) {
      this.save.resources.essence += 10;
      this.toast(`${def.name} (duplicate) → +10 essence`);
      return;
    }
    if (def.research === 0 && !entry.researched) {
      entry.researched = true;
      this.toast(`Boss core obtained: ${def.name}! New weapon possibilities unlocked.`, 'legendary');
    } else if (entry.found === 1) {
      this.toast(`New component: ${def.name} — research it to expand the forge`, 'component');
    }
    this.emit('components');
    this.saveNow();
  }

  research(id) {
    const def = this.data.byId.components.get(id);
    const entry = this.save.components[id];
    if (!def || !entry || entry.researched) return false;
    if (this.save.resources.essence < def.research) {
      this.toast(`Needs ${def.research} essence`, 'warn');
      return false;
    }
    this.save.resources.essence -= def.research;
    entry.researched = true;
    this.toast(`Researched ${def.name}!`, 'component');
    this.audio.play('levelup');
    this.emit('components');
    this.saveNow();
    return true;
  }

  // --- Crafting ------------------------------------------------------------------

  async craft(choice) {
    const errors = validateCraft(this.data, this.save, choice);
    if (errors.length) throw new Error(errors[0]);
    const cost = craftCost(this.data, choice);
    const request = buildCraftRequest(this.data, this.save, choice, Math.floor(this.pstats.luck));
    this.save.resources.scrap -= cost.scrap;
    this.save.resources.essence -= cost.essence;
    this.save.counters.craft += 1;
    await this.saveNow();
    const dna = await this.weapons.generate(request);
    this.discoverWeapon(dna);
    return dna;
  }

  // --- Progression ------------------------------------------------------------------

  addXp(amount) {
    const pl = this.save.player;
    pl.xp += amount;
    let leveled = false;
    while (pl.xp >= xpToNext(this.data, pl.level)) {
      pl.xp -= xpToNext(this.data, pl.level);
      pl.level += 1;
      leveled = true;
      if (pl.level === this.data.crafting.unlockLevel) {
        this.toast('The Forge is unlocked! Craft your own weapons from the menu.', 'legendary');
      }
    }
    if (leveled) {
      this.recomputeStats();
      this.player.hp = this.pstats.maxHp;
      this.audio.play('levelup');
      this.fx.emit('holy', this.player.x, this.player.y, 20, 0.8, 3);
      this.emit('levelup', { level: pl.level });
      this.saveNow();
    }
  }

  onEnemyKilled(e) {
    this.save.player.kills += 1;
    this.addXp(e.xp);
    this.fx.emit('smoke', e.x, e.y, e.boss ? 30 : 6, e.r * 2, 2);
    this.fx.emit('hit', e.x, e.y, 4, e.r, 3);
    this.audio.play('kill');
    onEnemyKilledLoot(this, e);
    if (e.boss) {
      const id = e.bossDef.id;
      this.save.bosses.defeated[id] = (this.save.bosses.defeated[id] ?? 0) + 1;
      this.boss = null;
      this.shake = 0.6;
      this.emit('boss', { active: false, victory: true, name: e.bossDef.name });
      this.toast(`${e.bossDef.name} defeated!`, 'legendary');
      this.saveNow();
    }
  }

  collect(it) {
    const r = this.save.resources;
    switch (it.kind) {
      case 'essence':
        r.essence += it.value;
        this.audio.play('pickup', { throttle: 60 });
        break;
      case 'scrap':
        r.scrap += it.value;
        this.audio.play('pickup', { throttle: 60 });
        break;
      case 'heart':
        healPlayer(this, this.pstats.maxHp * 0.2);
        this.audio.play('pickup');
        break;
      case 'component':
        this.discoverComponent(it.componentId);
        this.audio.play('discover');
        break;
      default:
        break;
    }
  }

  onPlayerDeath() {
    const p = this.player;
    if (p.dead) return;
    if (tryPhoenixRevive(this)) return;
    p.dead = true;
    p.hp = 0;
    p.respawnT = 2.5;
    this.save.player.deaths += 1;
    if (this.boss) {
      this.enemies = this.enemies.filter((e) => e !== this.boss);
      this.boss = null;
      this.emit('boss', { active: false, victory: false });
    }
    this.emit('death', {});
    this.saveNow();
  }

  #respawn() {
    const p = this.player;
    const pl = this.save.player;
    const spot = this.world.findFreeSpot(pl.spawnX, pl.spawnY, p.r);
    p.x = spot.x;
    p.y = spot.y;
    p.dead = false;
    p.hp = this.pstats.maxHp;
    p.invuln = 2;
    p.statuses = {};
    this.enemies = this.enemies.filter((e) => e.boss);
    this.projectiles.length = 0;
    this.areas = this.areas.filter((a) => a.owner !== 'enemy');
    this.emit('respawn', {});
  }

  // --- Interaction ----------------------------------------------------------------

  #findInteractable() {
    const p = this.player;
    let best = null;
    let bestD = INTERACT_RADIUS * INTERACT_RADIUS;
    for (const o of this.world.objectsNear(p.x, p.y, 1)) {
      if (o.type === 'chest' && this.save.world.chests.includes(o.key)) continue;
      if (o.type === 'shrine' && this.save.world.shrines.includes(o.key)) continue;
      if (o.type === 'altar' && this.boss) continue;
      const d = dist2(p.x, p.y, o.x, o.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  interactLabel(o) {
    if (!o) return null;
    switch (o.type) {
      case 'chest': return 'Open chest';
      case 'shrine': return 'Pray at shrine';
      case 'altar': return `Summon ${this.data.byId.bosses.get(o.bossId)?.name ?? 'boss'}`;
      case 'camp': return 'Rest at camp';
      default: return 'Use';
    }
  }

  interact() {
    const o = this.interactTarget;
    if (!o || this.player.dead) return false;
    const pl = this.save.player;
    switch (o.type) {
      case 'chest':
        this.save.world.chests.push(o.key);
        openChestLoot(this, o);
        this.audio.play('chest');
        this.fx.emit('sparkle', o.x, o.y, 16, 0.6, 3);
        break;
      case 'shrine':
        this.save.world.shrines.push(o.key);
        pl.bonusLuck = (pl.bonusLuck ?? 0) + 1;
        pl.spawnX = o.x;
        pl.spawnY = o.y + 1;
        this.recomputeStats();
        this.player.hp = this.pstats.maxHp;
        this.fx.emit('holy', o.x, o.y, 24, 0.6, 3);
        this.audio.play('levelup');
        this.toast('Shrine blessing: +1 Luck, fully healed. Respawn point set.', 'component');
        break;
      case 'altar': {
        const def = this.data.byId.bosses.get(o.bossId);
        this.boss = spawnBoss(this, o.bossId, o.x, o.y - 3.5);
        this.shake = 0.6;
        this.audio.play('boss');
        this.emit('boss', { active: true, name: def.name });
        this.toast(`${def.name} awakens!`, 'boss');
        break;
      }
      case 'camp':
        this.player.hp = this.pstats.maxHp;
        pl.spawnX = 0.5;
        pl.spawnY = 1.5;
        this.emit('ui', 'camp');
        break;
      default:
        break;
    }
    this.saveNow();
    return true;
  }

  // --- Simulation -------------------------------------------------------------------

  /** Where the weapon points: the locked target if any, else where we walk. */
  #aim(sample) {
    const p = this.player;
    const t = this.target;
    if (t && !t.dead) return Math.atan2(t.y - p.y, t.x - p.x);
    if (sample.moveX || sample.moveY) return Math.atan2(sample.moveY, sample.moveX);
    return p.facing;
  }

  #updatePlayer(dt, sample) {
    const p = this.player;
    p.invuln = Math.max(0, p.invuln - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt);
    p.attackCd = Math.max(0, p.attackCd - dt);
    if (p.attackAnim) {
      p.attackAnim.t += dt;
      if (p.attackAnim.t >= p.attackAnim.dur) p.attackAnim = null;
    }
    if (p.dead) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) this.#respawn();
      return;
    }
    // Player statuses from enemy attacks.
    const st = p.statuses;
    let dot = 0;
    if (st.burn?.until > this.time) dot += st.burn.dps;
    if (st.poison?.until > this.time) dot += st.poison.dps;
    if (dot && !this.godMode) {
      p.dotAcc = (p.dotAcc ?? 0) + dot * dt;
      if (p.dotAcc >= 1) {
        const amount = Math.floor(p.dotAcc);
        p.dotAcc -= amount;
        p.hp -= amount;
        if (p.hp <= 0) this.onPlayerDeath();
      }
    }
    const slow = st.chill?.until > this.time ? 0.65 : 1;

    // Movement (sprint has no stamina cost and can be held indefinitely).
    const moving = Math.abs(sample.moveX) + Math.abs(sample.moveY) > 0.01;
    p.sprinting = sample.sprint && moving;
    const speed = this.pstats.moveSpeed * (p.sprinting ? this.data.player.sprintMultiplier : 1) * slow;
    const vx = sample.moveX * speed + p.kx;
    const vy = sample.moveY * speed + p.ky;
    const damp = Math.exp(-10 * dt);
    p.kx *= damp;
    p.ky *= damp;
    const nx = p.x + vx * dt;
    const ny = p.y + vy * dt;
    if (this.world.isFree(nx, p.y, p.r)) p.x = nx;
    if (this.world.isFree(p.x, ny, p.r)) p.y = ny;
    p.moving = moving;
    if (moving) p.walkT += dt * (p.sprinting ? 14 : 9);
    if (p.sprinting && Math.random() < 0.3) this.fx.emit('dust', p.x, p.y + 0.3, 1, 0.2, 0.5);

    // Aiming is automatic on every device: the weapon locks onto an enemy.
    this.target = acquireTarget(this, this.target);
    const aim = this.#aim(sample);
    if (!p.attackAnim) p.facing = aim;

    if (!sample.attack) this.suppressAttack = false;
    if (sample.attack && !this.suppressAttack) tryAttack(this, aim);

    // Weapon ambience particles from the DNA's visual parameters.
    const part = this.weapon?.particles;
    if (part && Math.random() < part.rate * 0.25 * (this.quality.glow ? 1 : 0.4)) {
      this.fx.emit(part.kind, p.x + Math.cos(p.facing) * 0.6, p.y - 0.4 + Math.sin(p.facing) * 0.6, 1, 0.3, 0.6);
    }
  }

  update(dt) {
    this.time += dt;
    this.frame += 1;
    this.save.player.playTime += dt;
    this.#runTimers();

    const sample = this.input.sample();
    for (const c of sample.commands) {
      if (c === 'interact' || c === 'interact-or-attack') {
        if (this.interact()) this.suppressAttack = true;
        else if (c === 'interact-or-attack') tryAttack(this, this.#aim(sample));
      } else if (c === 'ability') {
        castAbility(this, this.#aim(sample));
      } else {
        this.emit('ui', c);
      }
    }
    this.#updatePlayer(dt, sample);

    if (this.buffs.length) {
      const before = this.buffs.length;
      this.buffs = this.buffs.filter((b) => b.until > this.time);
      if (this.buffs.length !== before) this.recomputeStats();
    }

    updateEnemies(this, dt);
    updateSpawner(this, dt);
    updateProjectiles(this, dt);
    updateAreas(this, dt);
    updateAllies(this, dt);
    updatePickups(this, dt);
    this.fx.update(dt);
    this.shake = Math.max(0, this.shake - dt);

    if (this.boss && !this.boss.dead) {
      const b = this.boss;
      if (dist2(b.x, b.y, this.player.x, this.player.y) > BOSS_LEASH * BOSS_LEASH) {
        this.enemies = this.enemies.filter((e) => e !== b);
        this.boss = null;
        this.emit('boss', { active: false, victory: false });
        this.toast('The boss returned to its altar.');
      }
    }

    const target = this.#findInteractable();
    if (target !== this.interactTarget) {
      this.interactTarget = target;
      this.emit('interact', { label: this.interactLabel(target) });
    }

    if (this.frame % 120 === 0) this.world.prune(this.frame);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.emit('hud', this.hudState());
    }
  }

  hudState() {
    const pl = this.save.player;
    return {
      hp: Math.max(0, Math.ceil(this.player.hp)),
      maxHp: this.pstats.maxHp,
      level: pl.level,
      xp: pl.xp,
      xpNext: xpToNext(this.data, pl.level),
      essence: this.save.resources.essence,
      scrap: this.save.resources.scrap,
      ability: abilityProgress(this),
      abilityName: this.weapon?.dna.ability?.name ?? null,
      sprinting: this.player.sprinting,
      boss: this.boss ? { name: this.boss.bossDef.name, hp: this.boss.hp, maxHp: this.boss.maxHp, phase: this.boss.phase } : null,
      dead: this.player.dead,
      fps: Math.round(1000 / this.frameMs),
      craftingUnlocked: isCraftingUnlocked(this.data, this.save),
      compass: (this.lastCompass = this.#compass()),
    };
  }

  #compass() {
    const p = this.player;
    let best = null;
    let bestD = Infinity;
    for (const lm of this.world.landmarks) {
      if (this.save.bosses.defeated[lm.bossId]) continue;
      const d = dist2(p.x, p.y, lm.x, lm.y);
      if (d < bestD) {
        bestD = d;
        best = lm;
      }
    }
    if (!best) return null;
    const boss = this.data.byId.bosses.get(best.bossId);
    return { angle: angleTo(p.x, p.y, best.x, best.y), dist: Math.sqrt(bestD), name: boss.name, color: boss.color };
  }

  // --- Persistence ------------------------------------------------------------------

  syncToSave() {
    const p = this.player;
    const pl = this.save.player;
    pl.x = Math.round(p.x * 100) / 100;
    pl.y = Math.round(p.y * 100) / 100;
    pl.hp = p.dead ? this.pstats.maxHp : Math.max(1, Math.round(p.hp));
    persistCooldowns(this);
  }

  async saveNow() {
    this.syncToSave();
    this.lastAutosave = performance.now();
    try {
      const ok = await this.saveManager.write(this.save);
      if (ok) this.sync?.notifySaved();
      this.emit('saved', { ok });
      return ok;
    } catch (err) {
      console.error('[save] failed', err);
      this.emit('saved', { ok: false, error: err.message });
      return false;
    }
  }

  #maybeAutosave(now) {
    if (now - this.lastAutosave > CONFIG.autosaveIntervalMs && !this.paused) this.saveNow();
  }

  /** Gives a brand-new player their first weapon. */
  async ensureStarterWeapon() {
    if (this.allWeapons().length) return null;
    const dna = await this.weapons.generate({
      seed: hashInts(this.save.worldSeed, 0x57a7),
      level: 1,
      source: 'starter',
      maxRarity: 'common',
      craft: { archetype: 'sword', material: 'iron' },
    });
    this.discoverWeapon(dna);
    return dna;
  }

  // Debug/testing helpers (exposed only with ?debug=1).
  debugDrop(opts = {}) {
    return requestWeaponDrop(this, this.player.x + 1.2, this.player.y, { level: this.save.player.level, ...opts });
  }

  debugComponent(id) {
    addPickup(this, 'component', this.player.x + 0.5, this.player.y, { componentId: id, color: componentColor(this, id) });
  }
}
