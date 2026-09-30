import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, SEA, T, CHUNK } from '../../src/game/world.js';
import { boatDefs, boatBlockers, buildBoat, currentBoat, sailableFor, boatMode } from '../../src/game/sailing.js';
import { POI, nearestTreasure, direction } from '../../src/game/discoveries.js';
import { createNewSave } from '../../src/storage/save.js';
import { loadData } from './helpers.js';

const data = loadData();

function sample(world, R, step) {
  const counts = { land: 0, sea: 0, deep: 0, isle: 0 };
  for (let y = -R; y <= R; y += step) {
    for (let x = -R; x <= R; x += step) {
      const s = world.seaAt(x, y);
      if (s >= SEA.SHALLOW) counts.sea++;
      if (s === SEA.DEEP) counts.deep++;
      if (s === SEA.ISLE) counts.isle++;
      if (s === SEA.LAND) counts.land++;
    }
  }
  return counts;
}

test('big seas far out, but always dry land around the camp', () => {
  for (const seed of [1, 777, 12345, 4242]) {
    const w = new World(data, seed);
    for (let a = 0; a < 64; a++) {
      for (const r of [0, 40, 100, 165]) {
        assert.equal(w.seaAt(Math.cos(a) * r, Math.sin(a) * r), SEA.LAND, `seed ${seed}: land at ${r}`);
      }
    }
    const c = sample(w, 1500, 10);
    const total = Object.values(c).reduce((s, n) => s + n, 0);
    assert.ok(c.sea / total > 0.12 && c.sea / total < 0.6, `seed ${seed}: sea ${c.sea / total}`);
    assert.ok(c.deep > 0, 'some open (deep) sea');
    assert.ok(c.isle > 0, 'some islands');
  }
});

test('sea tiles are water a boat can float on; islands are their own biome', () => {
  const w = new World(data, 12345);
  let shallow = null;
  let deep = null;
  let isle = null;
  for (let y = -1400; y <= 1400 && !(shallow && deep && isle); y += 7) {
    for (let x = -1400; x <= 1400; x += 7) {
      const s = w.seaAt(x + 0.5, y + 0.5);
      if (s === SEA.SHALLOW && !shallow) shallow = { x, y };
      if (s === SEA.DEEP && !deep) deep = { x, y };
      if (s === SEA.ISLE && !isle) isle = { x, y };
    }
  }
  assert.ok(shallow && deep && isle);
  assert.equal(w.blockAt(Math.floor(shallow.x), Math.floor(shallow.y)), T.SEA);
  assert.equal(w.blockAt(Math.floor(deep.x), Math.floor(deep.y)), T.DEEP);
  assert.equal(w.biomeAt(isle.x, isle.y).id, 'isles');
  // You can't walk on the sea; a raft floats on the coast but not the open sea.
  assert.ok(w.blockedFor(Math.floor(shallow.x), Math.floor(shallow.y), 'player'));
  assert.ok(!w.blockedFor(Math.floor(shallow.x), Math.floor(shallow.y), 'raft'));
  assert.ok(w.blockedFor(Math.floor(deep.x), Math.floor(deep.y), 'raft'));
  assert.ok(!w.blockedFor(Math.floor(deep.x), Math.floor(deep.y), 'boat'));
  // Boats never sail onto land.
  assert.ok(w.blockedFor(0, 0, 'boat'));
  // Tiles and the sea test always agree (the shore prompt depends on it).
  let checked = 0;
  for (let y = shallow.y - 40; y <= shallow.y + 40; y++) {
    for (let x = shallow.x - 40; x <= shallow.x + 40; x++) {
      const b = w.blockAt(x, y);
      assert.equal(b === T.SEA || b === T.DEEP, w.isSea(x + 0.3, y + 0.8), `tile ${x},${y}`);
      checked++;
    }
  }
  assert.ok(checked > 6000);
});

test('boss arenas are spread far apart; all but the last on the mainland', () => {
  for (const seed of [1, 777, 12345, 4242, 99, 5, 31337, 2024]) {
    const w = new World(data, seed);
    const d = w.landmarks.map((lm) => Math.hypot(lm.x, lm.y));
    assert.ok(d[0] >= 140 && d[0] <= 160, `first boss a good walk away (${d[0]})`);
    for (let i = 1; i < d.length; i++) assert.ok(d[i] > d[i - 1] + 60, 'each boss further out');
    for (const lm of w.landmarks) assert.equal(w.seaAt(lm.x, lm.y), SEA.LAND, 'the arena itself is dry');
    for (const lm of w.landmarks.slice(0, -1)) {
      for (let a = 0; a < 16; a++) {
        const x = lm.x + Math.cos(a) * 26;
        const y = lm.y + Math.sin(a) * 26;
        assert.ok(w.seaAt(x, y) < SEA.SHALLOW, `seed ${seed}: ${lm.bossId} is on the mainland`);
      }
    }
  }
});

