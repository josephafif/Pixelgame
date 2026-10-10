// The authoritative game: one shared world, 30 ticks a second. Clients only
// send what they want to do; everything that happens is decided here.

import { randomBytes } from 'node:crypto';
import { World, CHUNK, tileKey, WORLD_GEN } from '../src/game/world.js';
import { TICK_RATE, TICK_DT, TICK_MS } from '../src/net/movement.js';
import { parseRaidWindow, raidState, inSafeZone } from '../src/net/rules.js';
import { structureDef } from '../src/game/construction.js';
import { TOWN_LEVELS } from '../src/net/mpbase.js';
import { townMarket } from '../src/game/markets.js';
import { isPoi } from '../src/game/discoveries.js';
import { regrowMinutes } from '../src/game/gathering.js';
import * as players from './players.js';
import * as combat from './combat.js';
import * as enemies from './enemies.js';
import * as loot from './loot.js';
import * as building from './building.js';
import * as clans from './clans.js';
import * as abilities from './abilities.js';
import * as pals from './pals.js';
import * as horses from './horses.js';
import * as markets from './markets.js';
import * as workers from './workers.js';
import * as army from './army.js';
import { sendSnapshots } from './snapshots.js';
import { SpatialGrid, PAD } from './grid.js';

const HISTORY = 32; // ticks of positions kept for lag compensation (~1 s)

/**
 * Where each tick's time goes (milliseconds, smoothed), and what the slowest
 * recent ticks spent it on: /health shows it, to find what makes it stutter.
 */
class TickProfile {
  constructor() {
    this.avg = {};
    this.spikes = []; // the last few ticks over 15 ms, with their parts
  }

  begin() {
    this.t0 = performance.now();
    this.last = this.t0;
    this.parts = {};
  }

  mark(name) {
    const t = performance.now();
    this.parts[name] = (this.parts[name] ?? 0) + (t - this.last);
    this.last = t;
  }

  end() {
    const total = this.last - this.t0;
    for (const [k, v] of Object.entries(this.parts)) this.avg[k] = (this.avg[k] ?? v) * 0.98 + v * 0.02;
    if (total > 15) {
      const parts = {};
      for (const [k, v] of Object.entries(this.parts)) if (v >= 1) parts[k] = Math.round(v * 10) / 10;
      this.spikes.push({ at: Date.now(), ms: Math.round(total * 10) / 10, parts });
      if (this.spikes.length > 8) this.spikes.shift();
    }
  }

  report() {
    const avg = {};
    for (const [k, v] of Object.entries(this.avg)) avg[k] = Math.round(v * 100) / 100;
    return { avg, spikes: this.spikes };
  }
}

export class GameServer {
  constructor({ data, db, config, log = console }) {
    this.data = data;
    this.db = db;
    this.config = config;
    this.rules = config.rules;
    this.raidWindows = parseRaidWindow(this.rules.raidWindow);
    this.log = log;
    this.tick = 0;
    this.time = 0;
    this.nextId = 1;
    this.players = new Map(); // entity id → player
    this.byAccount = new Map(); // account id → player
    this.enemies = new Map();
    this.projectiles = new Map();
    this.pickups = new Map();
    this.areas = new Map();
    this.allies = new Map(); // clones from the Mirror ability
    this.markets = new Map(); // markets someone is near (their walls, turrets and people)
    this.timers = [];
    this.stats = { tickMs: 0, maxTickMs: 0, sent: 0 };
    this.prof = new TickProfile();
    this.playerGrid = new SpatialGrid(16);
    this.chunkCache = new Map();
    this.enemyGrid = new SpatialGrid(8);

    // The world seed is public (clients generate the terrain themselves);
    // the secret seed places loot and is never sent.
    let seed = Number(db.meta('worldSeed'));
    const brandNew = !db.meta('worldSeed');
    if (brandNew) {
      seed = config.worldSeed ?? randomBytes(4).readUInt32BE(0);
      db.setMeta('worldSeed', seed);
      db.setMeta('worldGen', WORLD_GEN);
    }
    let secret = Number(db.meta('secretSeed'));
    if (!db.meta('secretSeed')) {
      secret = randomBytes(4).readUInt32BE(0);
      db.setMeta('secretSeed', secret);
    }
    if (!db.meta('guestSecret')) db.setMeta('guestSecret', randomBytes(32).toString('hex'));
    this.worldSeed = seed >>> 0;
    this.#upgradeWorldGen(db);
    this.world = new World(data, this.worldSeed, {
      secretSeed: secret >>> 0, maxChunks: 900, townBuildings: Object.keys(TOWN_LEVELS), townMarket: townMarket(this.worldSeed),
      gen: this.worldGen, legacy: this.legacy,
    });

    // Harvested trees/rocks, spent altars, opened chests.
    for (const h of db.loadHarvested()) this.world.harvested[`${h.x},${h.y}`] = [h.at, h.tile];
    this.marks = new Map(db.loadMarks().map((m) => [m.key, m]));

    // Clans and their bases.
    this.clans = new Map(db.loadClans().map((c) => [c.id, c]));
    this.memberOf = new Map();
    for (const c of this.clans.values()) for (const id of c.members.keys()) this.memberOf.set(id, c.id);
    this.structures = new Map(); // sid → structure
    building.loadStructures(this);
    // Workers hired at the clans' lodges.
    workers.syncAll(this);
  }

