// The database on a normal server: one SQLite file (node:sqlite, no native
// add-ons). The tables and queries are in game-db.js.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GameDb } from './game-db.js';

// node:sqlite works fine but still prints an "experimental" warning on
// Node 22; keep the server log clean of it.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

class NodeSqlite {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.stmts = new Map();
  }

  #q(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  exec(sql) {
    this.db.exec(sql);
  }

  run(sql, params) {
    const res = this.#q(sql).run(...params);
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  get(sql, params) {
    return this.#q(sql).get(...params);
  }

  all(sql, params) {
    return this.#q(sql).all(...params);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getVersion() {
    return this.db.prepare('PRAGMA user_version').get().user_version;
  }

  setVersion(v) {
    this.db.exec(`PRAGMA user_version = ${Number(v)}`);
  }

  close() {
    this.db.close();
  }
}

export class Db extends GameDb {
  constructor(path) {
    super(new NodeSqlite(path));
  }

  /** Consistent copy of the whole database (safe while the server runs). */
  backup(path) {
    this.driver.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  }
}