test('every boss has its own shape, patterns and a tip', () => {
  const sigs = new Set();
  for (const b of data.bosses) {
    assert.ok(b.patterns.length >= 4, b.id);
    assert.ok(b.tip, `${b.id} has a tip`);
    sigs.add([...new Set(b.patterns)].sort().join(','));
    assert.equal(b.drop.minRarity, 'rare', 'boss drops are not guaranteed epics');
  }
  assert.equal(sigs.size, data.bosses.length, 'no two bosses fight the same way');
});

test('markets stand on dry land, never on the sea or an island', () => {
  const w = new World(data, 12345);
  let n = 0;
  for (let mx = -12; mx <= 12; mx++) {
    for (let my = -12; my <= 12; my++) {
      const m = w.marketForCell(mx, my);
      if (!m) continue;
      n++;
      for (let a = 0; a < 12; a++) assert.equal(w.seaAt(m.x + Math.cos(a) * 11, m.y + Math.sin(a) * 11), SEA.LAND, m.id);
    }
  }
  assert.ok(n > 5);
});

test('three boats: each better, built in order with materials and essence', () => {
  const defs = boatDefs(data);
  assert.equal(defs.length, 3);
  for (let i = 1; i < defs.length; i++) {
    assert.ok(defs[i].speed > defs[i - 1].speed, 'faster');
    assert.ok(defs[i].cost.essence > defs[i - 1].cost.essence, 'dearer');
  }
  assert.equal(defs[0].openSea, false, 'the raft stays near the coast');
  assert.ok(defs[1].openSea && defs[2].openSea);
  assert.ok(defs[2].armor > defs[1].armor);
  for (const d of defs) assert.ok(d.cost.wood > 0 && d.cost.essence > 0, 'wood and essence');

  const save = createNewSave({ worldSeed: 1 });
  assert.equal(currentBoat(data, save), null);
  assert.ok(boatBlockers(data, save, defs[0]).some((b) => /Forge/.test(b)));
  save.base.buildings.forge = 5;
  Object.assign(save.resources, { wood: 10000, stone: 10000, scrap: 10000, essence: 10000 });
  assert.ok(boatBlockers(data, save, defs[1]).some((b) => /previous boat/.test(b)));
  buildBoat(data, save, 1);
  assert.equal(currentBoat(data, save).id, 'raft');
  assert.equal(boatMode(currentBoat(data, save)), 'raft');
  assert.equal(save.resources.wood, 10000 - defs[0].cost.wood);
  buildBoat(data, save, 2);
  assert.throws(() => buildBoat(data, save, 3), /boss/);
  save.bosses.defeated.inferno_titan = 1;
  buildBoat(data, save, 3);
  assert.equal(boatMode(currentBoat(data, save)), 'boat');
});

test('rafts cannot enter deep water, ships can', () => {
  const w = new World(data, 12345);
  const raft = boatDefs(data)[0];
  const ship = boatDefs(data)[1];
  let deep = null;
  for (let y = -1400; y <= 1400 && !deep; y += 11) {
    for (let x = -1400; x <= 1400; x += 11) if (w.seaAt(x + 0.5, y + 0.5) === SEA.DEEP) { deep = { x, y }; break; }
  }
  assert.ok(deep);
  assert.equal(sailableFor(w, deep.x, deep.y, raft), false);
  assert.equal(sailableFor(w, deep.x, deep.y, ship), true);
});

test('curiosities are scattered around the world, and a bottle leads to real treasure', () => {
  const w = new World(data, 12345);
  const counts = {};
  for (let cy = -20; cy <= 20; cy++) {
    for (let cx = -20; cx <= 20; cx++) {
      for (const o of w.getChunk(cx, cy).objects) counts[o.type] = (counts[o.type] ?? 0) + 1;
    }
    w.prune(1e9);
  }
  for (const type of ['bones', 'signpost', 'camp', 'mushrooms']) assert.ok(counts[type] > 0, `${type} exists (${counts[type]})`);
  assert.ok(counts.bones < 200, 'small things stay small in number');
  for (const type of Object.keys(POI)) assert.ok(POI[type].label);

  const save = createNewSave({ worldSeed: 12345 });
  const t = nearestTreasure(w, save, 0, 0);
  assert.ok(t, 'a treasure somewhere');
  assert.equal(w.seaAt(t.x, t.y), SEA.ISLE, 'buried on an island');
  const chunk = w.getChunk(Math.floor(t.x / CHUNK), Math.floor(t.y / CHUNK));
  assert.ok(chunk.objects.some((o) => o.type === 'treasure' && o.key === t.key), 'and it is really there');
  assert.equal(w.blockAt(t.tx, t.ty), 0, 'nothing grows on top of it');
  save.world.found.push(t.key);
  const next = nearestTreasure(w, save, 0, 0);
  assert.notEqual(next?.key, t.key, 'dug-up treasure is skipped');
  assert.equal(direction(0, 0, 10, 0), 'east');
  assert.equal(direction(0, 0, 0, -10), 'north');
});
