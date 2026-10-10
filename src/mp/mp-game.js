// The multiplayer game on the client. It looks like the single-player Game
// to the renderer, HUD and panels (same fields and methods), but the world
// lives on the server:
//  - your own character is predicted locally with the server's movement code
//    and corrected smoothly when the server disagrees;
//  - everyone and everything else is drawn ~100 ms in the past, interpolated
//    between snapshots, so it moves smoothly whatever the network does;
//  - every action (attack, build, forge, trade) is a request the server checks.

import { World, CHUNK, tileKey } from '../game/world.js';
import { Fx } from '../game/fx.js';
import { compileWeapon } from '../game/combat.js';
import { structureDef, structureDefs, groundProblem, onWater, stony, upgradeDef, upgradeCost } from '../game/construction.js';
import { currentPickaxe, findHarvestTarget, harvestInfo, pickaxeDefs } from '../game/gathering.js';
import { canAfford, shortfalls, baseBonuses } from '../game/base.js';
import { salvageValue } from '../game/loot.js';
import { angleTo, dist2 } from '../core/math.js';
import { attackDuration, impactDelay, MELEE_PATTERNS } from '../render/weapon-anim.js';
import {
  ET, SF, CMD, BTN, encodeInput, decodeSnapshot, angleToByte,
} from '../net/protocol.js';
import { stepMove, quantizeAxis, TICK_RATE, TICK_DT, TICK_MS, PLAYER_RADIUS } from '../net/movement.js';
import { mpGameData, mpStructureLock } from '../net/mpbuild.js';
import { mpVirtualSave } from '../net/mpsave.js';
import { inSafeZone, claimAt, canDo, bannerProblem, pvpBlock } from '../net/rules.js';
import { Connection } from './connection.js';
import {
  EntityStore, makeEnemy, updateEnemy, readPlayer, readProjectile, readPickup, readArea, readAlly, readPal, readNpc, readHorse, readWorker,
} from './entities.js';
import { BREED_BY_ID, describeHorse, HORSE_MODE } from '../game/horses.js';
import { MpMarkets } from './markets.js';
import { workerLook } from '../game/workers.js';
import { palStats, palSpecies, findPal, PAL_MODES } from '../game/pals.js';
import { POI, isPoi, poiFound, chunksAround } from '../game/discoveries.js';
import { currentBoat, boatMode, boatDefs, findLaunch, findLanding } from '../game/sailing.js';
import { emptyPals } from '../net/mpsave.js';
import { TOWN_LEVELS, clanLevels, buildingOfStruct, BUILDING_SV } from '../net/mpbase.js';
import { townMarket } from '../game/markets.js';
import { abilityProgress, abilityReadyIn } from '../game/abilities.js';

const DEG = Math.PI / 180;
// Effect shapes an ability may draw (anything else from a server is ignored).
const FX_SHAPES = new Set(['ring', 'line', 'bolt', 'pillar', 'marker', 'meteor', 'slash', 'spike', 'beam', 'flash']);
const QUALITY = {
  high: { particles: 650, glow: true, enemyFactor: 1, resolution: 1 },
  low: { particles: 220, glow: false, enemyFactor: 0.75, resolution: 0.8 },
};
const INTERACT_RADIUS = 1.6;
const SNAP_DIST = 2; // corrections bigger than this jump instead of gliding
const BUILDING_LABELS = { hearth: 'Vila vid Fristadens eld', forge: 'Smid i Fristadens smedja (upp till sällsynt)' };
const BASE_LABELS = {
  hearth: 'Vila vid härden', forge: 'Smid', vault: 'Förrådet', library: 'Forska', training: 'Träningsplatsen',
  well: 'Hämta essens', den: 'Djurhuset (pals)', waystone: 'Vägstenen', lodge: 'Arbetarstugan (arbetare)',
};
const SOUND_KINDS = { essence: 'pickup', scrap: 'pickup', wood: 'pickup', stone: 'pickup', gold: 'pickup' };

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore (private mode)
  }
}

export class MpGame {
  constructor({ data, save, saveManager, weapons, renderer, input, audio }) {
    this.mp = true;
    this.baseData = data;
    this.data = mpGameData(data);
    this.spSave = save;
    this.saveManager = saveManager;
    this.weapons = weapons;
    this.renderer = renderer;
    this.input = input;
    this.audio = audio;
    this.listeners = new Map();
    this.fx = new Fx();
    this.time = 0;
    this.frame = 0;
    this.enemies = [];
    this.projectiles = [];
    this.localShots = [];
    this.areas = [];
    this.pickups = [];
    this.allies = [];
    this.others = [];
    this.mates = [];
    this.pal = null;
    this.otherPals = []; // other players' pals
    this.horses = []; // wild horses and players' own nearby
    this.workers = []; // clan workers nearby (from the server)
    this.boss = null;
    this.shake = 0;
    this.hitstop = 0;
    this.screenFlash = null;
    this.ascend = null;
    this.abilityReadyAt = new Map(); // weapon id → this.time it is ready (the server's cooldowns)
    this.timers = [];
    this.pauseReasons = new Set();
    this.discoveryQueue = [];
    this.discoveryOpen = false;
    this.interactTarget = null;
    this.target = null;
    this.harvestDamage = new Map();
    this.explored = new Set();
    this.qualityLevel = 'high';
    this.frameMs = 16;
    this.godMode = false;
    this.markets = new MpMarkets(this);
    this.build = { active: false, selected: 'banner', tool: 'place', ghost: null, reason: null, hover: null, hoverAt: -99, painting: false, lastTile: null };
    this.player = {
      x: 0.5, y: 2.6, r: PLAYER_RADIUS, vx: 0, vy: 0, kx: 0, ky: 0, facing: 0, hp: 1, maxHp: 100, dead: false,
      invuln: 0, attackCd: 0, attackAnim: null, attackCount: 0, sprinting: false, moving: false, walkT: 0,
      hurtFlash: 0, statuses: {}, toolAnim: null, toolCd: 0, guard: 1,
    };
    // Network state.
    this.conn = null;
    this.connected = false;
    this.myId = 0;
    this.seq = 0;
    this.pending = [];
    this.pred = { x: 0.5, y: 2.6, kx: 0, ky: 0 };
    this.prev = { x: 0.5, y: 2.6 };
    this.corr = { x: 0, y: 0 };
    this.speed = data.player.moveSpeed;
    this.sprintMult = data.player.sprintMultiplier;
    this.acc = 0;
    this.store = new EntityStore();
    this.known = new Map();
    this.pinfo = new Map();
    this.dnaRefs = new Map();
    this.compiled = new Map();
    this.eventQueue = [];
    this.offsets = [];
    this.offsetSmooth = null;
    this.interpDelay = 3;
    this.renderTick = 0;
    this.serverTick = 0;
    this.selfFlags = 0;
    this.serverObjects = new Map();
    this.structByChunk = new Map();
    this.structById = new Map();
    this.altarsSpent = new Set();
    this.claims = [];
    this.me = null;
    this.clan = null;
    this.invites = [];
    this.chatLog = [];
    this.netStats = { corrections: 0, bigCorrections: 0, lastError: 0, snapshots: 0, bytesPerSec: 0 };
    this.pendingCmd = 0;
    this.suppressAttack = false;
    this.save = this.#mirrorSave();
    this.weapon = null;
    this.pstats = { maxHp: 100, moveSpeed: data.player.moveSpeed, attackPower: 0, defense: 0, critChance: 5, critDamage: 150, luck: 0, resist: {}, damageTaken: 1, attackSpeedMult: 1 };
    this.#applySettings();
  }

