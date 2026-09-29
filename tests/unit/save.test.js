import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNewSave, migrateSave, validateSave, exportSave, parseImport, fillDefaults, SaveManager,
  NewerSaveError, SAVE_SCHEMA, SAVE_KEY, BACKUP_KEY,
} from '../../src/storage/save.js';
import { memoryAdapter } from '../../src/storage/db.js';
import { generateWeapon } from '../../src/weapons/generator.js';
import { loadData } from './helpers.js';

const data = loadData();

function saveWithWeapons() {
  const save = createNewSave({ worldSeed: 1234, now: 1 });
  const a = generateWeapon(data, { seed: 1, level: 3 });
  const b = generateWeapon(data, { seed: 2, level: 3, minRarity: 'legendary' });
  save.inventory.bag.push(a);
  save.inventory.storage.push(b);
  save.inventory.equipped = a.id;
  save.components.fire_core = { found: 1, researched: true };
  save.codex.abilities.push(b.ability.id);
  save.resources.essence = 50;
  return save;
}

test('a new save contains everything the spec asks to persist', () => {
  const save = createNewSave({ worldSeed: 99 });
  for (const key of ['player', 'inventory', 'codex', 'components', 'resources', 'settings', 'abilityState', 'bosses']) {
    assert.ok(save[key], key);
  }
  assert.equal(save.schema, SAVE_SCHEMA);
  assert.deepEqual(validateSave(save), []);
});

test('saves with weapons validate; broken weapons are reported', () => {
  const save = saveWithWeapons();
  assert.deepEqual(validateSave(save), []);
  const broken = structuredClone(save);
  delete broken.inventory.bag[0].stats;
  assert.ok(validateSave(broken).length > 0);
  const dangling = structuredClone(save);
  dangling.inventory.equipped = 'nope';
  assert.ok(validateSave(dangling).some((p) => p.includes('equipped')));
});

test('migrations run in order and missing fields get defaults', () => {
  const old = { schema: 0, worldSeed: 5, player: { level: 4 }, inventory: { items: [] } };
  const migrations = {
    0: (s) => ({ ...s, inventory: { bag: s.inventory.items, storage: [], equipped: null } }),
  };
  const { save, migrated, from } = migrateSave(old, migrations, 1);
  assert.equal(migrated, true);
  assert.equal(from, 0);
  assert.equal(save.schema, 1);
  assert.equal(save.player.level, 4);
  assert.equal(save.player.xp, 0, 'defaults filled');
  assert.deepEqual(save.inventory.bag, []);
  assert.equal(save.settings.sprintMode, 'toggle');
  assert.throws(() => migrateSave({ schema: 0, worldSeed: 1 }, {}, 1), /No migration/);
});

test('a save from a newer app version is refused, never overwritten', async () => {
  const storage = memoryAdapter();
  await storage.set(SAVE_KEY, { ...createNewSave({ worldSeed: 1 }), schema: SAVE_SCHEMA + 1 });
  const mgr = new SaveManager(storage);
  await assert.rejects(() => mgr.load(), NewerSaveError);
  assert.equal(mgr.readOnly, true);
  assert.equal(await mgr.write(createNewSave({ worldSeed: 2 })), false);
  assert.equal((await storage.get(SAVE_KEY)).schema, SAVE_SCHEMA + 1);
});

test('SaveManager writes revisions, keeps backups on replace and migration', async () => {
  const storage = memoryAdapter();
  const mgr = new SaveManager(storage, { appVersion: '9.9.9' });
  assert.equal(await mgr.load(), null);
  const save = saveWithWeapons();
  await mgr.write(save);
  await mgr.write(save);
  const stored = await storage.get(SAVE_KEY);
  assert.equal(stored.rev, 2);
  assert.equal(stored.appVersion, '9.9.9');
  assert.deepEqual((await mgr.load()).inventory, save.inventory);
  const fresh = createNewSave({ worldSeed: 777 });
  await mgr.replace(fresh);
  assert.equal((await storage.get(BACKUP_KEY)).worldSeed, 1234);
  assert.equal((await storage.get(SAVE_KEY)).worldSeed, 777);

  const migStorage = memoryAdapter();
  await migStorage.set(SAVE_KEY, { schema: 0, worldSeed: 3 });
  const migMgr = new SaveManager(migStorage, { migrations: { 0: (s) => s } });
  const migrated = await migMgr.load();
  assert.equal(migrated.schema, SAVE_SCHEMA);
  assert.equal((await migStorage.get(BACKUP_KEY)).schema, 0, 'pre-migration backup kept');
});

test('overlapping writes are serialised', async () => {
  const storage = memoryAdapter();
  const mgr = new SaveManager(storage);
  const save = createNewSave({ worldSeed: 1 });
  await Promise.all([mgr.write(save), mgr.write(save), mgr.write(save)]);
  assert.equal((await storage.get(SAVE_KEY)).rev, 3);
});

test('export/import round-trips and rejects tampering', () => {
  const save = saveWithWeapons();
  const text = exportSave(save);
  assert.deepEqual(parseImport(text), fillDefaults(save));
  const tampered = JSON.parse(text);
  tampered.save.resources.essence = 999999;
  assert.throws(() => parseImport(JSON.stringify(tampered)), /checksum/);
  assert.throws(() => parseImport('{"hello":1}'), /not a Pixelgame save/);
  assert.throws(() => parseImport('garbage'), /invalid JSON/);
});
