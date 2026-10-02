// SQLite in a Cloudflare Durable Object, behind the same small driver
// interface as node:sqlite (server/db.js), so server/game-db.js runs unchanged.
// Differences handled here: transactions go through transactionSync() (SQL
// BEGIN is not allowed), and PRAGMA user_version is not available, so the
// schema version lives in a table of its own.

export class DoSqlite {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)');
  }

  exec(sql) {
    this.sql.exec(sql);
  }

  run(sql, params) {
    this.sql.exec(sql, ...params);
    // rowsWritten also counts index updates; changes() is what callers mean.
    const r = this.sql.exec('SELECT changes() AS c, last_insert_rowid() AS id').one();
    return { changes: Number(r.c), lastInsertRowid: Number(r.id) };
  }

  get(sql, params) {
    return this.sql.exec(sql, ...params).toArray()[0];
  }

  all(sql, params) {
    return this.sql.exec(sql, ...params).toArray();
  }

  transaction(fn) {
    return this.storage.transactionSync(fn);
  }

  getVersion() {
    return Number(this.sql.exec('SELECT version FROM _schema').toArray()[0]?.version ?? 0);
  }

  setVersion(v) {
    this.sql.exec('DELETE FROM _schema');
    this.sql.exec('INSERT INTO _schema (version) VALUES (?)', Number(v));
  }

  close() {}
}
