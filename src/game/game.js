// The Game ties the systems together: fixed-timestep simulation, player
// control, interactions, progression, discovery, crafting/research, and
// persistence. UI talks to it through methods and a tiny event bus.

import { CONFIG } from '../config.js';
import { hashInts } from '../core/rng.js';
import { angleTo, dist2 } from '../core/math.js';
import { World, CHUNK } from './world.js';
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
import {
  syncInventoryCaps, upgradeBuilding, upgradeBlockers, buildingLevel, buildingDef, collectWell, wellPending, researchCost,
} from './base.js';
import { applyStatus } from './status.js';
import {
  currentPickaxe, forgePickaxe, findHarvestTarget, rollDrops, regrow, REGROW_INTERVAL,
} from './gathering.js';
import { Construction, buildRadius, structureDef, structureDefs, structureLock } from './construction.js';
import { Markets } from './markets.js';
import { currentBoat, buildBoat, boatMode, findLaunch, findLanding } from './sailing.js';
import { POI, isPoi, poiFound, interactPoi } from './discoveries.js';

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
    this.world.harvested = save.world.harvested;
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
    this.construction = new Construction(this);
    this.markets = new Markets(this);
    // Build mode (camp construction) and gathering state.
    this.build = {
      active: false, selected: structureDefs(data)[0]?.id ?? null, tool: 'place',
      ghost: null, reason: null, hover: null, hoverAt: -99, painting: false, lastTile: null,
    };
    this.harvestDamage = new Map();
    this.regrowT = 1;
    // Chunks you have seen (for the map).
    this.explored = new Set(save.world.explored);
    this.exploreT = 0;
    this.#bindBuildInput();
    input.onUiCommand = (cmd) => this.emit('ui', cmd);
    this.weapon = null;
    this.player = {
      x: save.player.x, y: save.player.y, r: 0.32, vx: 0, vy: 0, kx: 0, ky: 0, facing: 0,
      hp: 1, dead: false, invuln: 1, attackCd: 0, attackAnim: null, attackCount: 0, sprinting: false,
      moving: false, walkT: 0, hurtFlash: 0, respawnT: 0, statuses: {}, toolAnim: null, toolCd: 0,
    };
    syncInventoryCaps(data, save);
    this.pstats = computePlayerStats(data, save, null, []);
    this.#applySettings();
    this.#equipFromSave();
    this.player.hp = save.player.hp ?? this.pstats.maxHp;
    // Saved at sea: keep sailing if the boat still floats there.
    if (save.player.sailing && !(currentBoat(data, save) && this.world.isFree(this.player.x, this.player.y, this.player.r, this.moveMode))) {
      save.player.sailing = false;
    }
    if (!this.world.isFree(this.player.x, this.player.y, this.player.r, this.moveMode)) {
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
    // Keys pressed inside panels (Q, E, …) must not fire once play resumes.
    if (!this.paused) this.input.commands = [];
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

  // --- Loadout: main weapon (1), secondary weapon (2), pickaxe (3) --------------

  /** Weapon ids in the loadout (never moved to storage or salvaged). */
  inLoadout(id) {
    const inv = this.save.inventory;
    return Boolean(id) && (inv.equipped === id || inv.secondary === id);
  }

  get activeSlot() {
    return this.save.inventory.activeSlot ?? 'main';
  }

  /** True while the pickaxe is in hand. */
  get toolActive() {
    return this.activeSlot === 'tool' && Boolean(currentPickaxe(this.data, this.save));
  }

  /** True when you have put everything away (press your slot again). */
  get handsEmpty() {
    return this.activeSlot === 'none';
  }

  /** True while you are out on the water in your boat. */
  get sailing() {
    return Boolean(this.save.player.sailing);
  }

  /** The boat you are sailing (or would launch). */
  get boat() {
    return currentBoat(this.data, this.save);
  }

  /** Collision mode for the player right now (on foot or afloat). */
  get moveMode() {
    return this.sailing ? boatMode(this.boat) : 'player';
  }

  #slotDna(slot) {
    const inv = this.save.inventory;
    const id = slot === 'secondary' ? inv.secondary : inv.equipped;
    return id ? inv.bag.find((w) => w.id === id) ?? null : null;
  }

  #equipFromSave() {
    const inv = this.save.inventory;
    if (inv.secondary && !inv.bag.some((w) => w.id === inv.secondary)) inv.secondary = null;
    const slot = inv.activeSlot === 'secondary' && inv.secondary ? 'secondary' : 'main';
    const dna = this.#slotDna(slot) ?? this.#slotDna(slot === 'main' ? 'secondary' : 'main');
    this.weapon = dna ? compileWeapon(dna) : null;
    this.recomputeStats();
  }

  /** Puts a weapon in the main or secondary slot (swapping if needed). */
  equip(id, slot = 'main') {
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
    const key = slot === 'secondary' ? 'secondary' : 'equipped';
    const other = key === 'equipped' ? 'secondary' : 'equipped';
    if (inv[other] === dna.id) inv[other] = inv[key] ?? null; // swap the two
    inv[key] = dna.id;
    if (key === 'equipped' && !inv.equipped) inv.equipped = dna.id;
    // Equipping always puts that weapon in your hands.
    inv.activeSlot = slot === 'secondary' ? 'secondary' : 'main';
    this.#applySlot();
    this.emit('inventory');
    this.saveNow();
    return true;
  }

  /**
   * Switches what you hold: 'main' | 'secondary' | 'tool' | 'none'.
   * Choosing the slot you already hold puts it away (empty hands).
   */
  switchSlot(slot) {
    const inv = this.save.inventory;
    if (slot === inv.activeSlot || slot === 'none') {
      if (inv.activeSlot === 'none') return true;
      inv.activeSlot = 'none';
      this.#applySlot();
      this.audio.play('swish');
      return true;
    }
    if (slot === 'tool' && !currentPickaxe(this.data, this.save)) {
      this.toast('No pickaxe yet: forge one at the Forge (Tools)', 'warn');
      return false;
    }
    if (slot === 'secondary' && !inv.secondary) {
      this.toast('No secondary weapon: pick one in the inventory', 'warn');
      return false;
    }
    if (slot === 'main' && !inv.equipped) return false;
    inv.activeSlot = slot;
    this.#applySlot();
    this.audio.play('ui');
    return true;
  }

  /** Cycles through the filled slots (mouse wheel / gamepad). */
  cycleSlot(dir = 1) {
    const inv = this.save.inventory;
    const order = ['main', 'secondary', 'tool'].filter((s) =>
      (s === 'main' && inv.equipped) || (s === 'secondary' && inv.secondary) || (s === 'tool' && currentPickaxe(this.data, this.save)));
    if (order.length < 2) return;
    const i = order.indexOf(this.activeSlot);
    this.switchSlot(order[(i + dir + order.length) % order.length]);
  }

  #applySlot() {
    const inv = this.save.inventory;
    if (inv.activeSlot !== 'tool') {
      const dna = this.#slotDna(inv.activeSlot) ?? this.#slotDna('main');
      if (dna && dna.id !== this.weapon?.dna.id) this.weapon = compileWeapon(dna);
      if (!dna) this.weapon = null;
    }
    const p = this.player;
    p.attackAnim = null;
    p.toolAnim = null;
    p.attackCd = 0.25;
    p.swapT = 0.25;
    this.recomputeStats();
    this.interactTarget = null;
    this.emit('interact', { label: null });
    this.emit('equip', this.weapon?.dna ?? null);
    this.emit('slot', { slot: inv.activeSlot });
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
    if (this.inLoadout(id)) {
      this.toast('That weapon is in your loadout: swap it out first', 'warn');
      return false;
    }
    dest.push(...from.splice(idx, 1));
    this.emit('inventory');
    this.saveNow();
    return true;
  }

  salvage(id) {
    if (this.inLoadout(id)) {
      this.toast("You can't salvage a weapon in your loadout", 'warn');
      return null;
    }
    const value = this.#salvageOne(id);
    if (value) {
      this.emit('inventory');
      this.saveNow();
    }
    return value;
  }

  /** Salvages several weapons at once; skips the equipped weapon and favorites. */
  salvageMany(ids) {
    const inv = this.save.inventory;
    const total = { scrap: 0, essence: 0, count: 0 };
    for (const id of ids) {
      if (this.inLoadout(id) || inv.favorites.includes(id)) continue;
      const v = this.#salvageOne(id);
      if (!v) continue;
      total.scrap += v.scrap;
      total.essence += v.essence;
      total.count += 1;
    }
    if (total.count) {
      this.toast(`Salvaged ${total.count} weapons for ${total.scrap} scrap and ${total.essence} essence`);
      this.emit('inventory');
      this.saveNow();
    }
    return total;
  }

  #salvageOne(id) {
    const inv = this.save.inventory;
    for (const list of [inv.bag, inv.storage]) {
      const idx = list.findIndex((w) => w.id === id);
      if (idx < 0) continue;
      const [dna] = list.splice(idx, 1);
      const value = salvageValue(dna);
      this.#grant(value);
      inv.favorites = inv.favorites.filter((f) => f !== id);
      inv.unseen = inv.unseen.filter((f) => f !== id);
      return value;
    }
    return null;
  }

  /** Adds a weapon you bought/traded for (bag first, then storage). */
  addWeapon(dna) {
    const inv = this.save.inventory;
    this.#registerDiscovery(dna);
    if (inv.bag.length < inv.bagSize) inv.bag.push(dna);
    else inv.storage.push(dna);
    inv.unseen.push(dna.id);
    this.emit('inventory');
  }

  /** Removes a weapon (sold / traded away). Loadout weapons are protected. */
  removeWeapon(id) {
    const inv = this.save.inventory;
    if (this.inLoadout(id)) return false;
    for (const list of [inv.bag, inv.storage]) {
      const idx = list.findIndex((w) => w.id === id);
      if (idx >= 0) list.splice(idx, 1);
    }
    inv.favorites = inv.favorites.filter((f) => f !== id);
    inv.unseen = inv.unseen.filter((f) => f !== id);
    this.emit('inventory');
    return true;
  }

  /** Adds a { scrap, essence, shards, gold, ... } bundle to the resources. */
  #grant(bundle) {
    const r = this.save.resources;
    for (const [k, v] of Object.entries(bundle)) if (v) r[k] = (r[k] ?? 0) + v;
  }

  toggleFavorite(id) {
    const inv = this.save.inventory;
    const on = !inv.favorites.includes(id);
    inv.favorites = on ? [...inv.favorites, id] : inv.favorites.filter((f) => f !== id);
    this.saveNow();
    return on;
  }

  /** Clears the NEW badge. */
  markSeen(id) {
    const inv = this.save.inventory;
    if (inv.unseen.includes(id)) inv.unseen = inv.unseen.filter((f) => f !== id);
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

  /**
   * Shows the discovery screen. `caseRoll` ({ min, max, title }) plays a
   * case-opening roll first (chests, the Forge).
   */
  discoverWeapon(dna, { caseRoll = null } = {}) {
    this.#registerDiscovery(dna);
    this.discoveryQueue.push({ dna, caseRoll });
    if (!this.discoveryOpen) this.#openNextDiscovery();
  }

  #openNextDiscovery() {
    const next = this.discoveryQueue.shift();
    if (!next) return;
    const { dna, caseRoll } = next;
    this.discoveryOpen = true;
    const r = this.data.rarityIndex.get(dna.rarity) ?? 0;
    const color = this.data.byId.rarities.get(dna.rarity)?.color ?? '#ffffff';
    if (caseRoll) {
      // The roll makes its own reveal.
    } else if (r >= 2) {
      const p = this.player;
      this.fx.add({ type: 'ring', x: p.x, y: p.y, r0: 0.3, r1: 1.5 + r * 0.6, color, dur: 0.5, fill: r >= 3 });
      this.fx.emit('glint', p.x, p.y - 0.5, 8 + r * 6, 1.2, 3, [color, '#ffffff']);
    }
    if (r >= 3 && !caseRoll) this.flash(color, 0.4);
    this.pause('discovery');
    if (!caseRoll) this.audio.play('discover', { rarity: r });
    this.vibrate(r >= 4 ? [40, 60, 80] : 40);
    const inv = this.save.inventory;
    this.emit('discovery', {
      dna,
      caseRoll,
      canKeep: inv.bag.length < inv.bagSize,
      canStore: inv.storage.length < inv.storageSize,
      salvage: salvageValue(dna),
      equipped: this.weapon?.dna ?? null,
    });
  }

  /** choice: 'equip' | 'secondary' | 'keep' | 'storage' | 'salvage' */
  resolveDiscovery(dna, choice) {
    const inv = this.save.inventory;
    const bagFull = inv.bag.length >= inv.bagSize;
    const storageFull = inv.storage.length >= inv.storageSize;
    if ((choice === 'keep' || choice === 'equip' || choice === 'secondary') && bagFull) choice = storageFull ? 'salvage' : 'storage';
    if (choice === 'storage' && storageFull) choice = 'salvage';
    if (choice === 'salvage') {
      const v = salvageValue(dna);
      this.#grant(v);
      this.toast(`Salvaged for ${v.scrap} scrap and ${v.essence} essence${v.shards ? ` and ${v.shards} Star Shard` : ''}`);
    } else if (choice === 'storage') {
      inv.storage.push(dna);
      inv.unseen.push(dna.id);
      this.toast(`${dna.name.text} sent to storage`);
    } else {
      inv.bag.push(dna);
      if (choice === 'equip' || choice === 'secondary') {
        const key = choice === 'secondary' ? 'secondary' : 'equipped';
        inv[key] = dna.id;
        // Equip puts it in your hands; a new secondary waits in slot 2.
        if (choice === 'equip') inv.activeSlot = 'main';
        this.#applySlot();
      } else {
        inv.unseen.push(dna.id);
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
    const cost = researchCost(this.data, this.save, def);
    if (this.save.resources.essence < cost) {
      this.toast(`Needs ${cost} essence`, 'warn');
      return false;
    }
    this.save.resources.essence -= cost;
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
    const cost = craftCost(this.data, choice, this.save);
    const request = buildCraftRequest(this.data, this.save, choice, Math.floor(this.pstats.luck));
    this.save.resources.scrap -= cost.scrap;
    this.save.resources.essence -= cost.essence;
    if (cost.shards) this.save.resources.shards -= cost.shards;
    this.save.counters.craft += 1;
    await this.saveNow();
    const dna = await this.weapons.generate(request);
    const catalyst = this.data.byId.catalysts.get(choice.catalyst ?? 'none');
    this.discoverWeapon(dna, { caseRoll: { min: catalyst.minRarity, max: catalyst.maxRarity, title: 'Forging…' } });
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
      const forge = buildingDef(this.data, 'forge');
      if (forge && pl.level === forge.levels[0].playerLevel && buildingLevel(this.data, this.save, 'forge') === 0) {
        this.toast('You can now build a Forge at your camp and craft your own weapons!', 'legendary');
      }
      if (pl.level === 4) this.#rumourOfMarket();
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

  /** Marks the chunks around you as explored (what the map shows). */
  #explore() {
    const p = this.player;
    const cx = Math.floor(p.x / CHUNK);
    const cy = Math.floor(p.y / CHUNK);
    let added = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${cx + dx},${cy + dy}`;
        if (this.explored.has(key)) continue;
        this.explored.add(key);
        this.save.world.explored.push(key);
        added = true;
      }
    }
    if (added) this.emit('explored');
  }

  /** A traveller's tip about the nearest market: it shows up on the map. */
  #rumourOfMarket() {
    const m = this.world.firstMarket;
    const st = this.markets.state(m.id);
    if (st.seen || st.visited) return;
    st.seen = true;
    const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
    const dir = dirs[((Math.round(Math.atan2(m.y, m.x) / (Math.PI / 4)) % 8) + 8) % 8];
    this.schedule(2, () => this.toast(`A traveller mentions ${m.name}, a market to the ${dir}. It's on your map (M).`, 'component'));
  }

  /** Your own map markers (max 40). */
  addPin(x, y, label = '') {
    const pins = this.save.world.pins;
    if (pins.length >= 40) pins.shift();
    pins.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, label });
    this.requestSave();
  }

  removePin(index) {
    this.save.world.pins.splice(index, 1);
    this.requestSave();
  }

  /** Brief full-screen colour flash (legendary drops and pickups). */
  flash(color, dur = 0.3) {
    this.screenFlash = { color, t: dur, dur };
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
      case 'wood':
      case 'stone':
      case 'gold':
        r[it.kind] = (r[it.kind] ?? 0) + it.value;
        this.audio.play('pickup', { throttle: 60 });
        break;
      case 'shard':
        r.shards = (r.shards ?? 0) + it.value;
        this.audio.play('discover', { rarity: 3 });
        this.flash('#ffd24a', 0.25);
        this.toast(`Star Shard! (${r.shards}) — the Golden Catalyst needs them`, 'legendary');
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
    pl.sailing = false;
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
    // Afloat you can only go ashore.
    if (this.sailing) {
      const land = findLanding(this);
      const prev = this.interactTarget;
      return land && prev?.type === 'land' && prev.tx === land.tx && prev.ty === land.ty ? prev : land;
    }
    let best = null;
    let bestD = INTERACT_RADIUS * INTERACT_RADIUS;
    for (const o of this.world.objectsNear(p.x, p.y, 1)) {
      if (o.type === 'chest' && this.save.world.chests.includes(o.key)) continue;
      if (o.type === 'shrine' && this.save.world.shrines.includes(o.key)) continue;
      if (o.type === 'altar' && this.boss) continue;
      if (isPoi(o.type) && POI[o.type].once && poiFound(this.save, o)) continue;
      const d = dist2(p.x, p.y, o.x, o.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    // Merchants at markets (reachable across their stall's counter).
    const npc = this.markets.merchantNear(p.x, p.y, 2.4);
    if (npc && (!best || dist2(p.x, p.y, npc.x, npc.y) < bestD)) {
      const prev = this.interactTarget;
      const hostile = this.markets.isHostile(npc.marketId);
      // A new target (and so a fresh hint) when the merchant's mood changes.
      return prev?.type === 'merchant' && prev.npc === npc && prev.hostile === hostile
        ? prev
        : { type: 'merchant', x: npc.x, y: npc.y, npc, hostile };
    }
    // With the pickaxe in hand, trees and rocks next to you can be harvested.
    if (!best && !this.build.active && this.toolActive) {
      const h = findHarvestTarget(this);
      if (h) {
        const prev = this.interactTarget;
        return prev?.type === 'harvest' && prev.tx === h.tx && prev.ty === h.ty ? prev : h;
      }
    }
    // At the water's edge: launch your boat (or learn why you can't).
    if (!best && !this.build.active) {
      const w = findLaunch(this);
      if (w) {
        const prev = this.interactTarget;
        return prev?.type === w.type && prev.x === w.x && prev.y === w.y && prev.reason === w.reason ? prev : w;
      }
    }
    return best;
  }

  interactLabel(o) {
    if (!o) return null;
    switch (o.type) {
      case 'launch': return `Set sail (${o.boat.name})`;
      case 'treasure': return currentPickaxe(this.data, this.save) ? POI.treasure.label : 'Something is buried here (needs a pickaxe)';
      case 'shore': return o.reason;
      case 'land': return 'Go ashore';
      case 'merchant': {
        const left = this.markets.hostileSecondsLeft(o.npc.marketId);
        return left > 0 ? `${o.npc.name} won't trade with you (${Math.ceil(left / 60)} min)` : `Trade with ${o.npc.name}`;
      }
      case 'harvest': {
        const tool = currentPickaxe(this.data, this.save);
        const need = o.info.tier > (tool?.tier ?? 0);
        return need ? `${o.info.name} (needs a better pickaxe)` : `${o.info.verb} ${o.info.name.toLowerCase()}`;
      }
      case 'chest': return 'Open chest';
      case 'shrine': return 'Pray at shrine';
      case 'altar': return `Summon ${this.data.byId.bosses.get(o.bossId)?.name ?? 'boss'}`;
      case 'building': {
        const def = buildingDef(this.data, o.buildingId);
        const level = buildingLevel(this.data, this.save, o.buildingId);
        if (level === 0) return `Build ${def.name}`;
        if (o.buildingId === 'hearth') return 'Rest & manage camp';
        if (o.buildingId === 'well') {
          const n = wellPending(this.data, this.save);
          return n > 0 ? `Collect ${n} essence` : 'Essence Well (filling…)';
        }
        return `Use ${def.name}`;
      }
      default: return isPoi(o.type) ? POI[o.type].label : 'Use';
    }
  }

  // --- Gathering ------------------------------------------------------------------------

  /** One pickaxe swing at a tree/rock; felling it drops wood/stone. */
  /** Pickaxe in hand with nothing to chop: a light melee swing. */
  #swingAtEnemies(tool) {
    const p = this.player;
    const t = this.target && !this.target.dead ? this.target : null;
    const angle = t ? Math.atan2(t.y - p.y, t.x - p.x) : p.facing;
    p.facing = angle;
    p.toolAnim = { t: 0, dur: 0.32, angle };
    p.toolCd = 0.45;
    this.audio.play('swish', { throttle: 80 });
    this.schedule(0.13, () => {
      const dmg = 4 + 6 * tool.tier + this.save.player.level * 1.5;
      this.hitNpcs({ kind: 'arc', x: p.x, y: p.y, angle, range: 1.4, half: 1.2 }, dmg);
      for (const e of this.enemies) {
        if (e.dead) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 1.4 + e.r) continue;
        if (Math.cos(Math.atan2(dy, dx) - angle) < 0.2) continue;
        dealDamage(this, e, dmg, { canCrit: false, melee: true });
      }
    });
  }

  #swingPickaxe(o) {
    const p = this.player;
    const tool = currentPickaxe(this.data, this.save);
    if (!tool || p.toolCd > 0 || p.dead) return;
    if (!o) {
      this.#swingAtEnemies(tool);
      return;
    }
    if (o.info.tier > tool.tier) {
      if (!this.warnedTier) this.toast(`You need a stronger pickaxe for ${o.info.name.toLowerCase()}s. Forge one at the Forge.`, 'warn');
      this.warnedTier = true;
      p.toolCd = 0.6;
      return;
    }
    const angle = Math.atan2(o.y - p.y, o.x - p.x);
    p.facing = angle;
    p.toolAnim = { t: 0, dur: 0.32, angle };
    p.toolCd = 0.36;
    this.schedule(0.13, () => {
      const key = `${o.tx},${o.ty}`;
      if (!this.world.blockAt(o.tx, o.ty)) return;
      const dmg = (this.harvestDamage.get(key)?.dmg ?? 0) + tool.power;
      this.harvestDamage.set(key, { dmg, at: this.time });
      const wood = o.info.drops.wood;
      this.fx.emit(wood ? 'wood' : 'stone', o.x, o.y - 0.2, 5, 0.5, 2);
      this.audio.play(wood ? 'chop' : 'mine', { throttle: 50 });
      this.shake = Math.max(this.shake, 0.05);
      if (dmg >= o.info.hp) this.#fell(o);
    });
  }

  #fell(o) {
    this.world.removeBlock(o.tx, o.ty);
    this.harvestDamage.delete(`${o.tx},${o.ty}`);
    const drops = rollDrops(o.info);
    const color = { wood: '#b07a48', stone: '#b8bcc8', essence: '#7ae0ff' };
    for (const [kind, n] of Object.entries(drops)) {
      for (let i = 0; i < n; i++) addPickup(this, kind, o.x, o.y, { value: 1, color: color[kind] ?? '#ffffff' });
    }
    const label = Object.entries(drops).map(([k, n]) => `+${n} ${k}`).join(' ');
    this.fx.text(o.x, o.y - 1, label.toUpperCase(), '#ffe890', 1.2);
    this.fx.emit(o.info.drops.wood ? 'leaf' : 'stone', o.x, o.y - 0.3, 14, 0.9, 2.5);
    this.audio.play('fell');
    this.interactTarget = null;
    this.emit('interact', { label: null });
    this.requestSave();
  }

  // --- Sailing ---------------------------------------------------------------------

  #setSail(spot) {
    const p = this.player;
    const boat = this.boat;
    if (!boat || this.sailing) return;
    if (this.build.active) this.toggleBuildMode(false);
    this.fx.emit('glint', spot.x, spot.y, 14, 0.6, 2, ['#e8f8ff', '#9ad8f4']);
    p.x = spot.x;
    p.y = spot.y;
    this.save.player.sailing = true;
    this.target = null;
    this.audio.play('swish');
    if (!this.save.flags.sailed) {
      this.save.flags.sailed = true;
      this.toast(`All aboard the ${boat.name}! Steer like walking; Use next to land to go ashore.`, 'component');
    }
    this.interactTarget = null;
    this.emit('interact', { label: null });
    this.emit('sailing', { on: true });
  }

  #goAshore(spot) {
    const p = this.player;
    this.fx.emit('glint', p.x, p.y, 10, 0.5, 2, ['#e8f8ff', '#9ad8f4']);
    p.x = spot.x;
    p.y = spot.y;
    this.save.player.sailing = false;
    this.audio.play('swish');
    this.interactTarget = null;
    this.emit('interact', { label: null });
    this.emit('sailing', { on: false });
  }

  /** Builds the next boat at the Forge (Tools). */
  buildBoat(tier) {
    try {
      const def = buildBoat(this.data, this.save, tier);
      this.audio.play('levelup');
      this.toast(`${def.name} built! Walk up to the water and press Use to set sail.`, 'level');
      this.emit('inventory');
      this.emit('tools');
      this.saveNow();
      return def;
    } catch (err) {
      this.toast(err.message, 'warn');
      return null;
    }
  }

  forgePickaxe(tier) {
    try {
      const def = forgePickaxe(this.data, this.save, tier);
      this.audio.play('levelup');
      this.toast(`${def.name} forged! Walk up to a tree or rock and press Use.`, 'level');
      this.emit('inventory');
      this.emit('tools');
      this.saveNow();
      return def;
    } catch (err) {
      this.toast(err.message, 'warn');
      return null;
    }
  }

  // --- Construction ----------------------------------------------------------------------

  buildRadius() {
    return buildRadius(this.data, this.save);
  }

  damageStructure(st, amount) {
    // Market walls and turrets are built to last.
    if (st.owner === 'market') {
      st.rt.flash = 0.1;
      return;
    }
    this.construction.damage(st, amount);
  }

  /** Every structure to draw: your camp's and those of nearby markets. */
  structuresForDraw() {
    const mine = this.save.base.structures;
    const markets = this.markets.structures;
    return markets.length ? mine.concat(markets) : mine;
  }

  /** Your attacks can hurt people at markets (see Markets.hitNpcs). */
  hitNpcs(shape, damage) {
    return this.markets.npcs.length ? this.markets.hitNpcs(shape, damage) : false;
  }

  /** A turret's projectile reached an enemy. */
  turretHit(proj, e) {
    dealDamage(this, e, proj.damage, { element: proj.element, structure: proj.structure, canCrit: false });
    if (proj.status && !e.dead) applyStatus(this, e, proj.status, proj.damage);
  }

  /** Coalesces rapid changes (placing many walls) into one save. */
  requestSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1500);
  }

  toggleBuildMode(on = !this.build.active) {
    const b = this.build;
    if (on === b.active) return;
    if (on) {
      const p = this.player;
      if (p.dead) return;
      if (this.sailing) {
        this.toast('Go ashore to build.', 'warn');
        return;
      }
      if (Math.hypot(p.x - 0.5, p.y - 0.5) > this.buildRadius() + 6) {
        this.toast('Go back to your camp to build.', 'warn');
        return;
      }
      b.active = true;
      b.tool = 'place';
      if (!structureDef(this.data, b.selected)) b.selected = structureDefs(this.data)[0]?.id;
      this.interactTarget = null;
      this.emit('interact', { label: null });
    } else {
      b.active = false;
      b.painting = false;
      b.ghost = null;
    }
    this.audio.play('ui');
    this.emit('build', { active: b.active });
  }

  selectStructure(id) {
    const b = this.build;
    if (id === 'remove') {
      b.tool = b.tool === 'remove' ? 'place' : 'remove';
    } else if (structureDef(this.data, id)) {
      b.selected = id;
      b.tool = 'place';
    }
    this.emit('build', { active: b.active });
  }

  /** Places (or removes) at a tile; returns the problem text or null. */
  buildAt(tx, ty, tool = this.build.tool) {
    if (tool === 'remove') {
      const refund = this.construction.remove(tx, ty);
      if (!refund) return 'Nothing to remove here';
      const text = Object.entries(refund).map(([k, n]) => `+${n} ${k}`).join(' ');
      if (text) this.fx.text(tx + 0.5, ty, text.toUpperCase(), '#c8ccd8', 1);
      return null;
    }
    const res = this.construction.place(this.build.selected, tx, ty);
    return res.ok ? null : res.reason;
  }

  buildAtGhost() {
    const g = this.build.ghost;
    if (!g) return;
    const problem = this.buildAt(g.tx, g.ty);
    if (problem) {
      this.toast(problem, 'warn');
      this.audio.play('hurt', { throttle: 200 });
    }
  }

  /** Screen (CSS px) → tile under the pointer. */
  #tileAt(cx, cy) {
    const w = this.renderer.screenToWorld(cx, cy);
    return { tx: Math.floor(w.x), ty: Math.floor(w.y) };
  }

  #bindBuildInput() {
    const b = this.build;
    this.input.worldHandler = {
      active: () => b.active && !this.paused,
      down: (cx, cy, button) => {
        const { tx, ty } = this.#tileAt(cx, cy);
        b.hover = { tx, ty };
        b.hoverAt = this.time;
        const tool = button === 2 ? 'remove' : b.tool;
        const problem = this.buildAt(tx, ty, tool);
        if (problem && tool === 'place') this.toast(problem, 'warn');
        b.painting = tool;
        b.lastTile = `${tx},${ty}`;
      },
      move: (cx, cy) => {
        const { tx, ty } = this.#tileAt(cx, cy);
        b.hover = { tx, ty };
        b.hoverAt = this.time;
        const key = `${tx},${ty}`;
        if (b.painting && key !== b.lastTile) {
          b.lastTile = key;
          this.buildAt(tx, ty, b.painting);
        }
      },
      up: () => {
        b.painting = false;
      },
    };
  }

  /** Where a placement would go: the pointed-at tile, or the one ahead of you. */
  #updateBuildGhost() {
    const b = this.build;
    const p = this.player;
    if (p.dead || Math.hypot(p.x - 0.5, p.y - 0.5) > this.buildRadius() + 10) {
      this.toggleBuildMode(false);
      return;
    }
    let tile;
    if (b.hover && this.time - b.hoverAt < 4) tile = b.hover;
    else tile = { tx: Math.floor(p.x + Math.cos(p.facing) * 1.1), ty: Math.floor(p.y + Math.sin(p.facing) * 1.1) };
    b.ghost = tile;
    if (b.tool === 'remove') {
      b.reason = this.construction.at(tile.tx, tile.ty) ? null : 'Nothing to remove here';
    } else {
      const def = structureDef(this.data, b.selected);
      b.reason = def ? this.construction.placementProblem(def, tile.tx, tile.ty) : 'Pick something to build';
    }
  }

  structureLock(def) {
    return structureLock(this.data, this.save, def);
  }

  // --- Base -------------------------------------------------------------------------

  upgradeBuilding(id) {
    const def = buildingDef(this.data, id);
    try {
      const level = upgradeBuilding(this.data, this.save, id);
      this.recomputeStats();
      this.audio.play('levelup');
      this.fx.emit('sparkle', def.x, def.y - 0.5, 24, 1, 3);
      this.fx.add({ type: 'ring', x: def.x, y: def.y, r0: 0.3, r1: 2, color: '#ffd24a', dur: 0.4 });
      this.toast(level === 1 ? `${def.name} built!` : `${def.name} upgraded to level ${level}!`, 'level');
      if (id === 'forge' && level === 1) {
        this.schedule(1.5, () => this.toast('Forge a pickaxe (Forge → Tools) to gather wood and stone for building.', 'component'));
      }
      this.emit('base');
      this.emit('inventory');
      this.saveNow();
      return level;
    } catch (err) {
      this.toast(err.message, 'warn');
      return null;
    }
  }

  collectWell() {
    const n = collectWell(this.data, this.save);
    if (n > 0) {
      const well = buildingDef(this.data, 'well');
      for (let i = 0; i < Math.min(20, n); i++) addPickup(this, 'essence', well.x, well.y, { value: 0, color: '#7ae0ff' });
      this.toast(`Collected ${n} essence from the well`, 'component');
      this.audio.play('pickup');
      this.emit('base');
      this.saveNow();
    }
    return n;
  }

  recallReadyIn() {
    return Math.max(0, (this.recallReadyAt ?? 0) - this.time);
  }

  /** Waystone: teleport to camp (remembering where we were at level 2). */
  recall() {
    if (buildingLevel(this.data, this.save, 'waystone') < 1 || this.player.dead) return false;
    if (this.recallReadyIn() > 0) {
      this.toast(`The Waystone recharges in ${Math.ceil(this.recallReadyIn())}s`, 'warn');
      return false;
    }
    const p = this.player;
    if (Math.hypot(p.x, p.y) < 8) return false;
    if (buildingLevel(this.data, this.save, 'waystone') >= 2) this.save.base.recall = { x: p.x, y: p.y };
    this.#teleport(buildingDef(this.data, 'waystone').x, buildingDef(this.data, 'waystone').y + 1);
    this.recallReadyAt = this.time + this.data.base.recallCooldown;
    this.toast('Recalled to camp', 'component');
    return true;
  }

  /** Waystone level 2: step back to where the last recall started. */
  returnFromRecall() {
    const back = this.save.base.recall;
    if (!back || buildingLevel(this.data, this.save, 'waystone') < 2) return false;
    this.save.base.recall = null;
    this.#teleport(back.x, back.y);
    this.toast('Back through the Waystone', 'component');
    return true;
  }

  #teleport(x, y) {
    const p = this.player;
    this.fx.emit('arcane', p.x, p.y, 24, 0.6, 3);
    if (this.boss) {
      this.enemies = this.enemies.filter((e) => e !== this.boss);
      this.boss = null;
      this.emit('boss', { active: false, victory: false });
    }
    const spot = this.world.findFreeSpot(x, y, p.r);
    p.x = spot.x;
    p.y = spot.y;
    this.save.player.sailing = false;
    p.invuln = 1;
    this.enemies = this.enemies.filter((e) => Math.hypot(e.x - p.x, e.y - p.y) > 14);
    this.projectiles.length = 0;
    this.renderer.snapCamera?.();
    this.fx.emit('arcane', p.x, p.y, 24, 0.6, 3);
    this.audio.play('zap');
    this.emit('interact', { label: null });
    this.saveNow();
  }

  interact() {
    const o = this.interactTarget;
    if (!o || this.player.dead) return false;
    const pl = this.save.player;
    switch (o.type) {
      case 'harvest':
        this.#swingPickaxe(o);
        return true;
      case 'launch':
        this.#setSail(o);
        return true;
      case 'land':
        this.#goAshore(o);
        return true;
      case 'shore':
        this.toast(o.reason, 'warn');
        return true;
      case 'merchant':
        if (this.markets.isHostile(o.npc.marketId)) {
          this.toast(`${o.npc.name} backs away from you.`, 'warn');
        } else {
          this.emit('ui', { name: 'market', marketId: o.npc.marketId });
        }
        return true;
      case 'chest':
        this.save.world.chests.push(o.key);
        openChestLoot(this, o, { richness: o.rich ? 2 : 1 });
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
        if (def.tip) this.toast(def.tip);
        break;
      }
      case 'building': {
        const id = o.buildingId;
        const level = buildingLevel(this.data, this.save, id);
        if (id === 'hearth') {
          this.player.hp = this.pstats.maxHp;
          pl.spawnX = 0.5;
          pl.spawnY = 1.6;
          this.emit('ui', 'base');
        } else if (level === 0 || id === 'training' || id === 'waystone') {
          this.emit('ui', { name: 'base', focus: id });
        } else if (id === 'forge') {
          this.emit('ui', 'crafting');
        } else if (id === 'vault') {
          this.emit('ui', { name: 'inventory', tab: 'storage' });
        } else if (id === 'library') {
          this.emit('ui', 'research');
        } else if (id === 'well') {
          if (!this.collectWell()) this.emit('ui', { name: 'base', focus: id });
        }
        break;
      }
      default:
        if (isPoi(o.type)) return interactPoi(this, o);
        break;
    }
    this.saveNow();
    return true;
  }

  // --- Simulation -------------------------------------------------------------------

  /** Little signs of life around you: butterflies, fireflies, jumping fish. */
  #ambience(dt) {
    this.ambienceT = (this.ambienceT ?? 0) - dt;
    if (this.ambienceT > 0 || !this.quality.glow) return;
    this.ambienceT = 0.35 + Math.random() * 0.4;
    const p = this.player;
    const x = p.x + (Math.random() - 0.5) * 16;
    const y = p.y + (Math.random() - 0.5) * 10;
    if (this.world.isSea(x, y)) {
      if (Math.random() < 0.35) {
        this.fx.emit('splash', x, y, 6, 0.2, 1.2);
        this.fx.add({ type: 'ring', x, y, r0: 0.1, r1: 0.6, color: '#e8f8ff', dur: 0.4 });
      }
      return;
    }
    if (this.world.isSolid(Math.floor(x), Math.floor(y))) return;
    const biome = this.world.biomeAt(Math.floor(x), Math.floor(y)).id;
    if (['plains', 'isles', 'forest', 'highlands'].includes(biome) && Math.random() < 0.5) {
      this.fx.emit('butterfly', x, y - 0.5, 1, 0.3, 0.4);
    } else if (['forest', 'void', 'snow'].includes(biome) && Math.random() < 0.6) {
      this.fx.emit('firefly', x, y - 0.4, 2, 0.8, 0.25);
    }
  }

  /** Where the weapon points: the locked target if any, else where we walk. */
  #aim(sample) {
    const p = this.player;
    const h = this.interactTarget;
    if (this.toolActive && h?.type === 'harvest') return Math.atan2(h.y - p.y, h.x - p.x);
    const t = this.target;
    if (t && !t.dead) return Math.atan2(t.y - p.y, t.x - p.x);
    if (sample.moveX || sample.moveY) return Math.atan2(sample.moveY, sample.moveX);
    return p.facing;
  }

  #updatePlayer(dt, sample) {
    const p = this.player;
    p.invuln = Math.max(0, p.invuln - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt);
    if (this.screenFlash) {
      this.screenFlash.t -= dt;
      if (this.screenFlash.t <= 0) this.screenFlash = null;
    }
    p.attackCd = Math.max(0, p.attackCd - dt);
    if (p.attackAnim) {
      p.attackAnim.t += dt;
      if (p.attackAnim.t >= p.attackAnim.dur) p.attackAnim = null;
    }
    p.toolCd = Math.max(0, p.toolCd - dt);
    if (p.toolAnim) {
      p.toolAnim.t += dt;
      if (p.toolAnim.t >= p.toolAnim.dur) p.toolAnim = null;
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
    const sailing = this.sailing;
    const speed = sailing
      ? (this.boat?.speed ?? 3.5) * (p.sprinting ? 1.2 : 1) * slow
      : this.pstats.moveSpeed * (p.sprinting ? this.data.player.sprintMultiplier : 1) * slow;
    const vx = sample.moveX * speed + p.kx;
    const vy = sample.moveY * speed + p.ky;
    p.vx = vx; // bosses lead their shots with this
    p.vy = vy;
    const damp = Math.exp(-10 * dt);
    p.kx *= damp;
    p.ky *= damp;
    const nx = p.x + vx * dt;
    const ny = p.y + vy * dt;
    const mode = this.moveMode;
    if (this.world.isFree(nx, p.y, p.r, mode)) p.x = nx;
    if (this.world.isFree(p.x, ny, p.r, mode)) p.y = ny;
    p.moving = moving;
    if (moving) p.walkT += dt * (p.sprinting ? 14 : 9);
    if (sailing) {
      // Foam in the wake.
      if (moving && Math.random() < 0.6) {
        this.fx.emit('glint', p.x - Math.cos(p.facing) * 0.8, p.y + 0.25, 1, 0.3, 0.6, ['#e8f8ff', '#9ad8f4']);
      }
    } else if (p.sprinting && Math.random() < 0.3) {
      this.fx.emit('dust', p.x, p.y + 0.3, 1, 0.2, 0.5);
    }

    // Aiming is automatic on every device: the weapon locks onto an enemy.
    // With empty hands there is nothing to aim.
    this.target = this.handsEmpty ? null : acquireTarget(this, this.target);
    const aim = this.#aim(sample);
    if (!p.attackAnim) p.facing = aim;

    if (!sample.attack) this.suppressAttack = false;
    if (this.build.active) {
      this.#updateBuildGhost(sample);
    } else if (this.toolActive) {
      // Pickaxe in hand: hold to keep chopping (or swing at enemies).
      const h = this.interactTarget?.type === 'harvest' ? this.interactTarget : null;
      if (sample.attack && p.toolCd <= 0 && (h || !this.suppressAttack)) {
        this.suppressAttack = true;
        this.#swingPickaxe(h);
      }
    } else if (sample.attack && !this.suppressAttack && !this.handsEmpty) {
      tryAttack(this, aim);
    }
    p.swapT = Math.max(0, (p.swapT ?? 0) - dt);

    // Weapon ambience particles from the DNA's visual parameters.
    const part = this.handsEmpty ? null : this.weapon?.particles;
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
      if (this.build.active && (c === 'interact' || c === 'interact-or-attack')) {
        this.buildAtGhost();
        continue;
      }
      if (c === 'interact' || c === 'interact-or-attack') {
        if (this.interact()) this.suppressAttack = true;
        else if (c === 'interact-or-attack' && !this.handsEmpty) tryAttack(this, this.#aim(sample));
      } else if (c === 'ability') {
        if (!this.toolActive && !this.handsEmpty) castAbility(this, this.#aim(sample));
      } else if (c === 'slot1' || c === 'slot2' || c === 'slot3') {
        if (!this.build.active) this.switchSlot({ slot1: 'main', slot2: 'secondary', slot3: 'tool' }[c]);
      } else if (c === 'slotNext' || c === 'slotPrev') {
        if (!this.build.active) this.cycleSlot(c === 'slotNext' ? 1 : -1);
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
    this.construction.update(dt);
    this.markets.update(dt);
    this.#ambience(dt);
    this.exploreT -= dt;
    if (this.exploreT <= 0) {
      this.exploreT = 0.5;
      this.#explore();
    }
    this.regrowT -= dt;
    if (this.regrowT <= 0) {
      this.regrowT = REGROW_INTERVAL;
      regrow(this);
    }
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

    const target = this.build.active ? null : this.#findInteractable();
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
      wood: this.save.resources.wood ?? 0,
      stone: this.save.resources.stone ?? 0,
      building: this.build.active,
      nearCamp: Math.hypot(this.player.x - 0.5, this.player.y - 0.5) <= this.buildRadius() + 6,
      ability: abilityProgress(this),
      abilityName: this.weapon?.dna.ability?.name ?? null,
      sprinting: this.player.sprinting,
      boss: this.boss ? { name: this.boss.bossDef.name, hp: this.boss.hp, maxHp: this.boss.maxHp, phase: this.boss.phase } : null,
      dead: this.player.dead,
      fps: Math.round(1000 / this.frameMs),
      craftingUnlocked: isCraftingUnlocked(this.data, this.save),
      campAlert: this.#campAlert(),
      compass: (this.lastCompass = this.#compass()),
    };
  }

  /** Something to do at camp: essence waiting in the well or an affordable upgrade. */
  #campAlert() {
    if (wellPending(this.data, this.save) > 0) return true;
    return this.data.base.buildings.some((b) => upgradeBlockers(this.data, this.save, b.id).length === 0);
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
