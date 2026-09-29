import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeGameData, validateReferences, prepareGameData } from '../../src/data/gamedata.js';
import { buildPool } from '../../src/weapons/pool.js';
import { readJson, loadData } from './helpers.js';

test('shipped game data is valid and fully cross-referenced', () => {
  const { data, errors, skipped } = sanitizeGameData(readJson('data/v1/gamedata.json'));
  assert.deepEqual(errors, []);
  assert.deepEqual(skipped, [], 'the shipped client must understand all shipped data');
  assert.deepEqual(validateReferences(data), []);
});

test('content covers the spec: archetypes, elements, modifiers, abilities', () => {
  const data = loadData();
  const ids = (list) => new Set(list.map((x) => x.id));
  const archetypes = ids(data.archetypes);
  for (const a of ['sword', 'greatsword', 'dagger', 'axe', 'hammer', 'spear', 'scythe', 'mace', 'bow', 'crossbow', 'gun', 'cannon', 'wand', 'staff', 'boomerang', 'chakram', 'orb', 'whip', 'throwing']) {
    assert.ok(archetypes.has(a), a);
  }
  assert.ok(data.archetypes.filter((a) => a.tags.includes('exotic')).length >= 1);
  const els = ids(data.elements);
  for (const e of ['fire', 'ice', 'lightning', 'poison', 'bleed', 'void']) assert.ok(els.has(e), e);
  const mods = new Set(data.modifiers.map((m) => m.name));
  for (const m of ['+Damage', '+Attack Speed', '+Critical Chance', '+Critical Damage', '+Projectile Speed', '+Range',
    'Lifesteal', 'Chain Attack', 'Explosion', 'Piercing', 'Homing', 'Knockback', 'Split Projectile', 'Burning', 'Freezing', 'Shock']) {
    assert.ok(mods.has(m), m);
  }
  const effects = ids(data.effects);
  for (const e of ['flame_arc', 'thunder_strike', 'blood_feast', 'void_edge']) assert.ok(effects.has(e), e);
  const abilities = ids(data.abilities);
  for (const a of ['meteor', 'blink', 'black_hole', 'clone', 'earthquake', 'phoenix']) assert.ok(abilities.has(a), a);
  assert.deepEqual(data.rarities.map((r) => r.modifiers), [[1, 2], [2, 3], [3, 4], [4, 5], [5, 7]]);
  assert.ok(data.bosses.every((b) => data.byId.components.get(b.drop.component)?.boss === b.id), 'each boss drops its own core');
});

test('the base pool can build every rarity without research', () => {
  const data = loadData();
  const pool = buildPool(data, []);
  assert.ok(pool.archetypes.length >= 10);
  for (const a of pool.archetypes) {
    assert.ok(pool.materials.some((m) => m.kinds.some((k) => a.kinds.includes(k))), `${a.id} has a base material`);
  }
});

test('data from an incompatible schema is rejected, unknown primitives are skipped', () => {
  const raw = readJson('data/v1/gamedata.json');
  assert.throws(() => prepareGameData({ ...raw, schemaVersion: 99 }), /schema/);
  const future = structuredClone(raw);
  future.archetypes.push({ ...future.archetypes[0], id: 'laser_sword', attack: { pattern: 'laser' } });
  future.modifiers.push({ ...future.modifiers[0], id: 'timestop', hooks: [{ on: 'hit', do: 'stopTime' }] });
  const { data, skipped } = sanitizeGameData(future);
  assert.ok(skipped.includes('archetype:laser_sword'));
  assert.ok(skipped.includes('modifier:timestop'));
  assert.ok(!data.archetypes.some((a) => a.id === 'laser_sword'));
});

test('a compatible data update can add a new archetype without code changes', () => {
  const raw = structuredClone(readJson('data/v1/gamedata.json'));
  raw.dataVersion = '1.1.0';
  raw.archetypes.push({
    ...raw.archetypes.find((a) => a.id === 'spear'),
    id: 'trident', name: 'Trident', weight: 1000, nouns: ['Trident'], suffixes: ['tide'],
  });
  const data = prepareGameData(raw);
  assert.ok(buildPool(data, []).archetypes.some((a) => a.id === 'trident'));
});
