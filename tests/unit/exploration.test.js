import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, CHUNK, SITE_KINDS } from '../../src/game/world.js';
import {
  POI, chunksAround, unseenPlaces, mapTarget, placeName, mineHaul, guardianKinds, REVEAL,
} from '../../src/game/discoveries.js';
import { loadData } from './helpers.js';

const data = loadData();

test('sites to explore: towers, ruins, mines and runestones all over the world, never in town', () => {
  for (const seed of [42, 1234, 99, 777]) {
    const w = new World(data, seed);
    const sites = w.sitesNear(0, 0, 400);
    assert.ok(sites.length >= 25, `seed ${seed}: plenty of sites (${sites.length})`);
    for (const s of sites) {
      assert.ok(SITE_KINDS.includes(s.type));
      assert.ok(POI[s.type], 'usable like the other points of interest');
      assert.ok(Math.hypot(s.x, s.y) > 70, 'away from the town');
      assert.equal(w.marketAt(s.x, s.y, 2), null, 'not inside a market');
    }
    assert.ok(new Set(sites.map((s) => s.type)).size === 4, 'every kind shows up');
    // Deterministic, and each one stands in its chunk once the chunk is made.
    assert.deepEqual(new World(data, seed).sitesNear(0, 0, 400).map((s) => s.key), sites.map((s) => s.key));
    for (const s of sites.slice(0, 12)) {
      const chunk = w.getChunk(Math.floor(s.x / CHUNK), Math.floor(s.y / CHUNK));
      const o = chunk.objects.find((x) => x.key === s.key);
      assert.ok(o, `${s.key} is in the world`);
      assert.equal(w.blockAt(Math.floor(o.x), Math.floor(o.y)), 0, 'on open ground');
    }
  }
});

test('an old map leads somewhere new: an unseen site or great altar, with the land around it', () => {
  const w = new World(data, 42);
  const explored = new Set(chunksAround(0, 0, 4));
  const list = unseenPlaces(w, explored, [], 0, 0);
  assert.ok(list.length > 5);
  assert.ok(list.every((p, i) => i === 0 || p.d >= list[i - 1].d), 'nearest first');
  assert.ok(list.every((p) => p.d >= 40));
  const t = mapTarget(w, explored, [], 0, 0, () => 0);
  assert.equal(t.key, list[0].key);
  // Once explored (or found), it isn't shown again.
  const after = unseenPlaces(w, new Set([...explored, ...chunksAround(t.x, t.y, REVEAL.map)]), [t.key], 0, 0);
  assert.ok(!after.some((p) => p.key === t.key));
  assert.match(placeName(data, t, true), /\w/);
  // The revealed area is a circle of chunks.
  assert.ok(chunksAround(0, 0, REVEAL.map).length > 70);
});

test('mines and ruins: what they give and who guards them', () => {
  const near = mineHaul(1, () => 0.5);
  const far = mineHaul(10, () => 0.5);
  assert.ok(far.stone > near.stone, 'richer further out');
  assert.equal(mineHaul(1, () => 0.01).shard, true);
  assert.equal(mineHaul(1, () => 0.99).shard, false);
  const forest = data.biomes.find((b) => b.id === 'forest') ?? data.biomes[0];
  const g = guardianKinds(data, forest);
  assert.equal(g.length, 2);
  for (const id of g) assert.ok(data.byId.enemies.get(id), id);
});
