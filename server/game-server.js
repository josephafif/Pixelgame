// The authoritative game: one shared world, 30 ticks a second. Clients only
// send what they want to do; everything that happens is decided here.

import { randomBytes } from 'node:crypto';
import { World, CHUNK, tileKey } from '../src/game/world.js';
import { TICK_RATE, TICK_DT, TICK_MS } from '../src/net/movement.js';
import { parseRaidWindow, raidState, inSafeZone } from '../src/net/rules.js';
import { structureDef } from '../src/game/construction.js';
import * as players from './players.js';
import * as combat from './combat.js';
import * as enemies from './enemies.js';
import * as loot from './loot.js';
import * as building from './building.js';
import * as clans from './clans.js';
import { sendSnapshots } from './snapshots.js';

const HISTORY = 32; // ticks of positions kept for lag compensation (~1 s)

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
    this.timers = [];
    this.stats = { tickMs: 0, maxTickMs: 0, sent: 0 };

    // The world seed is public (clients generate the terrain themselves);
    // the secret seed places loot and is never sent.
    let seed = Number(db.meta('worldSeed'));
    if (!db.meta('worldSeed')) {
      seed = config.worldSeed ?? randomBytes(4).readUInt32BE(0);
      db.setMeta('worldSeed', seed);
    }
    let secret = Number(db.meta('secretSeed'));
    if (!db.meta('secretSeed')) {
      secret = randomBytes(4).readUInt32BE(0);
      db.setMeta('secretSeed', secret);
    }
    if (!db.meta('guestSecret')) db.setMeta('guestSecret', randomBytes(32).toString('hex'));
    this.worldSeed = seed >>> 0;
    this.world = new World(data, this.worldSeed, { secretSeed: secret >>> 0, maxChunks: 900 });

    // Harvested trees/rocks, spent altars, opened chests.
    for (const h of db.loadHarvested()) this.world.harvested[`${h.x},${h.y}`] = [h.at, h.tile];
    this.marks = new Map(db.loadMarks().map((m) => [m.key, m]));

    // Clans and their bases.
    this.clans = new Map(db.loadClans().map((c) => [c.id, c]));
    this.memberOf = new Map();
    for (const c of this.clans.values()) for (const id of c.members.keys()) this.memberOf.set(id, c.id);
    this.structures = new Map(); // sid → structure
    building.loadStructures(this);
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
    this.saveTimer = setInterval(() => this.saveAll(), this.config.saveIntervalMs);
    this.hourly = setInterval(() => building.upkeep(this), 60 * 60 * 1000);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.saveTimer);
    clearInterval(this.hourly);
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
    this.#runTimers();
    for (const p of this.players.values()) players.update(this, p, now);
    enemies.update(this, TICK_DT, now);
    if (this.tick % 15 === 0) enemies.spawn(this, now);
    combat.updateProjectiles(this, TICK_DT, now);
    combat.updateAreas(this, TICK_DT, now);
    loot.updatePickups(this, TICK_DT, now);
    building.update(this, TICK_DT, now);
    this.#recordHistory();
    sendSnapshots(this, now);
    if (this.tick % (TICK_RATE * 30) === 0) this.#worldChores(now);
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

  *playersNear(x, y, r) {
    const r2 = r * r;
    for (const p of this.players.values()) {
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy <= r2) yield p;
    }
  }

  *enemiesNear(x, y, r) {
    const r2 = r * r;
    for (const e of this.enemies.values()) {
      if (e.dead) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      if (dx * dx + dy * dy <= r2) yield e;
    }
  }

  nearestPlayer(x, y, r, pred = () => true) {
    let best = null;
    let bestD = r * r;
    for (const p of this.players.values()) {
      if (p.dead || !pred(p)) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
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

  /** World data for one chunk, as the client needs it. */
  chunkPayload(cx, cy) {
    const chunk = this.world.getChunk(cx, cy);
    const harvested = [];
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = cx * CHUNK + lx;
        const y = cy * CHUNK + ly;
        if (this.world.harvested[`${x},${y}`]) harvested.push([x, y]);
      }
    }
    const structures = [];
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = cx * CHUNK + lx;
        const y = cy * CHUNK + ly;
        const k = tileKey(x, y);
        const f = this.world.floors.get(k);
        const s = this.world.structures.get(k);
        if (f) structures.push(building.structurePayload(f));
        if (s) structures.push(building.structurePayload(s));
      }
    }
    const objects = chunk.objects
      .filter((o) => o.type !== 'building' && o.type !== 'altar')
      .filter((o) => o.type === 'chest' || o.type === 'shrine')
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
    // Trees and rocks grow back (but never under a structure or a player).
    for (const [key, [at, id]] of Object.entries(this.world.harvested)) {
      const info = loot.harvestInfoFor(this, id);
      if (now - at < (info?.regrowMinutes ?? 20) * 60000) continue;
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

  saveAll() {
    try {
      this.db.tx(() => {
        for (const p of this.players.values()) players.persist(this, p);
        building.persistDamage(this);
        for (const c of this.clans.values()) if (c.dirty) {
          this.db.saveClan(c);
          c.dirty = false;
        }
      });
    } catch (err) {
      this.log.error('[save] failed', err);
    }
  }

  structureDef(id) {
    return structureDef(this.data, id);
  }
}
