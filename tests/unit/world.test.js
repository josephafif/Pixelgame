import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, CHUNK } from '../../src/game/world.js';
import { computePlayerStats, xpToNext, statSheet } from '../../src/game/stats.js';
import { createNewSave } from '../../src/storage/save.js';
import { generateWeapon } from '../../src/weapons/generator.js';
import { loadData } from './helpers.js';

const data = loadData();

test('the world is deterministic per seed', () => {
  const a = new World(data, 12345).getChunk(3, -2);
  const b = new World(data, 12345).getChunk(3, -2);
  const c = new World(data, 54321).getChunk(3, -2);
  assert.deepEqual([...a.ground], [...b.ground]);
  assert.deepEqual([...a.block], [...b.block]);
  assert.deepEqual(a.objects, b.objects);
  assert.notDeepEqual([...a.ground, ...a.block], [...c.ground, ...c.block]);
});

test('the camp is open ground with every base building, and every boss has an arena', () => {
  const world = new World(data, 777);
  assert.ok(world.isFree(0.5, 1.6, 0.4));
  for (const b of data.base.buildings) {
    assert.ok(world.isFree(b.x, b.y, 0.4), `${b.id} stands on open ground`);
    const cx = Math.floor(b.x / CHUNK);
    const cy = Math.floor(b.y / CHUNK);
    assert.ok(world.getChunk(cx, cy).objects.some((o) => o.type === 'building' && o.buildingId === b.id), b.id);
  }
  assert.equal(world.landmarks.length, data.bosses.filter((b) => !b.far).length);
  for (const lm of world.landmarks) {
    const cx = Math.floor(lm.x / CHUNK);
    const cy = Math.floor(lm.y / CHUNK);
    assert.ok(world.getChunk(cx, cy).objects.some((o) => o.type === 'altar' && o.bossId === lm.bossId));
    assert.equal(world.biomeAt(Math.floor(lm.x), Math.floor(lm.y)).id, lm.biome);
  }
});

test('chunk memory stays bounded while exploring', () => {
  const world = new World(data, 1);
  for (let i = 0; i < 400; i++) world.getChunk(i, i % 7);
  world.prune(1);
  assert.ok(world.chunks.size <= 160);
});

test('player stats: health, speed, attack, defense, crit, luck, resistances — and no stamina', () => {
  const save = createNewSave({ worldSeed: 1 });
  save.player.level = 5;
  const dna = generateWeapon(data, { seed: 3, level: 5, craft: { archetype: 'sword', material: 'iron', core: null } });
  const s = computePlayerStats(data, save, dna);
  for (const k of ['maxHp', 'moveSpeed', 'attackPower', 'defense', 'critChance', 'critDamage', 'luck', 'resist']) assert.ok(k in s, k);
  assert.ok(!('stamina' in s));
  assert.ok(!statSheet(data, s).some(([k]) => /stamina/i.test(k)));
  assert.ok(s.maxHp > data.player.health);
  assert.ok(xpToNext(data, 2) > xpToNext(data, 1));
});
