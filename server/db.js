// Persistence: one SQLite file (node:sqlite, no native add-ons).
//
// Rules that keep items from ever being duplicated:
//  - every weapon is one row with a unique id and exactly one owner;
//  - anything that moves value between two owners (pick up, drop, trade,
//    death bag, clan vault) is written in ONE transaction before the game
//    tells anyone it happened;
//  - every such move is written to the ledger, so it can be traced.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// node:sqlite works fine but still prints an "experimental" warning on
// Node 22; keep the server log clean of it.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const SCHEMA = [
  // v1
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     name TEXT UNIQUE COLLATE NOCASE,
     email TEXT,
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL DEFAULT 0,
     banned_until INTEGER NOT NULL DEFAULT 0,
     ban_reason TEXT
   );
   CREATE TABLE characters (
     account_id TEXT PRIMARY KEY REFERENCES accounts(id),
     x REAL NOT NULL, y REAL NOT NULL, hp REAL NOT NULL,
     level INTEGER NOT NULL, xp INTEGER NOT NULL,
     resources TEXT NOT NULL,
     pickaxe INTEGER NOT NULL DEFAULT 0,
     loadout TEXT NOT NULL,
     spawn TEXT,
     play_seconds REAL NOT NULL DEFAULT 0,
     first_boss INTEGER NOT NULL DEFAULT 0,
     pvp_opt_in INTEGER NOT NULL DEFAULT 0,
     deaths INTEGER NOT NULL DEFAULT 0,
     kills INTEGER NOT NULL DEFAULT 0,
     pvp_kills INTEGER NOT NULL DEFAULT 0,
     extra TEXT NOT NULL DEFAULT '{}',
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE items (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     place TEXT NOT NULL CHECK (place IN ('bag', 'storage')),
     dna TEXT NOT NULL,
     rarity TEXT,
     source TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX items_owner ON items(owner_id);
   CREATE TABLE clans (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
     created_at INTEGER NOT NULL,
     vault TEXT NOT NULL DEFAULT '{}',
     upkeep TEXT NOT NULL DEFAULT '{}',
     unpaid INTEGER NOT NULL DEFAULT 0,
     last_online_at INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE clan_members (
     account_id TEXT PRIMARY KEY,
     clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     joined_at INTEGER NOT NULL
   );
   CREATE TABLE clan_invites (
     clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
     account_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (clan_id, account_id)
   );
   CREATE TABLE structures (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     clan_id INTEGER,
     def TEXT NOT NULL,
     x INTEGER NOT NULL, y INTEGER NOT NULL,
     layer TEXT NOT NULL,
     hp REAL NOT NULL,
     built_by TEXT,
     built_at INTEGER NOT NULL,
     UNIQUE (layer, x, y)
   );
   CREATE TABLE harvested (
     x INTEGER NOT NULL, y INTEGER NOT NULL,
     tile INTEGER NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (x, y)
   );
   CREATE TABLE world_marks (
     key TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     at INTEGER NOT NULL,
     until INTEGER
   );
   CREATE TABLE ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     account_id TEXT,
     kind TEXT NOT NULL,
     item_id TEXT,
     detail TEXT
   );
   CREATE INDEX ledger_account ON ledger(account_id, at);`,
  // v2: log in with your name and a password (guest servers, `npm run share`).
  'ALTER TABLE accounts ADD COLUMN pass_hash TEXT;',
];

const json = (s, fallback) => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export class Db {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
    this.stmts = new Map();
    this.depth = 0;
  }

  #migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let v = version; v < SCHEMA.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(SCHEMA[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  #q(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  run(sql, ...params) {
    return this.#q(sql).run(...params);
  }

  get(sql, ...params) {
    return this.#q(sql).get(...params);
  }

  all(sql, ...params) {
    return this.#q(sql).all(...params);
  }

  /** Runs fn in one transaction (nested calls join the outer one). */
  tx(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.db.close();
  }

  /** Consistent copy of the whole database (safe while the server runs). */
  backup(path) {
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  }

  // --- Meta ---------------------------------------------------------------------

  meta(key) {
    return this.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  setMeta(key, value) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  // --- Accounts -------------------------------------------------------------------

  account(id) {
    return this.get('SELECT * FROM accounts WHERE id = ?', id) ?? null;
  }

  accountByName(name) {
    return this.get('SELECT * FROM accounts WHERE name = ? COLLATE NOCASE', name) ?? null;
  }

  createAccount({ id, name, email, passHash = null }) {
    this.run('INSERT INTO accounts (id, name, email, created_at, last_seen, pass_hash) VALUES (?, ?, ?, ?, ?, ?)',
      id, name, email ?? null, Date.now(), Date.now(), passHash);
    return this.account(id);
  }

  setPassword(id, passHash) {
    this.run('UPDATE accounts SET pass_hash = ? WHERE id = ?', passHash, id);
  }

  touchAccount(id, email) {
    this.run('UPDATE accounts SET last_seen = ?, email = COALESCE(?, email) WHERE id = ?', Date.now(), email ?? null, id);
  }

  ban(id, until, reason) {
    this.run('UPDATE accounts SET banned_until = ?, ban_reason = ? WHERE id = ?', until, reason ?? null, id);
  }

  // --- Characters -----------------------------------------------------------------

  character(accountId) {
    const row = this.get('SELECT * FROM characters WHERE account_id = ?', accountId);
    if (!row) return null;
    return {
      accountId: row.account_id,
      x: row.x,
      y: row.y,
      hp: row.hp,
      level: row.level,
      xp: row.xp,
      resources: json(row.resources, {}),
      pickaxe: row.pickaxe,
      loadout: json(row.loadout, {}),
      spawn: json(row.spawn, null),
      playSeconds: row.play_seconds,
      firstBoss: Boolean(row.first_boss),
      pvpOptIn: Boolean(row.pvp_opt_in),
      deaths: row.deaths,
      kills: row.kills,
      pvpKills: row.pvp_kills,
      extra: json(row.extra, {}),
    };
  }

  saveCharacter(ch) {
    this.run(`INSERT INTO characters (account_id, x, y, hp, level, xp, resources, pickaxe, loadout, spawn, play_seconds,
        first_boss, pvp_opt_in, deaths, kills, pvp_kills, extra, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET x = excluded.x, y = excluded.y, hp = excluded.hp, level = excluded.level,
        xp = excluded.xp, resources = excluded.resources, pickaxe = excluded.pickaxe, loadout = excluded.loadout,
        spawn = excluded.spawn, play_seconds = excluded.play_seconds, first_boss = excluded.first_boss,
        pvp_opt_in = excluded.pvp_opt_in, deaths = excluded.deaths, kills = excluded.kills,
        pvp_kills = excluded.pvp_kills, extra = excluded.extra, updated_at = excluded.updated_at`,
    ch.accountId, ch.x, ch.y, ch.hp, ch.level, ch.xp, JSON.stringify(ch.resources), ch.pickaxe,
    JSON.stringify(ch.loadout), ch.spawn ? JSON.stringify(ch.spawn) : null, ch.playSeconds,
    ch.firstBoss ? 1 : 0, ch.pvpOptIn ? 1 : 0, ch.deaths, ch.kills, ch.pvpKills, JSON.stringify(ch.extra ?? {}), Date.now());
  }

  // --- Items --------------------------------------------------------------------------

  itemsOf(accountId) {
    return this.all('SELECT id, place, dna FROM items WHERE owner_id = ? ORDER BY created_at', accountId)
      .map((r) => ({ id: r.id, place: r.place, dna: json(r.dna, null) }))
      .filter((r) => r.dna);
  }

  itemOwner(id) {
    return this.get('SELECT owner_id, place FROM items WHERE id = ?', id) ?? null;
  }

  insertItem({ id, ownerId, place, dna, source }) {
    this.run('INSERT INTO items (id, owner_id, place, dna, rarity, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, ownerId, place, JSON.stringify(dna), dna.rarity ?? null, source ?? null, Date.now());
  }

  /** Moves an item; throws if it isn't where the caller thinks it is. */
  moveItem(id, { fromOwner, toOwner, place }) {
    const res = this.run('UPDATE items SET owner_id = ?, place = ? WHERE id = ? AND owner_id = ?', toOwner, place, id, fromOwner);
    if (Number(res.changes) !== 1) throw new Error(`item ${id} is not owned by ${fromOwner}`);
  }

  deleteItem(id, ownerId) {
    const res = this.run('DELETE FROM items WHERE id = ? AND owner_id = ?', id, ownerId);
    if (Number(res.changes) !== 1) throw new Error(`item ${id} is not owned by ${ownerId}`);
  }

  log(accountId, kind, itemId = null, detail = null) {
    this.run('INSERT INTO ledger (at, account_id, kind, item_id, detail) VALUES (?, ?, ?, ?, ?)',
      Date.now(), accountId, kind, itemId, detail === null ? null : JSON.stringify(detail));
  }

  // --- Clans ------------------------------------------------------------------------------

  loadClans() {
    const clans = this.all('SELECT * FROM clans').map((c) => ({
      id: c.id,
      name: c.name,
      tag: c.tag,
      createdAt: c.created_at,
      vault: json(c.vault, {}),
      upkeep: json(c.upkeep, {}),
      unpaid: Boolean(c.unpaid),
      lastOnlineAt: c.last_online_at,
      members: new Map(),
      invites: new Set(),
    }));
    const byId = new Map(clans.map((c) => [c.id, c]));
    for (const m of this.all(`SELECT m.account_id, m.clan_id, m.role, m.joined_at, a.name
        FROM clan_members m JOIN accounts a ON a.id = m.account_id`)) {
      byId.get(m.clan_id)?.members.set(m.account_id, { accountId: m.account_id, name: m.name, role: m.role, joinedAt: m.joined_at });
    }
    for (const i of this.all('SELECT clan_id, account_id FROM clan_invites')) byId.get(i.clan_id)?.invites.add(i.account_id);
    return clans;
  }

  createClan({ name, tag, leaderId }) {
    return this.tx(() => {
      const res = this.run('INSERT INTO clans (name, tag, created_at) VALUES (?, ?, ?)', name, tag, Date.now());
      const id = Number(res.lastInsertRowid);
      this.run('INSERT INTO clan_members (account_id, clan_id, role, joined_at) VALUES (?, ?, ?, ?)', leaderId, id, 'leader', Date.now());
      this.run('DELETE FROM clan_invites WHERE account_id = ?', leaderId);
      return id;
    });
  }

  clanNameTaken(name, tag) {
    return Boolean(this.get('SELECT 1 AS x FROM clans WHERE name = ? COLLATE NOCASE OR tag = ? COLLATE NOCASE', name, tag));
  }

  deleteClan(id) {
    this.tx(() => {
      this.run('DELETE FROM clan_invites WHERE clan_id = ?', id);
      this.run('DELETE FROM clan_members WHERE clan_id = ?', id);
      this.run('UPDATE structures SET clan_id = NULL WHERE clan_id = ?', id);
      this.run('DELETE FROM clans WHERE id = ?', id);
    });
  }

  saveClan(c) {
    this.run('UPDATE clans SET vault = ?, upkeep = ?, unpaid = ?, last_online_at = ? WHERE id = ?',
      JSON.stringify(c.vault), JSON.stringify(c.upkeep), c.unpaid ? 1 : 0, c.lastOnlineAt ?? 0, c.id);
  }

  addMember(clanId, accountId, role) {
    this.tx(() => {
      this.run('INSERT INTO clan_members (account_id, clan_id, role, joined_at) VALUES (?, ?, ?, ?)', accountId, clanId, role, Date.now());
      this.run('DELETE FROM clan_invites WHERE account_id = ?', accountId);
    });
  }

  removeMember(accountId) {
    this.run('DELETE FROM clan_members WHERE account_id = ?', accountId);
  }

  setRole(accountId, role) {
    this.run('UPDATE clan_members SET role = ? WHERE account_id = ?', role, accountId);
  }

  addInvite(clanId, accountId) {
    this.run('INSERT OR IGNORE INTO clan_invites (clan_id, account_id, created_at) VALUES (?, ?, ?)', clanId, accountId, Date.now());
  }

  removeInvite(clanId, accountId) {
    this.run('DELETE FROM clan_invites WHERE clan_id = ? AND account_id = ?', clanId, accountId);
  }

  // --- Structures ----------------------------------------------------------------------------

  loadStructures() {
    return this.all('SELECT * FROM structures').map((r) => ({
      sid: r.id, clanId: r.clan_id, id: r.def, x: r.x, y: r.y, layer: r.layer, hp: r.hp, builtBy: r.built_by,
    }));
  }

  insertStructure({ clanId, id, x, y, layer, hp, builtBy }) {
    const res = this.run('INSERT INTO structures (clan_id, def, x, y, layer, hp, built_by, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      clanId ?? null, id, x, y, layer, hp, builtBy ?? null, Date.now());
    return Number(res.lastInsertRowid);
  }

  deleteStructure(sid) {
    this.run('DELETE FROM structures WHERE id = ?', sid);
  }

  updateStructureHp(sid, hp) {
    this.run('UPDATE structures SET hp = ? WHERE id = ?', hp, sid);
  }

  // --- World ------------------------------------------------------------------------------------

  loadHarvested() {
    return this.all('SELECT x, y, tile, at FROM harvested');
  }

  addHarvested(x, y, tile, at) {
    this.run('INSERT OR REPLACE INTO harvested (x, y, tile, at) VALUES (?, ?, ?, ?)', x, y, tile, at);
  }

  removeHarvested(x, y) {
    this.run('DELETE FROM harvested WHERE x = ? AND y = ?', x, y);
  }

  loadMarks() {
    return this.all('SELECT key, kind, at, until FROM world_marks');
  }

  setMark(key, kind, until = null) {
    this.run('INSERT OR REPLACE INTO world_marks (key, kind, at, until) VALUES (?, ?, ?, ?)', key, kind, Date.now(), until);
  }

  deleteMark(key) {
    this.run('DELETE FROM world_marks WHERE key = ?', key);
  }
}
