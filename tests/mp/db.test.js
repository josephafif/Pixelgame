import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../server/db.js';

test('an item has exactly one owner and failed transfers roll back', () => {
  const db = new Db(':memory:');
  db.createAccount({ id: 'a', name: 'Alfa' });
  db.createAccount({ id: 'b', name: 'Beta' });
  db.insertItem({ id: 'w1', ownerId: 'a', place: 'bag', dna: { id: 'w1', rarity: 'rare' }, source: 'test' });
  // B can't take what A doesn't own any more, and a failed transaction leaves nothing behind.
  db.moveItem('w1', { fromOwner: 'a', toOwner: 'b', place: 'bag' });
  assert.throws(() => db.moveItem('w1', { fromOwner: 'a', toOwner: 'b', place: 'bag' }));
  assert.throws(() => db.tx(() => {
    db.insertItem({ id: 'w2', ownerId: 'a', place: 'bag', dna: { id: 'w2' } });
    db.deleteItem('w1', 'a'); // not A's: throws → w2 is rolled back too
  }));
  assert.equal(db.itemOwner('w2'), null);
  assert.equal(db.itemOwner('w1').owner_id, 'b');
  assert.throws(() => db.insertItem({ id: 'w1', ownerId: 'a', place: 'bag', dna: { id: 'w1' } }), 'ids are unique');
  db.close();
});

test('characters, clans and structures persist', () => {
  const db = new Db(':memory:');
  db.createAccount({ id: 'a', name: 'Alfa' });
  db.saveCharacter({
    accountId: 'a', x: 1, y: 2, hp: 50, level: 3, xp: 10, resources: { wood: 5 }, pickaxe: 1, loadout: { equipped: null },
    spawn: null, playSeconds: 60, firstBoss: false, pvpOptIn: false, deaths: 0, kills: 2, pvpKills: 0, extra: { crafts: 1 },
  });
  assert.equal(db.character('a').resources.wood, 5);
  assert.equal(db.character('a').extra.crafts, 1);
  const id = db.createClan({ name: 'Ulvarna', tag: 'ULV', leaderId: 'a' });
  assert.equal(db.clanNameTaken('ulvarna', 'XX'), true);
  const clans = db.loadClans();
  assert.equal(clans[0].members.get('a').role, 'leader');
  const sid = db.insertStructure({ clanId: id, id: 'wood_wall', x: 5, y: 6, layer: 'top', hp: 120, builtBy: 'a' });
  assert.throws(() => db.insertStructure({ clanId: id, id: 'wood_wall', x: 5, y: 6, layer: 'top', hp: 120 }));
  db.deleteClan(id);
  assert.equal(db.loadStructures().find((s) => s.sid === sid).clanId, null);
  db.close();
});

test('a database from before passwords is upgraded in place', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'pg-db-'));
  const file = join(dir, 'old.db');
  try {
    // Make it look like the first version: no password column.
    let db = new Db(file);
    db.createAccount({ id: 'guest:0123456789abcdef01234567', name: 'Gamla' });
    db.close();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE accounts DROP COLUMN pass_hash; PRAGMA user_version = 1;');
    raw.close();
    db = new Db(file);
    const acc = db.accountByName('gamla');
    assert.equal(acc.name, 'Gamla', 'old accounts are kept');
    assert.equal(acc.pass_hash, null);
    db.setPassword(acc.id, 'scrypt$1$1$1$x$y');
    assert.equal(db.account(acc.id).pass_hash, 'scrypt$1$1$1$x$y');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