  /**
   * An older world gets the far lands too, but no clan base may end up in
   * new land: the chunks around every claim and structure keep the land
   * they had (saved, and sent to every client with the welcome).
   */
  #upgradeWorldGen(db) {
    let gen = Number(db.meta('worldGen') ?? 1) || 1;
    const legacy = new Map(JSON.parse(db.meta('legacyChunks') ?? '[]'));
    if (gen < WORLD_GEN) {
      const reach = (this.rules?.claimRadius ?? 16) + 16;
      for (const st of db.loadStructures()) {
        const r = st.id === 'banner' ? reach : 0;
        for (let cy = Math.floor((st.y - r) / CHUNK); cy <= Math.floor((st.y + r) / CHUNK); cy++) {
          for (let cx = Math.floor((st.x - r) / CHUNK); cx <= Math.floor((st.x + r) / CHUNK); cx++) {
            const key = `${cx},${cy}`;
            if (!legacy.has(key)) legacy.set(key, gen);
          }
        }
      }
      db.setMeta('legacyChunks', JSON.stringify([...legacy]));
      db.setMeta('worldGen', WORLD_GEN);
      gen = WORLD_GEN;
    }
    this.worldGen = gen;
    this.legacy = legacy;
  }

  newId() {
    const id = this.nextId++;
    if (this.nextId > 0x7fffffff) this.nextId = 1;
    return id;
  }

  get now() {
    return Date.now();
  }

  // --- Loop ------------------------------------------------------------------------

  start() {
    this.running = true;
    this.startedAt = performance.now();
    this.loopTick = 0;
    const loop = () => {
      if (!this.running) return;
      const target = this.startedAt + this.loopTick * TICK_MS;
      let behind = Math.floor((performance.now() - target) / TICK_MS);
      // Fell far behind (debugger, laptop sleep): don't try to catch up.
      if (behind > 10) {
        this.startedAt = performance.now() - this.loopTick * TICK_MS;
        behind = 0;
      }
      const t0 = performance.now();
      this.step();
      this.loopTick++;
      const ms = performance.now() - t0;
      this.stats.tickMs = this.stats.tickMs * 0.95 + ms * 0.05;
      this.stats.maxTickMs = Math.max(this.stats.maxTickMs * 0.999, ms);
      const next = this.startedAt + this.loopTick * TICK_MS;
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    loop();
    this.saveTimer = setInterval(() => this.saveWorld(), this.config.saveIntervalMs);
    this.#upkeep(Date.now());
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.saveTimer);
  }

  /** Base upkeep, once an hour (and, with upkeepCatchUp, for the hours the world slept). */
  #upkeep(now) {
    const HOUR = 60 * 60 * 1000;
    if (!this.upkeepAt) this.upkeepAt = (this.config.upkeepCatchUp && Number(this.db.meta('upkeepAt'))) || now;
    let n = 0;
    while (now - this.upkeepAt >= HOUR && n < 24 * 7) {
      building.upkeep(this);
      this.upkeepAt += HOUR;
      n++;
    }
    if (now - this.upkeepAt >= HOUR) this.upkeepAt = now; // more than a week: the rest is forgiven
    if (this.config.upkeepCatchUp && (n || !this.db.meta('upkeepAt'))) this.db.setMeta('upkeepAt', this.upkeepAt);
  }

  schedule(delay, fn) {
    this.timers.push({ at: this.time + delay, fn });
  }

  #runTimers() {
    if (!this.timers.length) return;
    const due = [];
    this.timers = this.timers.filter((t) => (t.at <= this.time ? (due.push(t), false) : true));
    for (const t of due) {
      try {
        t.fn();
      } catch (err) {
        this.log.error('[timer]', err);
      }
    }
  }

  /** One tick of the whole world. */
  step() {
    this.tick++;
    this.time = this.tick * TICK_DT;
    const now = Date.now();
    const prof = this.prof;
    prof.begin();
    this.#runTimers();
    prof.mark('timers');
    for (const p of this.players.values()) players.update(this, p, now);
    this.reindexPlayers();
    prof.mark('players');
    enemies.update(this, TICK_DT, now);
    if (this.tick % 15 === 0) enemies.spawn(this, now);
    this.reindexEnemies();
    abilities.updateAllies(this, TICK_DT);
    pals.update(this, TICK_DT);
    horses.update(this, TICK_DT, now);
    prof.mark('enemies');
    combat.updateProjectiles(this, TICK_DT, now);
    combat.updateAreas(this, TICK_DT, now);
    loot.updatePickups(this, TICK_DT, now);
    building.update(this, TICK_DT, now);
    markets.update(this, TICK_DT);
    workers.update(this, TICK_DT);
    army.update(this, TICK_DT);
    this.#recordHistory();
    prof.mark('world');
    sendSnapshots(this, now);
    prof.mark('snapshots');
    this.#rollingSave(now);
    if (this.tick % TICK_RATE === 7) clans.sendMates(this);
    if (this.tick % (TICK_RATE * 30) === 0) this.#worldChores(now);
    prof.mark('chores');
    prof.end();
  }

  // --- Sessions -------------------------------------------------------------------------

  /**
   * Puts an account in the world (or wakes its sleeping body). `conn` is
   * the connection; returns the player.
   */
  join(account, conn) {
    let p = this.byAccount.get(account.id);
    if (p?.conn) {
      p.conn.kick('Du loggade in från ett annat ställe');
      p.conn = null;
    }
    if (p) {
      // Woke up in time: back in control of the sleeping body.
      p.asleep = false;
      p.asleepUntil = 0;
      p.queue.length = 0;
      p.view = { known: new Map(), chunks: new Set(), pinfo: new Map(), dna: new Set(), lastChunk: null };
      p.events = [];
    } else {
      let ch = this.db.character(account.id);
      if (!ch) {
        // A new adventurer: an iron sword to start with, like in single player.
        ch = players.newCharacter(account.id);
        const starter = loot.generate(this, {
          level: 1, source: 'starter', minRarity: 'common', maxRarity: 'common', craft: { archetype: 'sword', material: 'iron' },
        });
        ch.loadout.equipped = starter.id;
        this.db.tx(() => {
          this.db.saveCharacter(ch);
          this.db.insertItem({ id: starter.id, ownerId: account.id, place: 'bag', dna: starter, source: 'starter' });
        });
      }
      p = players.createPlayer(this, account, ch, this.db.itemsOf(account.id));
      this.players.set(p.id, p);
      this.byAccount.set(account.id, p);
    }
    p.conn = conn;
    p.name = account.name;
    const admins = this.config.admins.map((a) => a.toLowerCase());
    p.isAdmin = Boolean(this.config.devAdmins) || admins.includes(account.id.toLowerCase())
      || Boolean(account.email && admins.includes(account.email.toLowerCase()))
      // A player name works too (names can't contain @ or :, so never clash with the above).
      || admins.includes(String(account.name ?? '').toLowerCase())
      // `npm run share`: whoever plays at the server's own computer runs it.
      || Boolean(this.config.localAdmin && conn?.local);
    p.lastQueued = 0;
    p.lastSeq = 0;
    p.credits = 4;
    p.meDirty = true;
    p.infoRev++;
    this.db.touchAccount(account.id, account.email);
    clans.memberJoined(this, account.id);
    pals.sync(this, p);
    horses.joined(this, p);
    return p;
  }

  /** The connection closed. In the wild your body stays a while (no combat logging). */
  disconnect(p) {
    if (!p || !this.running) return; // shutting down: everything was saved already
    p.conn = null;
    p.queue.length = 0;
    p.moving = false;
    clans.memberLeft(this, p.accountId);
    this.db.touchAccount(p.accountId);
    try {
      players.persist(this, p);
    } catch (err) {
      this.log.error('[save] on disconnect', err);
    }
    if (p.dead || inSafeZone(this.rules, p.x, p.y) || this.rules.sleepSeconds <= 0) {
      this.removePlayer(p);
      return;
    }
    p.asleep = true;
    p.asleepUntil = Date.now() + this.rules.sleepSeconds * 1000;
    p.infoRev++;
  }

  removePlayer(p) {
    if (p.conn) return;
    try {
      players.persist(this, p);
    } catch (err) {
      this.log.error('[save] on remove', err);
    }
    this.players.delete(p.id);
    if (this.byAccount.get(p.accountId) === p) this.byAccount.delete(p.accountId);
  }

  // --- Lag compensation ---------------------------------------------------------------

  #recordHistory() {
    const slot = this.tick % HISTORY;
    const record = (e) => {
      if (!e.hist) e.hist = { tick: new Int32Array(HISTORY).fill(-1), x: new Float64Array(HISTORY), y: new Float64Array(HISTORY) };
      e.hist.tick[slot] = this.tick;
      e.hist.x[slot] = e.x;
      e.hist.y[slot] = e.y;
    };
    for (const p of this.players.values()) record(p);
    for (const e of this.enemies.values()) record(e);
  }

  /**
   * Where `e` was at `tick` (what a client was looking at when it attacked).
   * Never more than 200 ms back, so a laggy client can't shoot into the past.
   */
  positionAt(e, tick) {
    const t = Math.max(tick, this.tick - 6);
    if (t >= this.tick || !e.hist) return { x: e.x, y: e.y };
    const slot = t % HISTORY;
    if (e.hist.tick[slot] !== t) return { x: e.x, y: e.y };
    return { x: e.hist.x[slot], y: e.hist.y[slot] };
  }

  // --- Spatial queries -------------------------------------------------------------------

  // Nearby queries use the spatial grids, except when scanning the list is
  // cheaper (few players, or a radius that covers many cells).

  *playersNear(x, y, r) {
    const r2 = r * r;
    const scan = this.playerGrid.cellsFor(r) > this.players.size;
    const source = scan ? this.players.values() : this.playerGrid.near(x, y, r);
    for (const p of source) {
      if (!scan && this.players.get(p.id) !== p) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy <= r2) yield p;
    }
  }

  *enemiesNear(x, y, r) {
    const r2 = r * r;
    const scan = this.enemyGrid.cellsFor(r) > this.enemies.size;
    const source = scan ? this.enemies.values() : this.enemyGrid.near(x, y, r);
    for (const e of source) {
      if (e.dead || (!scan && this.enemies.get(e.id) !== e)) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      if (dx * dx + dy * dy <= r2) yield e;
    }
  }

  nearestPlayer(x, y, r, pred = null) {
    let best = null;
    let bestD = r * r;
    const consider = (p) => {
      if (p.dead || (pred && !pred(p))) return;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    if (this.playerGrid.cellsFor(r) > this.players.size) {
      for (const p of this.players.values()) consider(p);
    } else {
      this.playerGrid.each(x, y, r + PAD, (p) => {
        if (this.players.get(p.id) === p) consider(p);
      });
    }
    return best;
  }

  /** Brings the spatial indexes up to date (players and monsters move every tick). */
  reindexPlayers() {
    this.playerGrid.rebuild(this.players.values());
  }

  reindexEnemies() {
    this.enemyGrid.rebuild(this.enemies.values(), (e) => !e.dead);
  }

  // --- Clans / claims -------------------------------------------------------------------

  clanOf(accountId) {
    const id = this.memberOf.get(accountId);
    return id ? this.clans.get(id) ?? null : null;
  }

  /** Claims (banners) as { clanId, x, y, sid }. */
  claims() {
    const out = [];
    for (const st of this.structures.values()) {
      if (st.id === 'banner' && st.clanId) out.push({ clanId: st.clanId, x: st.x + 0.5, y: st.y + 0.5, sid: st.sid });
    }
    return out;
  }

  /** Is this clan's base open to raids right now? */
  raidState(clanId, now = Date.now()) {
    const clan = this.clans.get(clanId);
    if (!clan) return { raidable: true, reason: 'abandoned' };
    let online = 0;
    for (const id of clan.members.keys()) if (this.byAccount.get(id)?.conn) online++;
    return raidState(this.rules, { online, lastOnlineAt: clan.lastOnlineAt }, now, this.raidWindows);
  }

  // --- Messaging -------------------------------------------------------------------------

  send(p, msg) {
    p.conn?.sendJson(msg);
  }

  toast(p, text, kind = 'info') {
    this.send(p, { t: 'toast', text, kind });
  }

  broadcast(msg, pred = () => true) {
    for (const p of this.players.values()) if (p.conn && pred(p)) p.conn.sendJson(msg);
  }

  /** Sends to everyone who has chunk (cx, cy) loaded. */
  broadcastChunk(cx, cy, msg) {
    const key = `${cx},${cy}`;
    this.chunkCache.delete(key);
    for (const p of this.players.values()) if (p.conn && p.view.chunks.has(key)) p.conn.sendJson(msg);
  }

  broadcastTile(tx, ty, msg) {
    this.broadcastChunk(Math.floor(tx / CHUNK), Math.floor(ty / CHUNK), msg);
  }

  /** A one-off visual/audio event for everyone who can see (x, y). */
  event(x, y, ev, radius = 30) {
    ev.tick = this.tick;
    for (const p of this.players.values()) {
      if (!p.conn) continue;
      if ((p.x - x) ** 2 + (p.y - y) ** 2 > radius * radius) continue;
      p.events.push(ev);
    }
  }

  // --- World --------------------------------------------------------------------------------

  /**
   * The chunk's world data as a JSON string, cached: many players load the
   * same chunks. Anything that changes a chunk goes out through
   * broadcastChunk(), which drops its cached copy (and copies expire anyway,
   * for things that change on a timer, like chests refilling).
   */
  chunkJson(cx, cy) {
    const key = `${cx},${cy}`;
    const now = Date.now();
    const hit = this.chunkCache.get(key);
    if (hit && hit.until > now) return hit.json;
    const json = JSON.stringify(this.chunkPayload(cx, cy));
    if (this.chunkCache.size > 3000) this.chunkCache.clear();
    this.chunkCache.set(key, { json, until: now + 60 * 1000 });
    return json;
  }

  /** World data for one chunk, as the client needs it. */
  chunkPayload(cx, cy) {
    const chunk = this.world.getChunk(cx, cy);
    // Cut trees and rocks: [x, y, seconds since cut] (the client draws them growing back).
    const harvested = [];
    const now = Date.now();
    for (const [i, [at]] of chunk.cut) {
      harvested.push([cx * CHUNK + (i % CHUNK), cy * CHUNK + ((i / CHUNK) | 0), Math.max(0, Math.round((now - at) / 1000))]);
    }
    const structures = [];
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = cx * CHUNK + lx;
        const y = cy * CHUNK + ly;
        const k = tileKey(x, y);
        const f = this.world.floors.get(k);
        const s = this.world.structures.get(k);
        if (f) structures.push(building.structurePayload(f, this));
        if (s) structures.push(building.structurePayload(s, this));
      }
    }
    // Chests and shrines (shared), and the points of interest and sites to
    // explore (each player's own: the client knows what you have found).
    const objects = chunk.objects
      .filter((o) => o.type === 'chest' || o.type === 'shrine' || isPoi(o.type))
      .map((o) => ({ type: o.type, key: o.key, x: o.x, y: o.y, rich: o.rich ?? false, used: this.objectUsed(o.key) }));
    const altars = chunk.objects.filter((o) => o.type === 'altar').map((o) => ({ key: o.key, spent: this.altarSpent(o.key) }));
    return { t: 'chunk', cx, cy, harvested, structures, objects, altars };
  }

  objectUsed(key) {
    const m = this.marks.get(key);
    return Boolean(m && (!m.until || m.until > Date.now()));
  }

  altarSpent(key) {
    return this.marks.get(key)?.kind === 'altar';
  }

  setMark(key, kind, until = null) {
    this.chunkCache.clear(); // altars and chests show in chunk data
    this.marks.set(key, { key, kind, at: Date.now(), until });
    this.db.setMark(key, kind, until);
  }

  /** A tree or rock was cut down. */
  removeBlock(tx, ty) {
    const id = this.world.removeBlock(tx, ty);
    if (!id) return 0;
    const [at] = this.world.harvested[`${tx},${ty}`];
    this.db.addHarvested(tx, ty, id, at);
    this.broadcastTile(tx, ty, { t: 'wd', k: 'cut', x: tx, y: ty });
    return id;
  }

  #worldChores(now) {
    this.#upkeep(now);
    // Trees and rocks grow back (but never under a structure or a player).
    for (const [key, [at, id]] of Object.entries(this.world.harvested)) {
      if (now - at < regrowMinutes(this.data, id) * 60000) continue;
      const [tx, ty] = key.split(',').map(Number);
      if (this.world.structureAt(tx, ty) || this.world.floorAt(tx, ty)) continue;
      let blocked = false;
      for (const p of this.playersNear(tx + 0.5, ty + 0.5, 1.4)) blocked = blocked || Boolean(p);
      for (const e of this.enemiesNear(tx + 0.5, ty + 0.5, 1.2)) blocked = blocked || Boolean(e);
      if (blocked) continue;
      // Inside a claim the ground stays cleared (that's where you build).
      if (building.claimFor(this, tx, ty)) continue;
      this.world.restoreBlock(tx, ty);
      this.db.removeHarvested(tx, ty);
      this.broadcastTile(tx, ty, { t: 'wd', k: 'grow', x: tx, y: ty });
    }
    // Chests refill.
    for (const [key, m] of this.marks) {
      if (m.until && m.until <= now) {
        this.marks.delete(key);
        this.db.deleteMark(key);
      }
    }
    // Keep only chunks someone is near.
    this.world.prune(this.tick);
  }

  // --- Persistence -----------------------------------------------------------------------------

  /** Everything, now (shutting down, going to sleep). */
  saveAll() {
    try {
      this.db.tx(() => {
        for (const p of this.players.values()) players.persist(this, p);
        this.#saveWorldParts();
      });
    } catch (err) {
      this.log.error('[save] failed', err);
    }
  }

  /** Clans and structure damage (players are saved a few at a time, every tick). */
  saveWorld() {
    try {
      this.db.tx(() => this.#saveWorldParts());
    } catch (err) {
      this.log.error('[save] failed', err);
    }
  }

  #saveWorldParts() {
    building.persistDamage(this);
    for (const c of this.clans.values()) if (c.dirty) {
      this.db.saveClan(c);
      c.dirty = false;
    }
  }

  /**
   * Saves the players whose last save is oldest, a few per tick, so each is
   * saved about every saveIntervalMs without one tick doing them all.
   */
  #rollingSave(now) {
    const every = this.config.saveIntervalMs;
    const perTick = Math.max(1, Math.ceil((this.players.size * TICK_MS) / every));
    let done = 0;
    for (const p of this.players.values()) {
      if (done >= perTick) break;
      if (now - (p.lastSave ?? 0) < every) continue;
      try {
        players.persist(this, p);
      } catch (err) {
        this.log.error('[save] player', err);
        p.lastSave = now;
      }
      done++;
    }
  }

  structureDef(id) {
    return structureDef(this.data, id);
  }
}