  // --- Events (same tiny bus as the single-player game) -------------------------------

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
        console.error(`[mp] listener for ${name} failed`, err);
      }
    }
  }

  toast(text, kind = 'info') {
    this.emit('toast', { text, kind });
  }

  schedule(delay, fn) {
    this.timers.push({ at: this.time + delay, fn });
  }

  // --- Settings / quality ------------------------------------------------------------------

  setQuality(level) {
    this.qualityLevel = level;
    this.quality = QUALITY[level];
    this.fx.setBudget(this.quality.particles);
    this.renderer.setResolution(this.quality.resolution);
  }

  #applySettings() {
    const s = this.spSave.settings;
    this.audio.configure({ volume: s.volume, sfx: s.sfx });
    this.fx.damageNumbers = s.damageNumbers;
    this.setQuality(s.quality === 'low' ? 'low' : 'high');
    this.renderer.setViewSize?.(s.viewSize ?? 'auto');
    this.renderer.setHd?.(s.pixels !== 'classic');
    this.renderer.setTerrainStyle?.(s.graphics ?? 'rich');
  }

  updateSettings(patch) {
    Object.assign(this.spSave.settings, patch);
    this.#applySettings();
    this.saveNow();
  }

  /** Multiplayer progress lives on the server; this only keeps your settings. */
  async saveNow() {
    try {
      return await this.saveManager.write(this.spSave);
    } catch {
      return false;
    }
  }

  requestSave() {}

  // --- The single-player save's shape, mirrored from the server -------------------------------

  #mirrorSave() {
    const ch = { level: 1, xp: 0, resources: { essence: 0, scrap: 0, wood: 0, stone: 0, gold: 0, shards: 0 }, pickaxe: 0, extra: {} };
    const save = mpVirtualSave(this.data, 0, ch, null);
    save.settings = this.spSave.settings;
    save.rev = 0;
    save.player = { ...save.player, playTime: 0, spawnX: 0.5, spawnY: 1.6, sailing: false, bonusLuck: 0 };
    save.flags = { tutorialSeen: true, sailed: true };
    return save;
  }

  #applyMe(me) {
    this.me = me;
    const s = this.save;
    s.player.level = me.level;
    s.player.xp = me.xp;
    s.player.kills = me.kills;
    s.player.deaths = me.deaths;
    s.player.playTime = me.playSeconds;
    Object.assign(s.resources, me.resources);
    s.tools.pickaxe = me.pickaxe;
    s.tools.boat = me.boat ?? 0;
    s.bosses.defeated = me.bosses ?? {};
    s.codex.modifiers = me.codex?.modifiers ?? [];
    s.codex.abilities = me.codex?.abilities ?? [];
    s.counters.craft = me.crafts ?? 0;
    s.pals = me.pals ?? emptyPals();
    s.horses = me.horses ?? { owned: [], riding: null };
    s.world.found = me.found ?? [];
    s.components = me.components ?? {};
    s.markets = me.markets ?? {};
    if (me.stats) this.pstats = me.stats;
    this.xpNext = me.xpNext;
    this.emit('inventory');
    this.emit('tools');
    this.emit('pals');
    this.emit('components');
    this.emit('riding', {});
    this.emit('me', me);
  }

  // --- Lifecycle ---------------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const elapsed = Math.min(250, now - this.last);
      this.last = now;
      this.frameMs = this.frameMs * 0.95 + elapsed * 0.05;
      // Fixed 30 Hz steps for input and prediction (the server's rate).
      this.acc += elapsed;
      let steps = 0;
      while (this.acc >= TICK_MS && steps < 4) {
        this.#clientTick();
        this.acc -= TICK_MS;
        steps++;
      }
      if (steps === 4) this.acc = 0;
      this.#frameUpdate(elapsed / 1000, now);
      this.renderer.draw(this);
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

  /** Panels don't stop the world (it's shared), they just stop your input. */
  pause(reason) {
    this.pauseReasons.add(reason);
    this.input.reset();
    this.emit('pause', { paused: true, reasons: [...this.pauseReasons] });
  }

  resume(reason) {
    this.pauseReasons.delete(reason);
    if (!this.paused) this.input.commands = [];
    this.emit('pause', { paused: this.paused, reasons: [...this.pauseReasons] });
  }

  // --- Connecting --------------------------------------------------------------------------------

  /**
   * Connects to `server` ({ name, url }). `token` is a login token (or
   * 'guest'); `onGuestToken` stores a guest identity the server hands out.
   */
  async connect(server, token, { onGuestToken, onNeedName } = {}) {
    this.server = server;
    this.conn = new Connection(server.url, {
      onJson: (msg) => {
        if (msg.t === 'guest') onGuestToken?.(msg.token);
        else this.#onJson(msg);
      },
      onSnapshot: (buf) => this.#onSnapshot(buf),
      onClose: (info) => {
        this.connected = false;
        this.emit('disconnect', info);
      },
      onNeedName: (msg) => onNeedName?.(msg, (name, password) => this.conn.sendCreate(name, password)),
    });
    const welcome = await this.conn.connect(token);
    this.#onWelcome(welcome);
    return welcome;
  }

  disconnect() {
    this.conn?.close();
  }

  #onWelcome(w) {
    this.connected = true;
    this.myId = w.id;
    this.myName = w.name;
    this.account = w.account ?? { guest: false, password: false };
    this.inputEvery = Math.min(4, Math.max(1, w.inputEvery ?? 1));
    this.outbox = [];
    this.lastButtons = 0;
    this.lastDir = 0;
    this.rules = w.rules;
    this.serverInfo = w.server;
    this.worldSeed = w.seed;
    this.save.worldSeed = w.seed; // (market stock is drawn from the world's seed)
    this.save.worldSeed = w.seed;
    this.world = new World(this.data, w.seed, { hideObjects: true, maxChunks: 220, townBuildings: Object.keys(TOWN_LEVELS), townMarket: townMarket(w.seed) });
    // Inside a clan's claim the ground stays cleared (the server never regrows it there).
    this.world.noRegrow = (tx, ty) => Boolean(claimAt(this.rules, this.claims, tx, ty));
    // Server objects (chests, shrines) join the world's own (town, altars).
    const own = this.world.objectsNear.bind(this.world);
    this.world.objectsNear = (x, y, radius = 1) => {
      const out = own(x, y, radius);
      const ccx = Math.floor(x / CHUNK);
      const ccy = Math.floor(y / CHUNK);
      for (let cy = ccy - radius; cy <= ccy + radius; cy++) {
        for (let cx = ccx - radius; cx <= ccx + radius; cx++) {
          const list = this.serverObjects.get(`${cx},${cy}`);
          if (list) out.push(...list);
        }
      }
      return out;
    };
    for (const k of w.spentAltars ?? []) this.altarsSpent.add(k);
    this.save.world.altars = [...this.altarsSpent];
    this.pred = { x: w.x, y: w.y, kx: 0, ky: 0 };
    this.prev = { x: w.x, y: w.y };
    this.player.x = w.x;
    this.player.y = w.y;
    this.serverTick = w.tick;
    this.renderer.snapCamera?.();
    this.exploredKey = `pg-mp-explored:${w.seed}`;
    for (const k of readStore(this.exploredKey, [])) this.explored.add(k);
    this.save.world.explored = [...this.explored];
    this.save.world.pins = readStore(`pg-mp-pins:${w.seed}`, []);
    this.#bindBuildInput();
    this.input.onUiCommand = (cmd) => this.emit('ui', cmd);
    this.emit('connected', w);
  }

  // --- Server messages ------------------------------------------------------------------------------

  #onJson(msg) {
    switch (msg.t) {
      case 'me': {
        const before = this.me?.level;
        this.#applyMe(msg);
        if (before && msg.level > before) {
          this.audio.play('levelup');
          this.fx.emit('holy', this.player.x, this.player.y, 20, 0.8, 3);
        }
        break;
      }
      case 'inv': {
        const inv = this.save.inventory;
        Object.assign(inv, {
          bag: msg.bag, storage: msg.storage, equipped: msg.equipped, secondary: msg.secondary,
          activeSlot: msg.activeSlot, favorites: msg.favorites ?? [], bagSize: msg.bagSize, storageSize: msg.storageSize,
        });
        inv.unseen = [];
        this.#applySlotLocal();
        this.emit('inventory');
        break;
      }
      case 'inv+': {
        const inv = this.save.inventory;
        (msg.place === 'storage' ? inv.storage : inv.bag).push(msg.dna);
        this.#registerCodex(msg.dna);
        if (msg.crafted) {
          const catalyst = this.data.byId.catalysts.get(msg.catalyst ?? 'none');
          this.discoverWeapon(msg.dna, { caseRoll: { min: catalyst?.minRarity ?? 'common', max: catalyst?.maxRarity ?? 'epic', title: 'Smider…' } });
        } else {
          inv.unseen.push(msg.dna.id);
          const r = this.data.rarityIndex.get(msg.dna.rarity) ?? 0;
          const name = this.data.byId.rarities.get(msg.dna.rarity)?.name ?? '';
          this.toast(`${name}: ${msg.dna.name.text}`, r >= 4 ? 'legendary' : r >= 3 ? 'epic' : r >= 2 ? 'component' : 'info');
          this.audio.play(r >= 2 ? 'discover' : 'pickup', { rarity: r });
          if (r >= 3) this.flash(this.data.byId.rarities.get(msg.dna.rarity)?.color ?? '#ffffff', 0.3);
        }
        this.emit('inventory');
        break;
      }
      case 'inv-': {
        const inv = this.save.inventory;
        inv.bag = inv.bag.filter((w) => w.id !== msg.id);
        inv.storage = inv.storage.filter((w) => w.id !== msg.id);
        inv.favorites = inv.favorites.filter((f) => f !== msg.id);
        inv.unseen = inv.unseen.filter((f) => f !== msg.id);
        this.emit('inventory');
        break;
      }
      case 'inv>': {
        const inv = this.save.inventory;
        const from = msg.place === 'bag' ? inv.storage : inv.bag;
        const idx = from.findIndex((w) => w.id === msg.id);
        if (idx >= 0) (msg.place === 'bag' ? inv.bag : inv.storage).push(...from.splice(idx, 1));
        this.emit('inventory');
        break;
      }
      case 'loadout': {
        const inv = this.save.inventory;
        inv.equipped = msg.equipped;
        inv.secondary = msg.secondary;
        inv.activeSlot = msg.activeSlot;
        if (msg.favorites) inv.favorites = msg.favorites;
        this.#applySlotLocal();
        this.emit('inventory');
        break;
      }
      case 'pinfo':
        this.pinfo.set(msg.id, { ...msg, compiled: msg.weapon ? this.#compile(msg.weapon) : null });
        break;
      case 'dna':
        this.dnaRefs.set(msg.ref, msg.dna);
        break;
      case 'chunk':
        this.#applyChunk(msg);
        break;
      case 'wd':
        this.#applyWorldDelta(msg);
        break;
      case 'claims':
        this.claims = msg.claims;
        for (const chunk of this.world?.chunks.values() ?? []) if (chunk.cut.size) chunk.canvas = null;
        this.emit('claims');
        break;
      case 'clan':
        this.clan = msg.id ? msg : null;
        this.syncBase();
        this.emit('clan', this.clan);
        // The base's buildings decide what the pals and forge panels offer.
        this.emit('pals');
        this.emit('base');
        break;
      case 'invsize':
        Object.assign(this.save.inventory, { bagSize: msg.bagSize, storageSize: msg.storageSize });
        this.emit('inventory');
        break;
      case 'invites':
        this.invites = msg.list;
        this.emit('clan', this.clan);
        break;
      case 'ev':
        for (const ev of msg.list) {
          ev.tick = msg.tick;
          if (ev.id === this.myId || ev.by === this.myId) this.#playEvent(ev);
          else this.eventQueue.push(ev);
        }
        break;
      case 'pin':
        this.addPin(msg.x, msg.y, msg.label);
        this.emit('explored');
        break;
      case 'reveal':
        // A watchtower, an old map or a runestone: land shows on your map.
        this.revealArea(msg.x, msg.y, msg.r);
        break;
      case 'unpin': {
        const i = this.save.world.pins.findIndex((pp) => pp.label === msg.label && Math.hypot(pp.x - msg.x, pp.y - msg.y) < 2);
        if (i >= 0) this.removePin(i);
        break;
      }
      case 'pal-born':
        this.audio.play('levelup');
        this.emit('pals');
        break;
      case 'abcd':
        // Ability cooldowns: all of them when you join, one when you cast.
        if (msg.all) {
          this.abilityReadyAt.clear();
          for (const [id, left] of Object.entries(msg.all)) this.abilityReadyAt.set(id, this.time + left);
        } else {
          this.abilityReadyAt.set(msg.id, this.time + msg.left);
        }
        break;
      case 'toast':
        this.toast(msg.text, msg.kind);
        break;
      case 'chat':
      case 'sys':
        this.chatLog.push(msg);
        if (this.chatLog.length > 80) this.chatLog.shift();
        this.emit('chat', msg);
        break;
      case 'who':
        this.emit('who', msg.list);
        break;
      case 'mates':
        // Clanmates anywhere in the world (once a second): the map and the edge arrows.
        this.mates = msg.list;
        break;
      case 'levelup':
        this.emit('levelup', { level: msg.level });
        break;
      case 'died':
        this.deathInfo = msg;
        break;
      case 'respawn':
      case 'teleport':
        this.#resetPrediction(msg.x, msg.y);
        break;
      case 'ui':
        this.emit('ui', msg.panel === 'storage' ? { name: 'inventory', tab: 'storage' } : msg.panel);
        break;
      default:
        break;
    }
  }

  #resetPrediction(x, y) {
    this.pred = { x, y, kx: 0, ky: 0 };
    this.prev = { x, y };
    this.corr = { x: 0, y: 0 };
    this.pending = [];
    this.renderer.snapCamera?.();
  }

  #compile(dna) {
    let w = this.compiled.get(dna.id);
    if (!w) {
      w = compileWeapon(dna, this.data);
      this.compiled.set(dna.id, w);
      if (this.compiled.size > 200) this.compiled.delete(this.compiled.keys().next().value);
    }
    return w;
  }

  #registerCodex(dna) {
    const codex = this.save.codex;
    codex.weapons[dna.id] = {
      name: dna.name.text, rarity: dna.rarity, archetype: dna.archetype, element: dna.element,
      seed: dna.seed, gen: dna.gen, data: dna.data, ctx: dna.ctx, at: Date.now(),
    };
    for (const e of dna.effects) if (!codex.effects.includes(e.id)) codex.effects.push(e.id);
  }

  // --- World sync -----------------------------------------------------------------------------------

  #attachStructure(raw) {
    const def = structureDef(this.data, raw.id);
    if (!def) return null;
    const old = this.structById.get(raw.sid);
    if (old) this.#detachStructure(old);
    const st = { sid: raw.sid, id: raw.id, x: raw.x, y: raw.y, hp: raw.hp, clanId: raw.clanId || null, lv: raw.lv ?? 0 };
    Object.defineProperty(st, 'def', { value: def, enumerable: false, writable: true });
    Object.defineProperty(st, 'rt', { value: { cd: 0, aim: -Math.PI / 2, flash: 0, trig: -9, open: 0 }, enumerable: false, writable: true });
    const layer = def.kind === 'floor' ? this.world.floors : this.world.structures;
    layer.set(tileKey(st.x, st.y), st);
    this.structById.set(st.sid, st);
    const key = `${Math.floor(st.x / CHUNK)},${Math.floor(st.y / CHUNK)}`;
    if (!this.structByChunk.has(key)) this.structByChunk.set(key, new Set());
    this.structByChunk.get(key).add(st);
    return st;
  }

  #detachStructure(st) {
    const layer = st.def.kind === 'floor' ? this.world.floors : this.world.structures;
    if (layer.get(tileKey(st.x, st.y)) === st) layer.delete(tileKey(st.x, st.y));
    this.structById.delete(st.sid);
    this.structByChunk.get(`${Math.floor(st.x / CHUNK)},${Math.floor(st.y / CHUNK)}`)?.delete(st);
  }

  #applyChunk(msg) {
    const key = `${msg.cx},${msg.cy}`;
    // Trees and rocks: the server's list is the truth for this chunk, with
    // how long ago each was cut (so saplings show how far they have grown).
    const cut = new Set(msg.harvested.map(([x, y]) => `${x},${y}`));
    for (const k of Object.keys(this.world.harvested)) {
      const [x, y] = k.split(',').map(Number);
      if (Math.floor(x / CHUNK) === msg.cx && Math.floor(y / CHUNK) === msg.cy && !cut.has(k)) this.world.restoreBlock(x, y);
    }
    const now = Date.now();
    for (const [x, y, age = 0] of msg.harvested) {
      const entry = this.world.harvested[`${x},${y}`];
      if (entry) entry[0] = now - age * 1000;
      else this.world.removeBlock(x, y, now - age * 1000);
    }
    const chunk = this.world.chunks.get(key);
    if (chunk) chunk.canvas = null;
    for (const st of [...(this.structByChunk.get(key) ?? [])]) this.#detachStructure(st);
    for (const raw of msg.structures) this.#attachStructure(raw);
    this.serverObjects.set(key, msg.objects.map((o) => ({ ...o })));
    const chests = new Set(this.save.world.chests);
    const shrines = new Set(this.save.world.shrines);
    for (const o of msg.objects) {
      if (o.type !== 'chest' && o.type !== 'shrine') continue; // (points of interest: what you found is in `me`)
      const set = o.type === 'chest' ? chests : shrines;
      if (o.used) set.add(o.key);
      else set.delete(o.key);
    }
    this.save.world.chests = [...chests];
    this.save.world.shrines = [...shrines];
    for (const a of msg.altars) if (a.spent) this.altarsSpent.add(a.key);
    this.emit('structures');
  }

  #applyWorldDelta(msg) {
    switch (msg.k) {
      case 'cut':
        if (this.world.blockAt(msg.x, msg.y)) this.world.removeBlock(msg.x, msg.y);
        this.harvestDamage.delete(`${msg.x},${msg.y}`);
        break;
      case 'grow':
        this.world.restoreBlock(msg.x, msg.y);
        break;
      case 'st+':
        this.#attachStructure(msg.st);
        if (this.time > 1) this.audio.play('build', { throttle: 60 });
        this.emit('structures');
        break;
      case 'st-': {
        const st = this.structById.get(msg.sid);
        if (st) {
          this.#detachStructure(st);
          this.fx.emit(stony(st.id) ? 'stone' : 'wood', st.x + 0.5, st.y + 0.5, 12, 0.8, 2.5);
          this.fx.emit('smoke', st.x + 0.5, st.y + 0.5, 6, 0.6, 1);
          if (msg.broken) this.audio.play('break');
        }
        this.emit('structures');
        break;
      }
      case 'sthp': {
        const st = this.structById.get(msg.sid);
        if (st) {
          if (msg.hp < st.hp) {
            st.rt.flash = 0.12;
            this.fx.emit(stony(st.id) ? 'stone' : 'wood', st.x + 0.5, st.y + 0.4, 2, 0.4, 1.5);
          }
          st.hp = msg.hp;
        }
        break;
      }
      case 'used': {
        const key = msg.key;
        for (const list of this.serverObjects.values()) {
          const o = list.find((x) => x.key === key);
          if (o) {
            o.used = msg.used;
            const which = o.type === 'chest' ? 'chests' : 'shrines';
            if (msg.used && !this.save.world[which].includes(key)) this.save.world[which].push(key);
          }
        }
        break;
      }
      case 'altar':
        this.altarsSpent.add(msg.key);
        this.save.world.altars = [...this.altarsSpent];
        this.altarStamp = null;
        break;
      default:
        break;
    }
  }

  // --- Snapshots ---------------------------------------------------------------------------------

  #onSnapshot(buf) {
    const now = performance.now();
    let snap;
    try {
      snap = decodeSnapshot(buf, this.known);
    } catch (err) {
      console.warn('[mp] bad snapshot', err);
      return;
    }
    this.netStats.snapshots++;
    this.serverTick = snap.tick;
    // Clock: the earliest arrivals tell us the server's time best.
    this.offsets.push(now - snap.tick * TICK_MS);
    if (this.offsets.length > 90) this.offsets.shift();
    for (const id of snap.removed) this.store.remove(id);
    for (const id of snap.updated) {
      const k = this.known.get(id);
      if (k) this.store.push(id, k.type, k.values, snap.tick);
    }
    this.#reconcile(snap);
  }

  /** The server's word on where you are; replay inputs it hasn't seen yet. */
  #reconcile(snap) {
    const s = snap.self;
    const wasDead = this.player.dead;
    const wasSailing = this.sailing;
    const wasRiding = Boolean(this.selfFlags & SF.RIDING);
    this.selfFlags = s.flags;
    if (this.sailing !== wasSailing) this.#sailingChanged();
    if (Boolean(s.flags & SF.RIDING) !== wasRiding) {
      this.interactTarget = null;
      this.interactT = 0;
      this.emit('riding', { on: !wasRiding });
    }
    this.speed = s.speed;
    this.sprintMult = s.sprint;
    const p = this.player;
    if (s.hp < p.hp && !wasDead) p.hurtFlash = Math.max(p.hurtFlash, 0.12);
    p.hp = s.hp;
    p.maxHp = s.maxHp;
    this.pstats.maxHp = s.maxHp;
    p.dead = Boolean(s.flags & SF.DEAD);
    if (p.dead && !wasDead) {
      this.pending = [];
      this.emit('death', this.deathInfo ?? {});
      this.audio.play('hurt');
    }
    if (!p.dead && wasDead) {
      this.#resetPrediction(s.x, s.y);
      this.emit('respawn', {});
    }
    this.pending = this.pending.filter((f) => f.seq > snap.ack);
    const before = { x: this.pred.x, y: this.pred.y };
    const pred = { x: s.x, y: s.y, kx: s.kx, ky: s.ky };
    if (!p.dead) {
      this.#withGates(() => {
        for (const f of this.pending) stepMove(this.world, pred, f, this.speed, this.sprintMult, PLAYER_RADIUS, this.moveMode);
      });
    }
    const dx = before.x - pred.x;
    const dy = before.y - pred.y;
    const err = Math.sqrt(dx * dx + dy * dy);
    this.netStats.lastError = err;
    if (err > 1e-6) {
      this.netStats.corrections++;
      if (err > SNAP_DIST) {
        this.netStats.bigCorrections++;
        this.corr.x = 0;
        this.corr.y = 0;
        this.prev = { x: pred.x, y: pred.y };
        // A Blink: you are there at once, and the camera glides after you.
        if (!(s.flags & SF.BLINK)) this.renderer.snapCamera?.();
      } else {
        // Keep what's on screen where it is and glide the difference away.
        this.corr.x += dx;
        this.corr.y += dy;
        this.prev.x -= dx;
        this.prev.y -= dy;
      }
    }
    this.pred = pred;
  }

  #withGates(fn) {
    const clanId = this.me?.clan?.id ?? null;
    this.world.gateFilter = (st) => Boolean(st.clanId) && st.clanId === clanId;
    try {
      fn();
    } finally {
      this.world.gateFilter = null;
    }
  }

  /** Estimated server tick now (smoothed), and how far back we draw others. */
  #clock(dtMs) {
    if (!this.offsets.length) return this.serverTick;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    const min = sorted[0];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    if (this.offsetSmooth === null) this.offsetSmooth = min;
    // Glide towards the new estimate (never jump: that would make everyone hop).
    const step = Math.max(0.5, dtMs * 0.05);
    this.offsetSmooth += Math.max(-step, Math.min(step, min - this.offsetSmooth));
    const jitterTicks = (p90 - min) / TICK_MS;
    const want = Math.min(8, Math.max(2, jitterTicks + 1.5));
    this.interpDelay += (want - this.interpDelay) * Math.min(1, dtMs / 1000);
    return (performance.now() - this.offsetSmooth) / TICK_MS;
  }

  // --- Input / prediction (30 Hz) -------------------------------------------------------------------

  #clientTick() {
    if (!this.connected || !this.world) return;
    const p = this.player;
    for (const t of [p]) {
      t.attackCd = Math.max(0, t.attackCd - TICK_DT);
      t.toolCd = Math.max(0, t.toolCd - TICK_DT);
    }
    const sample = this.paused
      ? { moveX: 0, moveY: 0, attack: false, sprint: false, commands: [] }
      : this.input.sample();
    let buttons = 0;
    let cmd = this.pendingCmd;
    this.pendingCmd = 0;
    for (const c of sample.commands) {
      if (this.build.active && (c === 'interact' || c === 'interact-or-attack')) {
        this.buildAtGhost();
        continue;
      }
      if (c === 'interact' || c === 'interact-or-attack') {
        // At sea, attacking a monster in reach never takes you ashore (Use still does).
        const t = this.target;
        if (this.sailing && (sample.attack || c === 'interact-or-attack') && t && !t.dead) {
          if (c === 'interact-or-attack') buttons |= BTN.ATTACK;
          continue;
        }
        buttons |= BTN.INTERACT;
        const o = this.interactTarget;
        if (o && o.type !== 'harvest') this.suppressAttack = true;
        if (c === 'interact-or-attack' && !o) buttons |= BTN.ATTACK;
      } else if (c === 'ability') {
        // The server decides; this only skips presses that can't work.
        if (!this.toolActive && !this.handsEmpty && !p.dead && abilityReadyIn(this) === 0) {
          buttons |= BTN.ABILITY;
          const ab = this.weapon.ability ?? this.weapon.dna.ability;
          this.abilityReadyAt.set(this.weapon.dna.id, this.time + ab.cooldown);
        }
      } else if (c === 'slot1' || c === 'slot2' || c === 'slot3') {
        if (!this.build.active) cmd = { slot1: CMD.SLOT_MAIN, slot2: CMD.SLOT_SECONDARY, slot3: CMD.SLOT_TOOL }[c];
      } else if (c === 'slotNext' || c === 'slotPrev') {
        if (!this.build.active) cmd = c === 'slotNext' ? CMD.SLOT_NEXT : CMD.SLOT_PREV;
      } else {
        this.emit('ui', c);
      }
    }
    if (!sample.attack) this.suppressAttack = false;
    if (sample.attack && !this.build.active) buttons |= BTN.ATTACK;
    if (sample.sprint) buttons |= BTN.SPRINT;
    const mx = p.dead ? 0 : quantizeAxis(sample.moveX);
    const my = p.dead ? 0 : quantizeAxis(sample.moveY);
    this.target = this.handsEmpty || p.dead ? null : this.#acquireTarget();
    const aim = this.#aim(mx, my);
    const frame = {
      seq: ++this.seq, mx, my, buttons, cmd, aim: angleToByte(aim), target: this.target?.id ?? 0, view: Math.max(0, Math.floor(this.renderTick)),
    };
    // Frames go out in small batches when the server asks for it (each
    // message costs on Cloudflare); a press or release, starting or stopping
    // and turning go out at once, so the server never lags behind those.
    this.outbox.push(frame);
    const dir = Math.sign(mx) * 3 + Math.sign(my);
    const edge = frame.buttons !== this.lastButtons || frame.cmd !== 0 || dir !== this.lastDir;
    this.lastButtons = frame.buttons;
    this.lastDir = dir;
    if (edge || this.outbox.length >= this.inputEvery) {
      this.conn.sendBinary(encodeInput(this.outbox));
      this.outbox = [];
    }
    if (p.dead) return;
    this.pending.push(frame);
    if (this.pending.length > 120) this.pending.shift();
    this.prev = { x: this.pred.x, y: this.pred.y };
    this.#withGates(() => stepMove(this.world, this.pred, frame, this.speed, this.sprintMult, PLAYER_RADIUS, this.moveMode));
    p.moving = mx !== 0 || my !== 0;
    p.sprinting = p.moving && (buttons & BTN.SPRINT) !== 0;
    // Foam in the wake; dust under hooves.
    if (this.sailing && p.moving && Math.random() < 0.6) {
      this.fx.emit('glint', p.x - Math.cos(p.facing) * 0.8, p.y + 0.25, 1, 0.3, 0.6, ['#e8f8ff', '#9ad8f4']);
    } else if (this.riding && p.moving && Math.random() < 0.3) {
      this.fx.emit('dust', p.x, p.y + 0.3, 1, 0.2, 0.5);
    }
    if (!p.attackAnim) p.facing = aim;
    if ((buttons & BTN.ATTACK) && !this.suppressAttack) this.#predictAttack(aim);
  }

  /** Auto-aim, like single player: the nearest monster or hostile player in reach. */
  #acquireTarget() {
    const p = this.player;
    const reach = Math.max(4.5, (this.weapon?.stats.range ?? 3) + 3.5);
    let best = null;
    let bestScore = Infinity;
    const now = Date.now();
    const consider = (e, bonus = 0) => {
      const d = Math.sqrt(dist2(p.x, p.y, e.x, e.y)) - (e.r ?? 0.4);
      if (d > reach) return;
      const score = d - (e === this.target ? 1.2 : 0) - bonus;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    };
    for (const e of this.enemies) if (!e.dead && !e.submerged) consider(e, e.boss ? 0.8 : 0);
    const me = { x: p.x, y: p.y, clanId: this.me?.clan?.id ?? null, dead: p.dead, newbie: false, protectUntil: 0 };
    for (const o of this.others) {
      if (o.dead) continue;
      const them = { x: o.x, y: o.y, clanId: o.clanId, dead: o.dead, newbie: o.protected, protectUntil: 0, asleep: o.asleep };
      if (pvpBlock(this.rules, me, them, now) === null) consider(o);
    }
    return best;
  }

  #aim(mx, my) {
    const p = this.player;
    const h = this.interactTarget;
    if (this.toolActive && h?.type === 'harvest') return Math.atan2(h.y - p.y, h.x - p.x);
    const t = this.target;
    if (t && !t.dead) return Math.atan2(t.y - p.y, t.x - p.x);
    if (mx || my) return Math.atan2(my, mx);
    return p.facing;
  }

  /** Shows your attack right away (the server decides what it hits). */
  #predictAttack(aim) {
    const p = this.player;
    if (this.toolActive) {
      if (p.toolCd > 0) return;
      const tool = currentPickaxe(this.data, this.save);
      const h = this.interactTarget?.type === 'harvest' ? this.interactTarget : null;
      p.toolAnim = { t: 0, dur: 0.32, angle: aim };
      p.toolCd = h ? (h.info.tier > (tool?.tier ?? 0) ? 0.6 : tool?.swing ?? 0.36) : 0.45;
      this.audio.play('swish', { throttle: 80 });
      return;
    }
    const w = this.heldWeapon;
    if (!w || p.attackCd > 0) return;
    const aspd = w.stats.attackSpeed * (this.pstats.attackSpeedMult ?? 1);
    const pattern = w.attack.pattern;
    p.attackCd = 1 / aspd;
    p.facing = aim;
    const dir = p.guard;
    if (pattern === 'swing' || pattern === 'lash' || pattern === 'slam') p.guard = -dir;
    const dur = attackDuration(pattern, aspd);
    p.attackAnim = { t: 0, dur, angle: aim, pattern, dir };
    const delay = MELEE_PATTERNS.has(pattern) ? impactDelay(pattern, dur) : 0;
    this.schedule(delay, () => {
      if (p.dead) return;
      this.#attackVisual(w, p.x, p.y, aim, dir, true);
      this.audio.weapon(w.dna.sound);
    });
  }

  /** The look of an attack (slashes, thrusts, slams, shots). */
  #attackVisual(w, x, y, angle, dir, mine) {
    const a = w.attack;
    const range = w.stats.range;
    const color = w.trail;
    const blade = w.dna.visual.palette.blade;
    switch (a.pattern) {
      case 'swing':
        this.fx.add({ type: 'slash', x, y, angle, dir, arc: (a.arc ?? 120) * DEG, r: range, color, core: blade[0], dur: 0.2 });
        break;
      case 'lash':
        this.fx.add({ type: 'whip', x, y, angle, dir, r: range, color: blade[1], tip: color, dur: 0.22 });
        break;
      case 'thrust':
        this.fx.add({ type: 'thrust', x, y, angle, r: range, color, core: blade[0], dur: 0.16 });
        break;
      case 'slam': {
        const radius = a.radius ?? 1.6;
        const cx = x + Math.cos(angle) * range * 0.6;
        const cy = y + Math.sin(angle) * range * 0.6;
        this.fx.add({ type: 'ring', x: cx, y: cy, r0: 0.3, r1: radius, color, dur: 0.3, fill: true });
        this.fx.add({ type: 'cracks', x: cx, y: cy, r: radius, color: '#161622', dur: 0.6, seed: Math.random() * 1000 });
        this.fx.emit('dust', cx, cy, 14, radius, 2.5);
        if (mine) this.shake = Math.max(this.shake, 0.2);
        break;
      }
      default:
        if (mine) this.#localShots(w, x, y, angle);
    }
  }

  /** Your own shots fly right away on your screen (the server's copies stay hidden). */
  #localShots(w, x, y, angle) {
    const s = w.stats;
    const a = w.attack;
    const count = Math.max(1, Math.min(7, s.projectiles));
    const spreadDeg = count > 1 ? Math.max(a.spread ?? 0, 8 * (count - 1)) : a.spread ?? 0;
    for (let i = 0; i < count; i++) {
      let off = 0;
      if (count > 1) off = (i / (count - 1) - 0.5) * spreadDeg * DEG;
      else if (spreadDeg) off = (Math.random() - 0.5) * spreadDeg * DEG;
      const speed = s.projectileSpeed || 10;
      this.localShots.push({
        x, y, vx: Math.cos(angle + off) * speed, vy: Math.sin(angle + off) * speed, speed, range: a.pattern === 'lob' ? s.range * 0.8 : s.range,
        traveled: 0, sprite: a.projectile, size: a.size ?? 2, color: w.trail, owner: 'player', kind: a.pattern === 'boomerang' ? 'boomerang' : 'shot',
        returning: false, spin: 0, pierce: s.pierce ?? 0, hits: 0,
      });
    }
  }

  #updateLocalShots(dt) {
    const p = this.player;
    this.localShots = this.localShots.filter((pr) => {
      if (pr.kind === 'boomerang' && pr.returning) {
        const d = Math.sqrt((p.x - pr.x) ** 2 + (p.y - pr.y) ** 2);
        if (d < 0.5) return false;
        pr.vx = ((p.x - pr.x) / d) * pr.speed;
        pr.vy = ((p.y - pr.y) / d) * pr.speed;
      }
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.spin += dt * 18;
      pr.traveled += pr.speed * dt;
      if (pr.traveled >= pr.range) {
        if (pr.kind === 'boomerang' && !pr.returning) {
          pr.returning = true;
          return true;
        }
        return false;
      }
      if (pr.kind === 'boomerang') return true;
      const tx = Math.floor(pr.x);
      const ty = Math.floor(pr.y);
      const b = this.world.blockAt(tx, ty);
      const st = this.world.structureAt(tx, ty);
      if ((b && b !== 20 && b !== 21 && b !== 27 && b !== 28) || (st && !st.def.walkable)) return false;
      for (const e of this.enemies) {
        if ((e.x - pr.x) ** 2 + (e.y - pr.y) ** 2 < (e.r + 0.25) ** 2) {
          pr.hits++;
          if (pr.hits > pr.pierce) return false;
        }
      }
      return true;
    });
  }

  // --- Per frame -------------------------------------------------------------------------------------

  #frameUpdate(dt, now) {
    this.time += dt;
    this.frame += 1;
    this.#runTimers();
    this.fx.update(dt);
    this.shake = Math.max(0, this.shake - dt);
    if (this.screenFlash) {
      this.screenFlash.t -= dt;
      if (this.screenFlash.t <= 0) this.screenFlash = null;
    }
    if (!this.world) return;
    const p = this.player;
    // Your character: between the last two predicted steps, plus the
    // remaining (shrinking) correction.
    const alpha = Math.min(1, this.acc / TICK_MS);
    const k = Math.exp(-dt * 14);
    this.corr.x *= k;
    this.corr.y *= k;
    const nx = this.prev.x + (this.pred.x - this.prev.x) * alpha + this.corr.x;
    const ny = this.prev.y + (this.pred.y - this.prev.y) * alpha + this.corr.y;
    p.vx = dt > 0 ? (nx - p.x) / dt : 0;
    p.vy = dt > 0 ? (ny - p.y) / dt : 0;
    p.x = nx;
    p.y = ny;
    if (p.moving) p.walkT += dt * (p.sprinting ? 14 : 9);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt);
    p.invuln = this.selfFlags & SF.PROTECTED ? 1 : 0;
    for (const key of ['attackAnim', 'toolAnim']) {
      const anim = p[key];
      if (anim) {
        anim.t += dt;
        if (anim.t >= anim.dur) p[key] = null;
      }
    }
    this.renderTick = this.#clock(dt * 1000) - this.interpDelay;
    this.#updateEntities(dt);
    this.#updateLocalShots(dt);
    this.#drainEvents();
    this.#updateGates(dt);
    this.markets.update(dt);
    for (const st of this.structById.values()) if (st.rt.flash > 0) st.rt.flash -= dt;
    // Interaction hints and build preview.
    this.interactT = (this.interactT ?? 0) - dt;
    if (this.interactT <= 0) {
      this.interactT = 0.1;
      const target = this.#findInteractable();
      const same = target && this.interactTarget && target.type === this.interactTarget.type
        && target.key === this.interactTarget.key && target.tx === this.interactTarget.tx && target.ty === this.interactTarget.ty;
      if (!same && target !== this.interactTarget) {
        this.interactTarget = target;
        this.emit('interact', { label: target?.type === 'harvest' ? null : this.interactLabel(target) });
      }
    }
    if (this.build.active) this.#updateBuildGhost();
    this.exploreT = (this.exploreT ?? 0) - dt;
    if (this.exploreT <= 0) {
      this.exploreT = 0.5;
      this.#explore();
    }
    if (this.frame % 120 === 0) this.world.prune(this.frame);
    if (this.frame % 300 === 0) this.world.refreshGrowth();
    this.hudT = (this.hudT ?? 0) - dt;
    if (this.hudT <= 0) {
      this.hudT = 0.1;
      this.emit('hud', this.hudState());
    }
    this.netStats.bytesPerSec = this.netStats.bytesPerSec * 0.98 + ((this.conn?.bytesIn ?? 0) - (this.lastBytesIn ?? 0)) / Math.max(0.001, dt) * 0.02;
    this.lastBytesIn = this.conn?.bytesIn ?? 0;
    void now;
  }

  #runTimers() {
    if (!this.timers.length) return;
    const due = [];
    this.timers = this.timers.filter((t) => (t.at <= this.time ? (due.push(t), false) : true));
    for (const t of due) {
      try {
        t.fn();
      } catch (err) {
        console.error('[mp] timer failed', err);
      }
    }
  }

  #updateEntities(dt) {
    const rt = this.renderTick;
    const enemies = [];
    const others = [];
    const projectiles = [];
    const pickups = [];
    const areas = [];
    const allies = [];
    const otherPals = [];
    const horses = [];
    const npcs = [];
    const workers = [];
    let myPal = null;
    let boss = null;
    const myClan = this.me?.clan?.id ?? null;
    for (const ent of this.store.ents.values()) {
      if (ent.born > rt + 1 && ent.type !== ET.PROJ) {
        // Not on screen yet (it is drawn in the past) — unless we have nothing older.
        if (ent.samples[0].tick > rt + 2) continue;
      }
      const s = EntityStore.sample(ent, rt);
      switch (ent.type) {
        case ET.ENEMY: {
          if (!ent.obj) {
            ent.obj = makeEnemy(this.data, s.v, this.time);
            ent.obj.id = ent.id;
            ent.obj.x = s.x;
            ent.obj.y = s.y;
          }
          updateEnemy(ent.obj, s.v, s.x, s.y, dt, this.time);
          this.#keepOffMe(ent.obj);
          enemies.push(ent.obj);
          if (ent.obj.boss && !ent.obj.clone && (!boss || dist2(boss.x, boss.y, this.player.x, this.player.y) > dist2(ent.obj.x, ent.obj.y, this.player.x, this.player.y))) boss = ent.obj;
          break;
        }
        case ET.PLAYER: {
          const info = readPlayer(s.v);
          let o = ent.obj;
          const pi = this.pinfo.get(ent.id);
          if (!o) {
            o = { id: ent.id, remote: true, x: s.x, y: s.y, r: PLAYER_RADIUS, walkT: 0, guard: 1, attackAnim: null, toolAnim: null, anim: info.anim, hurtFlash: 0 };
            ent.obj = o;
          }
          o.x = s.x;
          o.y = s.y;
          Object.assign(o, info, { anim: o.anim });
          if (info.hurt) o.hurtFlash = 0.12;
          o.hurtFlash = Math.max(0, o.hurtFlash - dt);
          if (o.moving) o.walkT += dt * (o.sprinting ? 14 : 9);
          o.name = pi?.name ?? '…';
          o.tag = pi?.tag ?? null;
          o.clanId = pi?.clanId ?? null;
          o.weapon = info.slot === 'main' || info.slot === 'secondary' ? pi?.compiled ?? null : null;
          o.pickaxeDef = pickaxeDefs(this.data).find((d) => d.tier === info.pickaxe) ?? null;
          o.boatDef = info.boat ? boatDefs(this.data).find((b) => b.tier === info.boat) ?? null : null;
          o.horse = o.boatDef ? null : info.horse;
          o.friendly = Boolean(myClan && o.clanId === myClan);
          o.cloak = o.friendly ? '#3fa86a' : '#c8364a';
          o.nameColor = o.friendly ? '#8ef0a0' : o.protected ? '#c8c8d8' : '#ffb0a0';
          o.invuln = 0;
          if (info.anim !== o.anim) {
            o.anim = info.anim;
            this.#remoteAttack(o);
          }
          for (const key of ['attackAnim', 'toolAnim']) {
            const anim = o[key];
            if (anim) {
              anim.t += dt;
              if (anim.t >= anim.dur) o[key] = null;
            }
          }
          others.push(o);
          break;
        }
        case ET.PROJ: {
          const pr = readProjectile(ent.samples[ent.samples.length - 1].v, rt);
          if (pr.ownerId === this.myId || pr.t < 0) break;
          projectiles.push(pr);
          break;
        }
        case ET.PICKUP: {
          const info = readPickup(s.v);
          let o = ent.obj;
          if (!o) {
            o = { id: ent.id, t: 0, z: 0, x: s.x, y: s.y };
            ent.obj = o;
          }
          Object.assign(o, info, { x: s.x, y: s.y });
          o.t += dt;
          if (o.kind === 'weapon') {
            o.dna = this.dnaRefs.get(o.ref);
            if (!o.dna) break;
          }
          pickups.push(o);
          break;
        }
        case ET.AREA: {
          const a = readArea(s.v, rt, s.x, s.y);
          if (a.follow && a.owner) {
            // Blade rings and blizzards stay on their caster as drawn here.
            const o = a.owner === this.myId ? this.player : this.store.ents.get(a.owner)?.obj;
            if (o) {
              a.x = o.x;
              a.y = o.y;
            }
          }
          if (a.t >= 0 && a.t <= a.dur) areas.push(a);
          break;
        }
        case ET.WORKER: {
          const info = readWorker(s.v);
          let o = ent.obj;
          if (!o || o.clanId !== info.clan || o.id !== info.wid) {
            o = { eid: ent.id, clanId: info.clan, id: info.wid, r: 0.3, walkT: 0, hurtFlash: 0, ...workerLook(info.clan, info.wid) };
            ent.obj = o;
          }
          Object.assign(o, { x: s.x, y: s.y, facing: info.facing, moving: info.moving, angry: info.angry, idle: info.idle });
          Object.assign(o, { carrying: info.carrying, role: info.role, hp: info.hp, maxHp: info.maxHp, anim: info.anim });
          if (o.moving) o.walkT += dt * 8;
          if (info.hurt) o.hurtFlash = 0.15;
          o.hurtFlash = Math.max(0, o.hurtFlash - dt);
          workers.push(o);
          break;
        }
        case ET.NPC: {
          const info = readNpc(s.v);
          info.x = s.x;
          info.y = s.y;
          ent.obj = this.markets.person(ent.obj, info, dt, this.time);
          if (ent.obj) npcs.push(ent.obj);
          break;
        }
        case ET.PAL: {
          const info = readPal(s.v, this.data);
          let o = ent.obj;
          if (!o || o.species !== info.species) {
            o = {
              eid: ent.id, species: info.species, x: s.x, y: s.y, vx: 0, vy: 0, r: 0.3, facing: info.facing, phase: Math.random() * 10,
              attackT: -9, workT: -9, flash: 0, anim: info.anim, work: info.work, hp: info.hp, stats: null, state: info.state,
            };
            ent.obj = o;
          }
          if (dt > 0) {
            o.vx = (s.x - o.x) / dt;
            o.vy = (s.y - o.y) / dt;
          }
          o.x = s.x;
          o.y = s.y;
          o.facing = info.facing;
          if (info.hp < o.hp) o.flash = 0.12;
          o.flash = Math.max(0, o.flash - dt);
          o.hp = info.hp;
          o.level = info.level;
          o.state = info.state;
          o.downUntil = this.time + info.down;
          o.stats = { ...palStats(this.data, info.species, info.level), maxHp: info.maxHp };
          if (info.anim !== o.anim) {
            o.anim = info.anim;
            o.attackT = this.time;
            this.fx.emit(palSpecies(this.data, info.species)?.element === 'fire' ? 'ember' : 'hit', o.x + o.facing * 0.6, o.y, 4, 0.3, 2);
          }
          if (info.work !== o.work) {
            o.work = info.work;
            o.workT = this.time;
          }
          if (info.owner === this.myId) {
            o.id = this.save.pals.active;
            myPal = o;
          } else {
            otherPals.push(o);
          }
          break;
        }
        case ET.HORSE: {
          const info = readHorse(s.v);
          let o = ent.obj;
          if (!o) {
            o = { key: `h:${ent.id}`, eid: ent.id, walkT: 0 };
            ent.obj = o;
          }
          Object.assign(o, info, { x: s.x, y: s.y });
          o.own = info.owner === this.myId;
          o.record = o.own ? this.save.horses?.owned.find((r) => r.id === info.ref) ?? null : null;
          if (o.moving) o.walkT += dt * 5;
          horses.push(o);
          break;
        }
        case ET.ALLY: {
          const info = readAlly(s.v);
          let o = ent.obj;
          if (!o) {
            o = { id: ent.id, kind: 'clone', remote: true, r: PLAYER_RADIUS, attackT: -1, anim: info.anim, walkT: 0, guard: 1 };
            ent.obj = o;
          }
          o.x = s.x;
          o.y = s.y;
          o.facing = info.facing;
          o.moving = info.moving;
          if (o.moving) o.walkT += dt * 9;
          o.weapon = info.owner === this.myId ? this.weapon : this.pinfo.get(info.owner)?.compiled ?? null;
          if (info.anim !== o.anim) {
            o.anim = info.anim;
            o.attackT = this.time;
            const reach = Math.min(o.weapon?.stats.range ?? 2, 3);
            this.fx.add({ type: 'slash', x: o.x, y: o.y, angle: o.facing, arc: 2, r: reach, color: '#cdb2ff', dur: 0.14, ghost: true });
          }
          allies.push(o);
          break;
        }
        default:
          break;
      }
    }
    this.enemies = enemies;
    this.others = others;
    this.projectiles = projectiles.concat(this.localShots);
    this.pickups = pickups;
    this.areas = areas;
    this.allies = allies;
    this.pal = myPal;
    this.otherPals = otherPals;
    this.horses = horses;
    this.workers = workers;
    this.markets.npcs = npcs;
    if (boss !== this.boss) {
      this.boss = boss;
      this.emit('boss', boss ? { active: true, name: boss.bossDef.name } : { active: false });
    }
    if (this.target && !enemies.includes(this.target) && !others.includes(this.target)) this.target = null;
  }

  /**
   * Monsters are drawn a little in the past and you a little ahead, so one
   * the server keeps at arm's length could look like it stands in you: it
   * is drawn at the edge instead (as the server has it).
   */
  #keepOffMe(e) {
    const p = this.player;
    if (p.dead || e.submerged) return;
    const rr = e.r + p.r;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 < 1e-6) return;
    const d = Math.sqrt(d2);
    e.x = p.x + (dx / d) * rr;
    e.y = p.y + (dy / d) * rr;
  }

  #remoteAttack(o) {
    if (o.slot === 'tool') {
      o.toolAnim = { t: 0, dur: 0.32, angle: o.facing };
      return;
    }
    const w = o.weapon;
    if (!w) return;
    const aspd = w.stats.attackSpeed;
    const pattern = w.attack.pattern;
    const dur = attackDuration(pattern, aspd);
    const dir = o.guard;
    if (pattern === 'swing' || pattern === 'lash' || pattern === 'slam') o.guard = -dir;
    o.attackAnim = { t: 0, dur, angle: o.facing, pattern, dir };
    if (MELEE_PATTERNS.has(pattern)) {
      this.schedule(impactDelay(pattern, dur), () => {
        this.#attackVisual(w, o.x, o.y, o.facing, dir, false);
        if (dist2(o.x, o.y, this.player.x, this.player.y) < 14 * 14) this.audio.weapon(w.dna.sound);
      });
    }
  }

  #updateGates(dt) {
    const myClan = this.me?.clan?.id ?? null;
    for (const st of this.structById.values()) {
      if (st.def.kind !== 'gate') continue;
      let near = false;
      const check = (x, y, clanId) => {
        if (clanId && clanId === st.clanId && (x - st.x - 0.5) ** 2 + (y - st.y - 0.5) ** 2 < 1.6 * 1.6) near = true;
      };
      if (!this.player.dead) check(this.player.x, this.player.y, myClan);
      for (const o of this.others) check(o.x, o.y, o.clanId);
      st.rt.open = Math.max(0, Math.min(1, st.rt.open + (near ? dt : -dt) * 6));
    }
  }

  // --- Events ------------------------------------------------------------------------------------------

  #drainEvents() {
    if (!this.eventQueue.length) return;
    const rt = this.renderTick;
    const keep = [];
    for (const ev of this.eventQueue) {
      if (ev.tick <= rt + 0.5 || ev.tick < this.serverTick - 30) this.#playEvent(ev);
      else keep.push(ev);
    }
    this.eventQueue = keep;
  }

  #entityPos(id) {
    if (id === this.myId) return this.player;
    const ent = this.store.ents.get(id);
    return ent?.obj ?? null;
  }

  #playEvent(ev) {
    const mine = ev.by === this.myId;
    switch (ev.k) {
      case 'dmg': {
        const e = this.#entityPos(ev.id);
        if (!e) break;
        this.fx.number(e.x, e.y - (e.r ?? 0.4) - 0.3, ev.n, { crit: ev.c, color: ev.col ?? '#ffffff' });
        this.fx.emit('hit', e.x, e.y, ev.c ? 6 : 3, 0.3, 3);
        if (mine) {
          this.audio.play(ev.c ? 'crit' : 'hit');
          if (ev.c) this.shake = Math.max(this.shake, 0.15);
        }
        break;
      }
      case 'hurt': {
        if (ev.id === this.myId) {
          const p = this.player;
          p.hurtFlash = 0.15;
          if (!ev.dot) {
            this.shake = Math.max(this.shake, 0.25);
            this.audio.play('hurt', { throttle: 120 });
            this.vibrate(30);
          }
          this.fx.number(p.x, p.y - 1.2, ev.n, { color: '#ff5a5a' });
        } else {
          const o = this.#entityPos(ev.id);
          if (o) {
            this.fx.number(o.x, o.y - 1.2, ev.n, { color: mine ? '#ffffff' : '#ff9a7a' });
            if (mine) this.audio.play('hit');
          }
        }
        break;
      }
      case 'heal': {
        const o = this.#entityPos(ev.id);
        if (o) this.fx.number(o.x, o.y - 1.2, ev.n, { heal: true });
        break;
      }
      case 'kill':
        this.fx.emit('smoke', ev.x, ev.y, ev.boss ? 30 : 6, (ev.r ?? 0.4) * 2, 2);
        this.fx.emit('hit', ev.x, ev.y, 4, ev.r ?? 0.4, 3);
        if (dist2(ev.x, ev.y, this.player.x, this.player.y) < 15 * 15) this.audio.play('kill', { throttle: 60 });
        break;
      case 'pdeath':
        this.fx.emit('smoke', ev.x, ev.y, 16, 0.8, 2);
        break;
      case 'chop': {
        const info = this.interactTarget?.type === 'harvest' ? this.interactTarget.info : null;
        const key = `${Math.floor(ev.x)},${Math.floor(ev.y)}`;
        const hp = info?.hp ?? 5;
        this.harvestDamage.set(key, { dmg: ev.frac * hp, at: this.time });
        this.fx.emit(ev.wood ? 'wood' : 'stone', ev.x, ev.y - 0.2, 5, 0.5, 2);
        this.audio.play(ev.wood ? 'chop' : 'mine', { throttle: 50 });
        break;
      }
      case 'fell':
        if (ev.text) this.fx.text(ev.x, ev.y - 1, ev.text.toUpperCase(), '#ffe890', 1.2);
        this.fx.emit(ev.wood ? 'leaf' : 'stone', ev.x, ev.y - 0.3, 14, 0.9, 2.5);
        this.audio.play('fell');
        break;
      case 'mturret':
        this.markets.turretFired(ev);
        break;
      case 'npchurt': {
        const o = this.store.ents.get(ev.id)?.obj;
        if (o) {
          this.fx.number(o.x, o.y - 0.6, ev.n, { color: '#ff8a8a' });
          this.fx.emit('blood', o.x, o.y - 0.3, 4, 0.3, 2);
        }
        break;
      }
      case 'palhurt': {
        const o = this.store.ents.get(ev.id)?.obj;
        if (o) this.fx.number(o.x, o.y - 0.8, ev.n, { color: '#ffb0b0' });
        break;
      }
      case 'pick':
        if (ev.kind === 'component' && ev.id === this.myId) {
          this.audio.play('discover');
          break;
        }
        if (ev.kind === 'egg' && ev.id === this.myId) {
          this.audio.play('discover', { rarity: 3 });
          this.flash('#9cf07a', 0.3);
          break;
        }
        if (ev.id === this.myId) this.audio.play(SOUND_KINDS[ev.kind] ?? 'pickup', { throttle: 60 });
        break;
      case 'turret': {
        const st = this.structById.get(ev.sid);
        if (st) {
          st.rt.aim = ev.aim;
          st.rt.flash = 0.06;
        }
        break;
      }
      case 'trap': {
        const st = this.structById.get(ev.sid);
        if (st) st.rt.trig = this.time;
        break;
      }
      case 'boss':
        if (ev.active && !ev.enraged) this.audio.play('boss');
        if (ev.enraged) this.toast(`${ev.name} blir rasande!`, 'boss');
        if (!ev.active && ev.victory) {
          this.shake = 0.6;
          this.toast(`${ev.name} är besegrad!`, 'legendary');
        }
        break;
      case 'fx':
        this.#fxEvent(ev);
        break;
      default:
        break;
    }
  }

  #fxEvent(ev) {
    switch (ev.fx) {
      case 'text':
        this.fx.text(ev.x, ev.y, String(ev.text).slice(0, 40), String(ev.color ?? '#ffe890'), 1.2);
        break;
      case 'upgrade':
        this.fx.emit('sparkle', ev.x, ev.y - 0.3, 6, 0.5, 1.5);
        this.fx.add({ type: 'ring', x: ev.x, y: ev.y, r0: 0.2, r1: 0.9, color: '#7ae0ff', dur: 0.3 });
        break;
      case 'ring':
        this.fx.add({ type: 'ring', x: ev.x, y: ev.y, r0: 0.5, r1: ev.r, color: ev.color, dur: 0.3 });
        break;
      case 'boom':
        this.fx.add({ type: 'ring', x: ev.x, y: ev.y, r0: 0.2, r1: ev.r, color: ev.color, dur: 0.22, fill: true });
        this.fx.emit('smoke', ev.x, ev.y, 8, ev.r);
        this.audio.play('explode', { throttle: 80 });
        break;
      case 'chain':
        this.fx.add({ type: 'line', points: ev.points, color: ev.color, dur: 0.18, jagged: true });
        this.audio.play('zap', { throttle: 90 });
        break;
      case 'spin':
        this.fx.add({ type: 'slash', x: ev.x, y: ev.y, angle: 0, arc: Math.PI * 2, r: ev.r, color: ev.color, dur: 0.22 });
        break;
      case 'levelup':
      case 'holy':
        this.fx.emit('holy', ev.x, ev.y, 20, 0.8, 3);
        break;
      case 'chest':
        this.fx.emit('sparkle', ev.x, ev.y, 16, 0.6, 3);
        this.audio.play('chest');
        break;
      case 'drop':
        this.fx.add({ type: 'ring', x: ev.x, y: ev.y, r0: 0.2, r1: 1 + ev.r * 0.5, color: ev.color, dur: 0.45 });
        if (ev.r >= 3) this.fx.add({ type: 'pillar', x: ev.x, y: ev.y, r: 0.25 + ev.r * 0.05, color: ev.color, dur: 0.5 });
        this.audio.play('drop', { rarity: ev.r, throttle: 0 });
        break;
      case 'blink':
        this.fx.emit('arcane', ev.x, ev.y, 24, 0.6, 3);
        break;
      case 'dust':
        // Someone climbed onto a horse.
        this.fx.emit('dust', ev.x, ev.y + 0.3, 8, 0.6, 1.2);
        break;
      case 'smite':
        this.fx.add({ type: 'pillar', x: ev.x, y: ev.y, r: 0.6, color: '#fff3b0', dur: 0.3 });
        break;
      case 'splash':
        // Boarding, a shark's lunge, a serpent diving or bursting up.
        this.fx.emit('splash', ev.x, ev.y, ev.big ? 22 : 8, ev.big ? 1 : 0.5, ev.big ? 3.5 : 2);
        if (ev.big) {
          this.fx.add({ type: 'ring', x: ev.x, y: ev.y, r0: 0.3, r1: 1.8, color: '#e8f8ff', dur: 0.35 });
          if (dist2(ev.x, ev.y, this.player.x, this.player.y) < 16 * 16) this.audio.play('boom', { throttle: 120 });
        }
        break;
      case 'ab':
        this.#abilityFx(ev);
        break;
      case 'boss':
        // A boss's attack: the screen shakes for everyone close by.
        this.#abilityFx(ev, true);
        break;
      default:
        break;
    }
  }

  /**
   * What a weapon ability looks and sounds like (server/abilities.js show()):
   * the same shapes, particles and sounds as in single player. Shakes,
   * flashes and vibration are only for the one who cast it.
   */
  #abilityFx(ev, felt = false) {
    const mine = ev.by === this.myId || (felt && dist2(ev.x ?? 0, ev.y ?? 0, this.player.x, this.player.y) < 14 * 14);
    const heard = mine || dist2(ev.x ?? 0, ev.y ?? 0, this.player.x, this.player.y) < 16 * 16;
    for (const op of Array.isArray(ev.ops) ? ev.ops : []) {
      if (!Array.isArray(op)) continue;
      switch (op[0]) {
        case 'add':
          if (op[1] && FX_SHAPES.has(op[1].type)) this.fx.add({ ...op[1] });
          break;
        case 'emit':
          this.fx.emit(String(op[1]), op[2], op[3], Math.min(60, op[4] | 0), op[5], op[6]);
          break;
        case 'snd':
          if (heard) this.audio.play(String(op[1]), op[2] ?? {});
          break;
        case 'text':
          this.fx.text(op[1], op[2], String(op[3]).slice(0, 40), String(op[4]), Number(op[5]) || 1);
          break;
        case 'cone':
          this.#breathFx(op, mine);
          break;
        case 'shake':
          if (mine) this.shake = Math.max(this.shake, Number(op[1]) || 0);
          break;
        case 'flash':
          if (mine) this.flash(String(op[1]), Number(op[2]) || 0.2);
          break;
        case 'vib':
          if (mine) this.vibrate(Math.min(80, op[1] | 0));
          break;
        case 'ascend':
          if (mine) this.ascend = { until: this.time + Number(op[1]), color: String(op[2]) };
          break;
        default:
          break;
      }
    }
  }

  /** Dragon's Breath: fire and sparks in a cone (from you as you see yourself). */
  #breathFx([, x, y, a, radius, half], mine) {
    const ox = mine ? this.player.x : x;
    const oy = mine ? this.player.y : y;
    for (let k = 0; k < 5; k++) {
      const d = Math.random() * radius;
      const off = (Math.random() - 0.5) * 2 * half * (d / radius);
      this.fx.emit(k % 2 ? 'ember' : 'spark', ox + Math.cos(a + off) * d, oy + Math.sin(a + off) * d, 2, 0.3, 2.5);
    }
  }

  vibrate(ms) {
    if (this.spSave.settings.vibration && this.input.mode === 'touch') navigator.vibrate?.(ms);
  }

  flash(color, dur = 0.3) {
    this.screenFlash = { color, t: dur, dur };
  }

  // --- Interaction -------------------------------------------------------------------------------------

  #findInteractable() {
    const p = this.player;
    if (this.build.active || p.dead) return null;
    // Out on the water: Use takes you ashore.
    if (this.sailing) return findLanding(this);
    // A merchant at a market (reachable across the stall's counter).
    const npc = this.markets.merchantNear(p.x, p.y, 2.4);
    if (npc) return { type: 'merchant', key: `npc:${npc.marketId}:${npc.name}`, npc, x: npc.x, y: npc.y };
    let best = null;
    let bestD = INTERACT_RADIUS * INTERACT_RADIUS;
    for (const o of this.world.objectsNear(p.x, p.y, 1)) {
      if ((o.type === 'chest' || o.type === 'shrine') && o.used) continue;
      if (isPoi(o.type)) {
        if (POI[o.type].once && poiFound(this.save, o)) continue;
      } else if (!['chest', 'shrine', 'altar', 'building'].includes(o.type)) {
        continue;
      }
      if (o.type === 'altar' && this.boss) continue;
      const d = dist2(p.x, p.y, o.x, o.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    const banner = this.#ownBanner();
    if (banner && dist2(p.x, p.y, banner.x + 0.5, banner.y + 0.5) < 2.2 * 2.2) {
      return { type: 'banner', key: `banner:${banner.sid}`, x: banner.x + 0.5, y: banner.y + 0.5 };
    }
    // A building in a clan base (your own: use it).
    const bst = this.#baseBuildingNear();
    if (bst && (!best || dist2(p.x, p.y, bst.x + 0.5, bst.y + 0.5) < bestD)) {
      return { type: 'basebuilding', key: `b:${bst.sid}`, st: bst, x: bst.x + 0.5, y: bst.y + 0.5 };
    }
    // Horses (the server decides the same way): climb on, or get off when nothing else is near.
    if (this.riding) {
      if (!best) return { type: 'dismount', key: 'dismount', x: p.x, y: p.y };
    } else {
      const h = this.#horseNear();
      if (h && (!best || dist2(p.x, p.y, h.x, h.y) < bestD)) return { type: 'horse', key: h.key, horse: h, x: h.x, y: h.y };
    }
    if (!best && this.toolActive) return findHarvestTarget({ player: p, world: this.world, data: this.data });
    // At the water's edge: launch your boat (or learn why you can't).
    return best ?? findLaunch(this);
  }

  #horseNear() {
    const p = this.player;
    let best = null;
    let bestD = 1.8 * 1.8;
    for (const h of this.horses) {
      if (h.saddle && !h.own) continue;
      const d = dist2(p.x, p.y, h.x, h.y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  interactLabel(o) {
    if (!o) return null;
    switch (o.type) {
      case 'chest': return 'Öppna kistan';
      case 'shrine': return 'Be vid helgedomen';
      case 'altar': return this.altarSpent(o) ? 'Ett tyst altare' : `Väck ${this.data.byId.bosses.get(o.bossId)?.name ?? 'bossen'}`;
      case 'building': return BUILDING_LABELS[o.buildingId] ?? 'Använd';
      case 'banner': return 'Klanbanéret (bas och valv)';
      case 'basebuilding': {
        const id = buildingOfStruct(o.st.id);
        if (!this.isOwnStructure(o.st)) return `${BUILDING_SV[id]} (en annan klans)`;
        if (id === 'well') {
          const n = Math.floor(this.clan?.base?.well ?? 0);
          return n > 0 ? `Hämta ${n} essens` : 'Brunnen fylls…';
        }
        return `${BASE_LABELS[id] ?? BUILDING_SV[id]} · nivå ${this.structureLevel(o.st)}`;
      }
      case 'launch': return `Segla ut (${o.boat.name})`;
      case 'merchant': return this.markets.isHostile(o.npc.marketId)
        ? `${o.npc.name} vill inte handla (${Math.ceil(this.markets.hostileSecondsLeft(o.npc.marketId) / 60)} min)`
        : `Handla med ${o.npc.name}`;
      case 'bones': return 'Leta bland kvarlevorna';
      case 'signpost': return 'Läs skylten';
      case 'mushrooms': return 'Ät en glödhatt';
      case 'camp': return 'Vila vid det gamla lägret';
      case 'bottle': return 'Öppna flaskan';
      case 'wreck': return 'Leta i vraket';
      case 'idol': return 'Rör vid idolen';
      case 'treasure': return 'Gräv upp skatten';
      case 'tower': return 'Klättra upp i utsiktstornet';
      case 'ruins': return 'Leta i ruinerna';
      case 'mine': return 'Gräv i den gamla gruvan';
      case 'runestone': return 'Läs runstenen';
      case 'land': return 'Gå i land';
      case 'shore': return null;
      case 'horse': {
        if (o.horse.own) return `Rid ${o.horse.record?.name ?? 'din häst'}`;
        const breed = BREED_BY_ID.get(o.horse.breed);
        return `Tämj den vilda hästen (${breed?.sv.toLowerCase() ?? 'häst'})`;
      }
      case 'dismount': return `Kliv av ${this.riding?.name ?? 'hästen'}`;
      default: return null;
    }
  }

  altarSpent(o) {
    return this.altarsSpent.has(o.key);
  }

  #ownBanner() {
    const clanId = this.me?.clan?.id;
    if (!clanId) return null;
    for (const st of this.structById.values()) if (st.id === 'banner' && st.clanId === clanId) return st;
    return null;
  }

  // --- What the renderer needs -----------------------------------------------------------------------------

  structuresForDraw() {
    const mine = [...this.structById.values()];
    return this.markets.structures.length ? mine.concat(this.markets.structures) : mine;
  }

  marketRequest(msg) {
    this.#ask({ t: 'market', ...msg });
  }

  hitNpcs() {
    return false;
  }

  get buildCenter() {
    const c = this.#claimHere();
    return c ? { x: c.x - 0.5, y: c.y - 0.5 } : { x: 0, y: 0 };
  }

  buildRadius() {
    return this.#claimHere() ? this.rules.claimRadius : 0;
  }

  #claimHere() {
    const clanId = this.me?.clan?.id;
    if (!clanId) return null;
    return this.claims.find((c) => c.clanId === clanId && dist2(c.x, c.y, this.player.x, this.player.y) < (this.rules.claimRadius + 12) ** 2) ?? null;
  }

  /** Dashed rings: the town's edge and claims around you. */
  get zoneRings() {
    if (!this.rules) return null;
    const myClan = this.me?.clan?.id;
    const rings = [{ x: 0.5, y: 0.5, r: this.rules.safeRadius, color: '#ffe890' }];
    for (const c of this.claims) rings.push({ x: c.x, y: c.y, r: this.rules.claimRadius, color: c.clanId === myClan ? '#7ae07a' : '#ff7a5a' });
    return rings;
  }

  get lastCompass() {
    return this.compass ?? null;
  }

  // --- The map: the town, your base and your clanmates ---------------------------------------------------

  get campLabel() {
    return 'Fristaden';
  }

  /** Your clan's banner, or null. */
  mapHome() {
    const clanId = this.me?.clan?.id;
    const c = clanId ? this.claims.find((x) => x.clanId === clanId) : null;
    return c ? { x: c.x, y: c.y } : null;
  }

  mapMarkers() {
    const out = [];
    const home = this.mapHome();
    if (home) out.push({ kind: 'base', x: home.x, y: home.y, label: this.clan ? `[${this.clan.tag}] bas` : 'Er bas' });
    for (const m of this.mates) out.push({ kind: 'mate', x: m.x, y: m.y, dead: Boolean(m.dead), label: m.n });
    return out;
  }

  // --- Loadout -----------------------------------------------------------------------------------------

  get activeSlot() {
    return this.save.inventory.activeSlot ?? 'main';
  }

  get toolActive() {
    return this.activeSlot === 'tool' && Boolean(currentPickaxe(this.data, this.save));
  }

  get handsEmpty() {
    return this.activeSlot === 'none';
  }

  /** Setting sail or going ashore (the server moved you). */
  #sailingChanged() {
    const p = this.player;
    if (this.sailing && this.build.active) this.toggleBuildMode(false);
    this.fx.emit('glint', p.x, p.y, 14, 0.6, 2, ['#e8f8ff', '#9ad8f4']);
    this.audio.play('swish');
    this.target = null;
    this.interactTarget = null;
    this.interactT = 0;
    this.emit('interact', { label: null });
    this.emit('sailing', { on: this.sailing });
  }

  /** Out on the water in your boat (the server says so in every snapshot). */
  get sailing() {
    return Boolean(this.selfFlags & SF.SAILING);
  }

  get boat() {
    return currentBoat(this.data, this.save);
  }

  get moveMode() {
    if (this.riding) return HORSE_MODE;
    return this.sailing ? boatMode(this.boat) : 'player';
  }

  /** The horse you ride (its record), or null (the server says so in every snapshot). */
  get riding() {
    if (!(this.selfFlags & SF.RIDING)) return null;
    const st = this.save.horses;
    return st?.owned.find((h) => h.id === st.riding) ?? { id: 0, breed: 'pony', name: 'hästen', speed: 6, gallop: 1.25, hp: 0 };
  }

  /** Lets one of your horses go (back to the wild). */
  async releaseHorse(id) {
    const res = await this.#ask({ t: 'horse', op: 'release', id });
    return res.ok;
  }

  describeHorse(h) {
    return describeHorse(h, true);
  }

  get heldWeapon() {
    const s = this.activeSlot;
    return s === 'main' || s === 'secondary' ? this.weapon : null;
  }

  #applySlotLocal() {
    const inv = this.save.inventory;
    const id = inv.activeSlot === 'secondary' ? inv.secondary : inv.equipped;
    const dna = (id && inv.bag.find((w) => w.id === id)) || (inv.equipped && inv.bag.find((w) => w.id === inv.equipped)) || null;
    this.weapon = dna ? this.#compile(dna) : null;
    const p = this.player;
    p.attackAnim = null;
    p.toolAnim = null;
    this.emit('equip', this.weapon?.dna ?? null);
    this.emit('slot', { slot: inv.activeSlot });
  }

  /** Same as single player: pressing the slot you hold puts it away. */
  switchSlot(slot) {
    const inv = this.save.inventory;
    if (slot === 'tool' && !currentPickaxe(this.data, this.save)) {
      this.toast('Ingen hacka än: smid en i Fristadens smedja.', 'warn');
      return false;
    }
    if (slot === 'secondary' && !inv.secondary) {
      this.toast('Inget andravapen: välj ett i väskan.', 'warn');
      return false;
    }
    this.pendingCmd = { main: CMD.SLOT_MAIN, secondary: CMD.SLOT_SECONDARY, tool: CMD.SLOT_TOOL, none: CMD.SLOT_NONE }[slot] ?? 0;
    this.audio.play('ui');
    return true;
  }

  cycleSlot(dir = 1) {
    this.pendingCmd = dir > 0 ? CMD.SLOT_NEXT : CMD.SLOT_PREV;
  }

  allWeapons() {
    return [...this.save.inventory.bag, ...this.save.inventory.storage];
  }

  findWeapon(id) {
    return this.allWeapons().find((w) => w.id === id) ?? null;
  }

  inLoadout(id) {
    const inv = this.save.inventory;
    return Boolean(id) && (inv.equipped === id || inv.secondary === id);
  }

  async #ask(msg) {
    const res = await this.conn.request(msg);
    if (!res.ok && res.error) {
      this.toast(res.error, 'warn');
      this.audio.play('hurt', { throttle: 200 });
    }
    return res;
  }

  equip(id, slot = 'main') {
    this.#ask({ t: 'equip', id, slot });
    return true;
  }

  // --- Pals (the server keeps them with your character) -----------------------------------------

  research(id) {
    this.#ask({ t: 'research', id });
    return true;
  }

  hatchEgg(id) {
    this.#ask({ t: 'pal', op: 'hatch', id });
    return true;
  }

  async upgradePal(id) {
    const res = await this.#ask({ t: 'pal', op: 'upgrade', id });
    if (res.ok) this.audio.play('levelup');
    return res.ok;
  }

  setActivePal(id) {
    this.#ask({ t: 'pal', op: 'active', id });
  }

  setPalMode(mode) {
    if (!PAL_MODES.includes(mode)) return;
    this.save.pals.mode = mode;
    this.emit('pals');
    this.#ask({ t: 'pal', op: 'mode', mode });
  }

  /** Eggs hatch on the server (the pals panel calls this every second). */
  checkHatch() {}

  #palHud() {
    const pal = this.pal;
    if (!pal) return null;
    const owned = findPal(this.save, pal.id);
    return {
      name: owned?.name ?? '', species: pal.species, level: pal.level, mode: this.save.pals.mode,
      hp: Math.ceil(pal.hp), maxHp: pal.stats.maxHp, down: pal.state === 'down',
      downLeft: pal.state === 'down' ? Math.max(0, Math.ceil(pal.downUntil - this.time)) : 0,
    };
  }

  moveWeapon(id, to) {
    if (to === 'storage' && this.inLoadout(id)) {
      this.toast('Det vapnet är utrustat: byt ut det först', 'warn');
      return false;
    }
    this.#ask({ t: 'move', id, to });
    return true;
  }

  salvage(id) {
    if (this.inLoadout(id)) {
      this.toast('Du kan inte smälta ner ett utrustat vapen', 'warn');
      return null;
    }
    const dna = this.findWeapon(id);
    this.#ask({ t: 'salvage', ids: [id] });
    return dna ? salvageValue(dna) : null;
  }

  salvageMany(ids) {
    const inv = this.save.inventory;
    const list = ids.filter((id) => !this.inLoadout(id) && !inv.favorites.includes(id));
    if (list.length) this.#ask({ t: 'salvage', ids: list });
    return { count: list.length, scrap: 0, essence: 0 };
  }

  dropWeapon(id) {
    this.#ask({ t: 'drop', id });
  }

  toggleFavorite(id) {
    const inv = this.save.inventory;
    const on = !inv.favorites.includes(id);
    inv.favorites = on ? [...inv.favorites, id] : inv.favorites.filter((f) => f !== id);
    this.conn.sendJson({ t: 'fav', id });
    return on;
  }

  markSeen(id) {
    const inv = this.save.inventory;
    if (inv.unseen.includes(id)) inv.unseen = inv.unseen.filter((f) => f !== id);
  }

  // --- Forge ------------------------------------------------------------------------------------------------

  /** The forge you stand at: your clan's ({ level }) or Fristaden's ({ town, level 1 }), or null. */
  forgeHere() {
    const p = this.player;
    const own = this.#ownBuilding('forge');
    if (own && dist2(own.x + 0.5, own.y + 0.5, p.x, p.y) <= 3.4 * 3.4) return { town: false, level: this.baseLevels.forge ?? 1 };
    const b = this.data.base.buildings.find((x) => x.id === 'forge');
    if (dist2(b.x, b.y, p.x, p.y) <= 36) return { town: true, level: TOWN_LEVELS.forge };
    return null;
  }

  /** At a forge? The forge panel then shows what that forge can make. */
  nearForge() {
    const f = this.forgeHere();
    this.save.base.buildings.forge = f ? f.level : this.baseLevels.forge ?? 0;
    return Boolean(f);
  }

  async craft(choice) {
    const res = await this.conn.request({ t: 'craft', choice });
    if (!res.ok) throw new Error(res.error ?? 'Smedjan svarade inte');
    return null;
  }

  async forgePickaxe(tier) {
    const res = await this.#ask({ t: 'pickaxe', tier });
    return res.ok ? pickaxeDefs(this.data).find((p) => p.tier === tier) : null;
  }

  async buildBoat(tier) {
    const res = await this.#ask({ t: 'boat', tier });
    if (res.ok) this.audio.play('levelup');
    return res.ok ? boatDefs(this.data).find((b) => b.tier === tier) : null;
  }

  // --- Discovery (crafted weapons: the case-opening roll, then choose) ----------------------------------

  discoverWeapon(dna, { caseRoll = null } = {}) {
    this.discoveryQueue.push({ dna, caseRoll });
    if (!this.discoveryOpen) this.#openNextDiscovery();
  }

  #openNextDiscovery() {
    const next = this.discoveryQueue.shift();
    if (!next) return;
    this.discoveryOpen = true;
    const inv = this.save.inventory;
    this.emit('discovery', {
      dna: next.dna,
      caseRoll: next.caseRoll,
      canKeep: true,
      canStore: inv.storage.length < inv.storageSize,
      salvage: salvageValue(next.dna),
      equipped: this.weapon?.dna ?? null,
    });
  }

  /** The weapon is already yours (in the bag); this only applies the choice. */
  resolveDiscovery(dna, choice) {
    if (choice === 'equip') this.equip(dna.id, 'main');
    else if (choice === 'secondary') this.equip(dna.id, 'secondary');
    else if (choice === 'storage') this.moveWeapon(dna.id, 'storage');
    else if (choice === 'salvage') this.salvage(dna.id);
    this.discoveryOpen = false;
    this.resume('discovery');
    if (this.discoveryQueue.length) setTimeout(() => this.#openNextDiscovery(), 150);
  }

  // --- Building ------------------------------------------------------------------------------------------------

  #clanRole() {
    return this.me?.clan?.role ?? null;
  }

  toggleBuildMode(on = !this.build.active) {
    const b = this.build;
    if (on === b.active) return;
    if (on) {
      const p = this.player;
      if (p.dead) return;
      if (!this.me?.clan) {
        this.toast('Gå med i eller skapa en klan för att bygga (Meny → Klan). Du kan vara ensam i klanen.', 'warn');
        return;
      }
      if (inSafeZone(this.rules, p.x, p.y)) {
        this.toast('Man kan inte bygga i Fristaden. Gå ut i vildmarken.', 'warn');
        return;
      }
      const claim = this.#claimHere();
      if (!claim && this.#ownBannerAnywhere()) {
        this.toast('Gå till er klans mark för att bygga.', 'warn');
        return;
      }
      b.active = true;
      b.tool = 'place';
      b.hover = null;
      if (!claim) {
        b.selected = 'banner';
        this.toast('Res klanbanéret här för att göra anspråk på marken runt det.', 'component');
      } else if (!structureDef(this.data, b.selected) || b.selected === 'banner') {
        b.selected = 'wood_wall';
      }
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

  #ownBannerAnywhere() {
    const clanId = this.me?.clan?.id;
    return clanId ? this.claims.some((c) => c.clanId === clanId) : false;
  }

  selectStructure(id) {
    const b = this.build;
    if (id === 'remove' || id === 'upgrade') b.tool = b.tool === id ? 'place' : id;
    else if (structureDef(this.data, id)) {
      b.selected = id;
      b.tool = 'place';
    }
    this.emit('build', { active: b.active });
  }

  structureLock(def) {
    const lock = mpStructureLock(def, this.save.player.level);
    if (lock) return lock;
    if (def.kind === 'building' && this.clan?.base?.placed?.[def.building]) return 'Står redan i basen (riv den för att flytta den)';
    const claim = this.#claimHere();
    if (def.id === 'banner') {
      if (this.#ownBannerAnywhere()) return 'Er klan har redan ett banér';
      if (!canDo(this.#clanRole() ?? 'member', 'banner')) return 'Bara ledare och officerare kan resa banéret';
      return null;
    }
    return claim ? null : 'Res ett klanbanér först';
  }

  /** Client-side guess at why a placement would fail (the server decides). */
  #placementProblem(def, tx, ty) {
    const p = this.player;
    const lock = this.structureLock(def);
    if (lock) return lock;
    if (inSafeZone(this.rules, tx + 0.5, ty + 0.5)) return 'Man kan inte bygga i Fristaden';
    if (dist2(p.x, p.y, tx + 0.5, ty + 0.5) > (this.data.building.reach + 0.5) ** 2) return 'För långt bort';
    if (def.id === 'banner') {
      const problem = bannerProblem(this.rules, tx + 0.5, ty + 0.5, this.me?.clan?.id, this.claims);
      if (problem) return problem;
    } else {
      const c = claimAt(this.rules, this.claims, tx, ty);
      if (!c || c.clanId !== this.me?.clan?.id) return 'Utanför er klans mark';
    }
    const ground = groundProblem(this.world, def, tx, ty);
    if (ground === 'water') return 'Lägg ett golv på vattnet först, sedan kan du bygga på det';
    if (ground === 'deep') return 'För djupt (eller för hett) att bygga här';
    if (ground) return 'Hugg bort trädet eller stenen först';
    if (def.kind === 'building' && onWater(this.world, tx, ty)) return 'Byggnader står på fast mark';
    if (def.kind === 'floor' ? this.world.floorAt(tx, ty) : this.world.structureAt(tx, ty)) return 'Här står redan något';
    if (!def.walkable) {
      const inside = (x, y, r) => x + r > tx && x - r < tx + 1 && y + r > ty && y - r < ty + 1;
      if (inside(p.x, p.y, p.r)) return 'Du står där';
    }
    if (def.kind === 'building') {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (this.world.structureAt(tx + dx, ty + dy)?.def?.kind === 'building') return 'För nära en annan byggnad';
      }
    }
    const cost = this.structureCost(def);
    const wallet = this.buildWallet(def);
    if (!canAfford(wallet, cost)) return shortfalls(wallet, cost)[0];
    return null;
  }

  /** What a structure costs now (a clan building built before moves for free). */
  structureCost(def) {
    if (def.kind === 'building' && (this.clan?.base?.levels?.[def.building] ?? 0) > 0) return {};
    return def.cost;
  }

  /** What pays for it: your pockets, or for a clan building the vault and your pockets together. */
  buildWallet(def) {
    if (def?.kind !== 'building') return this.save.resources;
    const out = { ...this.save.resources };
    for (const [k, v] of Object.entries(this.clan?.vault ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
  }

  /** What the structure at (tx, ty) upgrades into, and what that costs (build bar), or null. */
  upgradeInfo(tx, ty) {
    const st = this.world.structureAt(tx, ty) ?? this.world.floorAt(tx, ty);
    const to = st && !st.marketId ? upgradeDef(this.data, st.def) : null;
    return to ? { from: st.def, to, cost: upgradeCost(this.data, st.def, to) } : null;
  }

  /** Client-side guess at why an upgrade would fail (the server decides). */
  #upgradeProblem(tx, ty) {
    const st = this.world.structureAt(tx, ty) ?? this.world.floorAt(tx, ty);
    if (!st || st.marketId) return 'Här finns inget att uppgradera';
    if (!st.clanId || st.clanId !== this.me?.clan?.id) return 'Det där är inte er klans';
    const info = this.upgradeInfo(tx, ty);
    if (!info) return `${st.def.name} går inte att förstärka mer`;
    const lock = mpStructureLock(info.to, this.save.player.level);
    if (lock) return `${info.to.name}: ${lock.toLowerCase()}`;
    if (dist2(this.player.x, this.player.y, tx + 0.5, ty + 0.5) > (this.data.building.reach + 0.5) ** 2) return 'För långt bort';
    const wallet = this.buildWallet({ kind: 'building' });
    if (!canAfford(wallet, info.cost)) return shortfalls(wallet, info.cost)[0];
    return null;
  }

  /** Upgrades every structure of one kind in the base (clan panel → Förstärk). */
  fortify(id) {
    return this.#ask({ t: 'upgrade', all: id });
  }

  buildAt(tx, ty, tool = this.build.tool) {
    if (tool === 'remove') {
      const st = this.world.structureAt(tx, ty) ?? this.world.floorAt(tx, ty);
      if (!st) return 'Här finns inget att riva';
      this.#ask({ t: 'unbuild', x: tx, y: ty });
      return null;
    }
    if (tool === 'upgrade') {
      const problem = this.#upgradeProblem(tx, ty);
      if (problem) return problem;
      this.#ask({ t: 'upgrade', x: tx, y: ty });
      return null;
    }
    const def = structureDef(this.data, this.build.selected);
    if (!def) return 'Välj något att bygga';
    const problem = this.#placementProblem(def, tx, ty);
    if (problem) return problem;
    this.#ask({ t: 'build', id: def.id, x: tx, y: ty }).then((res) => {
      if (res.ok && def.id === 'banner') this.selectStructure('wood_wall');
    });
    return null;
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
        if (problem && tool !== 'remove') this.toast(problem, 'warn');
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
      tap: (cx, cy) => {
        const { tx, ty } = this.#tileAt(cx, cy);
        const g = b.ghost;
        if (g && g.tx === tx && g.ty === ty) {
          const problem = this.buildAt(tx, ty);
          if (problem) {
            this.toast(problem, 'warn');
            this.audio.play('hurt', { throttle: 200 });
          }
        }
        b.hover = { tx, ty };
        b.hoverAt = this.time;
        this.#updateBuildGhost();
      },
      aim: (cx, cy) => {
        const { tx, ty } = this.#tileAt(cx, cy);
        b.hover = { tx, ty };
        b.hoverAt = this.time;
      },
      onGhost: (cx, cy) => {
        const { tx, ty } = this.#tileAt(cx, cy);
        return Boolean(b.ghost && b.ghost.tx === tx && b.ghost.ty === ty);
      },
    };
  }

  #updateBuildGhost() {
    const b = this.build;
    const p = this.player;
    if (p.dead || inSafeZone(this.rules, p.x, p.y)) {
      this.toggleBuildMode(false);
      return;
    }
    let tile;
    if (b.hover && (this.input.mode === 'touch' || this.time - b.hoverAt < 4)) tile = b.hover;
    else tile = { tx: Math.floor(p.x + Math.cos(p.facing) * 1.1), ty: Math.floor(p.y + Math.sin(p.facing) * 1.1) };
    b.ghost = tile;
    if (b.tool === 'remove') {
      b.reason = this.world.structureAt(tile.tx, tile.ty) || this.world.floorAt(tile.tx, tile.ty) ? null : 'Här finns inget att riva';
    } else if (b.tool === 'upgrade') {
      b.reason = this.#upgradeProblem(tile.tx, tile.ty);
    } else {
      const def = structureDef(this.data, b.selected);
      b.reason = def ? this.#placementProblem(def, tile.tx, tile.ty) : 'Välj något att bygga';
    }
  }

  // --- Clans, chat, misc requests ------------------------------------------------------------------------------

  clanRequest(op, args = {}) {
    return this.#ask({ t: 'clan', op, ...args });
  }

  chat(text, ch = 'all') {
    return this.#ask({ t: 'chat', text, ch });
  }

  request(msg) {
    return this.#ask(msg);
  }

  /** Guests: a password to log in with your name from another link or device. */
  async setPassword(password) {
    const res = await this.#ask({ t: 'password', password });
    if (res.ok) this.account.password = true;
    return res;
  }

  // --- Map ---------------------------------------------------------------------------------------------------

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
    if (added) {
      this.emit('explored');
      if (this.explored.size < 20000) writeStore(this.exploredKey, this.save.world.explored);
    }
  }

  /** Shows the land within r chunks of (x, y) on your map. */
  revealArea(x, y, r) {
    let added = false;
    for (const key of chunksAround(x, y, r)) {
      if (this.explored.has(key)) continue;
      this.explored.add(key);
      this.save.world.explored.push(key);
      added = true;
    }
    if (added) {
      this.emit('explored');
      if (this.explored.size < 20000) writeStore(this.exploredKey, this.save.world.explored);
    }
  }

  addPin(x, y, label = '') {
    const pins = this.save.world.pins;
    if (pins.length >= 40) pins.shift();
    pins.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, label });
    writeStore(`pg-mp-pins:${this.worldSeed}`, pins);
  }

  removePin(index) {
    this.save.world.pins.splice(index, 1);
    writeStore(`pg-mp-pins:${this.worldSeed}`, this.save.world.pins);
  }

  // --- HUD ------------------------------------------------------------------------------------------------------

  nearestAltar(range = 700) {
    const p = this.player;
    const stamp = `${Math.round(p.x / 40)},${Math.round(p.y / 40)},${this.altarsSpent.size}`;
    if (this.altarStamp !== stamp) {
      this.altarStamp = stamp;
      const all = new Map(this.world.greatAltars().map((a) => [a.key, a]));
      for (const a of this.world.altarsNear(p.x, p.y, range)) all.set(a.key, a);
      this.altarList = [...all.values()].filter((a) => !this.altarsSpent.has(a.key));
    }
    let best = null;
    let bestD = Infinity;
    for (const a of this.altarList ?? []) {
      const d = dist2(p.x, p.y, a.x, a.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best ? { ...best, dist: Math.sqrt(bestD) } : null;
  }

  /** Where you are: town, wilderness, your clan's land or someone else's. */
  zoneInfo() {
    const f = this.selfFlags;
    const protectedNow = f & SF.PROTECTED;
    const newbie = f & SF.NEWBIE;
    if (f & SF.SAFE) return { kind: 'safe', label: 'Fristaden: säkert', protectedNow, newbie };
    if (f & SF.OWN_CLAIM) return { kind: 'own', label: 'Er mark', protectedNow, newbie };
    if (f & SF.FOREIGN_CLAIM) return { kind: 'foreign', label: 'Annan klans mark: PvP', protectedNow, newbie };
    return { kind: 'wild', label: 'Vildmark: PvP', protectedNow, newbie };
  }

  hudState() {
    const p = this.player;
    const s = this.save;
    const best = this.world ? this.nearestAltar() : null;
    const boss = best ? this.data.byId.bosses.get(best.bossId) : null;
    this.compass = best ? { angle: angleTo(p.x, p.y, best.x, best.y), dist: best.dist, name: boss.name, color: boss.color } : null;
    return {
      hp: Math.max(0, Math.ceil(p.hp)),
      maxHp: p.maxHp,
      level: s.player.level,
      xp: s.player.xp,
      xpNext: this.xpNext ?? 40,
      essence: s.resources.essence ?? 0,
      scrap: s.resources.scrap ?? 0,
      wood: s.resources.wood ?? 0,
      stone: s.resources.stone ?? 0,
      building: this.build.active,
      nearCamp: Boolean(this.me?.clan) && !(this.selfFlags & SF.SAFE),
      ability: this.toolActive || this.handsEmpty ? null : abilityProgress(this),
      abilityName: this.weapon?.ability?.name ?? null,
      sprinting: p.sprinting,
      boss: this.boss ? { name: this.boss.bossDef.name, hp: this.boss.hp, maxHp: this.boss.maxHp, phase: this.boss.hp < this.boss.maxHp * 0.5 ? 2 : 1 } : null,
      dead: p.dead,
      fps: Math.round(1000 / this.frameMs),
      craftingUnlocked: true,
      campAlert: false,
      pal: this.#palHud(),
      compass: this.compass,
      zone: this.zoneInfo(),
      ping: Math.round(this.conn?.rtt ?? 0),
    };
  }

  /** Numbers for the network overlay (?debug=1 or the menu). */
  netDebug() {
    return {
      ping: Math.round(this.conn?.rtt ?? 0),
      interpMs: Math.round(this.interpDelay * TICK_MS),
      pending: this.pending.length,
      corrections: this.netStats.corrections,
      bigCorrections: this.netStats.bigCorrections,
      lastError: this.netStats.lastError,
      kbps: Math.round((this.netStats.bytesPerSec * 8) / 1000),
      entities: this.store.ents.size,
      tick: this.serverTick,
    };
  }

  // --- The Waystone: home and back -------------------------------------------------------------

  /** Seconds until the Waystone can take you home again. */
  recallReadyIn() {
    return Math.max(0, ((this.me?.recallAt ?? 0) - Date.now()) / 1000);
  }

  recall() {
    this.#ask({ t: 'recall', op: 'go' });
  }

  recallBack() {
    this.#ask({ t: 'recall', op: 'back' });
  }

  // --- Your clan's base: the camp's buildings ---------------------------------------------------------------

  /** Levels of the buildings that stand in your clan's base ({} without). */
  get baseLevels() {
    const b = this.clan?.base;
    return b ? clanLevels({ buildings: b.levels }, b.placed) : {};
  }

  /** The single-player save's base mirrors your clan's (bonuses, the panel, the well). */
  syncBase() {
    const s = this.save;
    s.base.buildings = { hearth: 0, ...this.baseLevels };
    const rate = baseBonuses(this.data, s).essencePerHour;
    const n = this.clan?.base?.well ?? 0;
    s.base.wellAt = Date.now() - (rate > 0 ? (n / rate) * 3600 * 1000 : 0);
  }

  #ownBuilding(id) {
    const at = this.clan?.base?.placed?.[id];
    if (!at) return null;
    return { x: at[0], y: at[1] };
  }

  #baseBuildingNear() {
    const p = this.player;
    let best = null;
    let bestD = 1.9 * 1.9;
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const st = this.world.structureAt(tx + dx, ty + dy);
        if (!st || st.def?.kind !== 'building') continue;
        const d = dist2(p.x, p.y, st.x + 0.5, st.y + 0.5);
        if (d < bestD) {
          bestD = d;
          best = st;
        }
      }
    }
    return best;
  }

  /** Fristaden's buildings (the forge and the fire) at their own levels. */
  townBuildingLevel(id) {
    return TOWN_LEVELS[id] ?? 0;
  }

  isOwnStructure(st) {
    return Boolean(st.clanId) && st.clanId === this.me?.clan?.id;
  }

  /** A clan building's level (yours from the clan, others' from the server). */
  structureLevel(st) {
    const id = buildingOfStruct(st.id);
    if (!id) return 0;
    if (this.isOwnStructure(st)) return this.clan?.base?.levels?.[id] ?? st.lv ?? 1;
    return st.lv || 1;
  }

  upgradeBuilding(id) {
    this.#ask({ t: 'base', op: 'upgrade', id });
  }

  collectWell() {
    this.#ask({ t: 'base', op: 'well' });
  }

  // Single-player hooks the shared UI may call.

  atCamp() {
    return inSafeZone(this.rules ?? { safeRadius: 24 }, this.player.x, this.player.y);
  }

  async ensureStarterWeapon() {
    return null;
  }
}
