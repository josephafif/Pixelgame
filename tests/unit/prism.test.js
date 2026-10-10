// The far lands and Prism Barrens: where they grow (and where they never
// do), how old worlds keep their land, the laser fields and the relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, T, CHUNK, FAR_MIN, WORLD_GEN, legacyFromExplored } from '../../src/game/world.js';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import { laserField, LASER_WIDTH } from '../../src/game/lasers.js';
import { relayFor } from '../../src/game/construction.js';
import { segmentDist2 } from '../../src/core/math.js';
import { loadData } from './helpers.js';

const data = loadData();

function prismTiles(w, r0, r1) {
  let n = 0;
  for (let r = r0; r < r1; r += 6) {
    for (let a = 0; a < 120; a++) {
      const x = Math.cos((a / 120) * Math.PI * 2) * r;
      const y = Math.sin((a / 120) * Math.PI * 2) * r;
      if (w.biomeAt(x, y).id === 'prism') n++;
    }
  }
  return n;
}

test('far lands: one sure region of each kind a long walk out, never near the camp', () => {
  for (const seed of [1, 42, 4242]) {
    const w = new World(data, seed);
    assert.equal(w.gen, WORLD_GEN);
    const ids = w.farRegions.map((r) => r.id).sort();
    assert.deepEqual(ids, ['fen', 'prism', 'skyreach'], `seed ${seed}: one region of each`);
    for (const r of w.farRegions) assert.ok(Math.hypot(r.x, r.y) > FAR_MIN + 40, 'far out');
    const prism = w.farRegions.find((r) => r.id === 'prism');
    assert.equal(w.biomeAt(prism.x, prism.y).id, 'prism', 'the sure region is Prism Barrens');
    assert.equal(prismTiles(w, 0, FAR_MIN), 0, 'nothing of it near the camp');
    // Its land: pale sand and crystals (some of them mirrors), no water.
    const cx = Math.floor(prism.x / CHUNK);
    const cy = Math.floor(prism.y / CHUNK);
    const chunk = w.getChunk(cx, cy);
    const blocks = new Set(chunk.block);
    assert.ok([...chunk.ground].some((g) => g === T.PRISMSAND || g === T.PRISMGLASS));
    assert.ok(blocks.has(T.PRISM) || blocks.has(T.MIRROR));
    assert.ok(!blocks.has(T.WATER));
  }
});

test('an old world (version 1) has no far lands; land seen before the upgrade keeps its look', () => {
  const old = new World(data, 42, { gen: 1 });
  assert.equal(prismTiles(old, FAR_MIN, 900), 0);
  const fresh = new World(data, 42);
  const r = fresh.farRegions.find((x) => x.id === 'prism');
  const key = `${Math.floor(r.x / CHUNK)},${Math.floor(r.y / CHUNK)}`;
  const kept = new World(data, 42, { legacy: new Map([[key, 1]]) });
  assert.equal(fresh.biomeAt(r.x, r.y).id, 'prism');
  assert.notEqual(kept.biomeAt(r.x, r.y).id, 'prism', 'a chunk seen in version 1 keeps its old land');
  assert.equal(kept.biomeAt(r.x, r.y).id, old.biomeAt(r.x, r.y).id, 'exactly as it was');
});

test('saves: an old save is upgraded and remembers what was explored before', () => {
  const save = createNewSave({ worldSeed: 5 });
  assert.equal(save.world.gen, WORLD_GEN);
  assert.deepEqual(save.world.genMarks, []);
  // An old save: no version, three chunks explored.
  const old = JSON.parse(JSON.stringify(save));
  delete old.world.gen;
  delete old.world.genMarks;
  old.world.explored = ['1,1', '2,1', '30,30'];
  const up = fillDefaults(old);
  assert.equal(up.world.gen, WORLD_GEN);
  assert.deepEqual(up.world.genMarks, [[1, 3]]);
  up.world.explored.push('31,30');
  const legacy = legacyFromExplored(up.world.explored, up.world.genMarks);
  assert.equal(legacy.get('30,30'), 1);
  assert.equal(legacy.has('31,30'), false, 'explored after the upgrade: the new land');
  // Loading it again changes nothing.
  assert.deepEqual(fillDefaults(up).world.genMarks, [[1, 3]]);
  assert.equal(up.resources.prismite, 0);
});

test('laser fields: parallel beams with room to stand between them', () => {
  for (const phase of [1, 2]) {
    let k = 0;
    const rng = () => [0.3, 0.7, 0.1, 0.9][k++ % 4];
    const beams = laserField(10, 10, phase, rng);
    assert.ok(beams.length >= 4);
    // Somewhere near the target no beam reaches.
    let safe = false;
    for (let dy = -2; dy <= 2 && !safe; dy += 0.25) {
      for (let dx = -2; dx <= 2 && !safe; dx += 0.25) {
        safe = beams.every((b) => segmentDist2(10 + dx, 10 + dy, b.x, b.y, b.x2, b.y2) > (LASER_WIDTH + 0.32) ** 2);
      }
    }
    assert.ok(safe, `phase ${phase}: a gap within two tiles`);
  }
});

test('Prism Barrens content: monsters, an elite, a boss with laser fields, materials and a relay', () => {
  const biome = data.byId.biomes.get('prism');
  assert.ok(biome.far);
  assert.ok(biome.enemies.length >= 3);
  assert.ok(biome.enemies.some((id) => data.byId.enemies.get(id).elite), 'an elite kind');
  const boss = data.bosses.find((b) => b.biome === 'prism');
  assert.ok(boss.far && boss.patterns.includes('lasers'));
  assert.ok(data.gathering.harvest.prism.drops.prismite, 'crystals give Prismite');
  assert.ok(data.byId.abilities.get('prism_split'), 'Prism Split');
  assert.ok(data.components.find((c) => c.unlocks?.abilities?.includes('prism_split')), 'something teaches it');
  const relay = data.building.structures.find((s) => s.id === 'prism_relay');
  assert.ok(relay.blueprint && relay.relay.split);
});

test('a Prism Relay next to a turret boosts it (only its own clan\'s, in multiplayer)', () => {
  const relayDef = data.building.structures.find((s) => s.id === 'prism_relay');
  const turret = { x: 5, y: 5, clanId: 'a' };
  const at = new Map([['6,5', { def: relayDef, clanId: 'a' }]]);
  const world = { structureAt: (x, y) => at.get(`${x},${y}`) ?? null };
  assert.equal(relayFor(world, turret), relayDef.relay);
  at.set('6,5', { def: relayDef, clanId: 'b' });
  assert.equal(relayFor(world, turret), null, 'another clan\'s relay does nothing for you');
  assert.equal(relayFor(world, { x: 0, y: 0 }), null, 'none nearby');
});
