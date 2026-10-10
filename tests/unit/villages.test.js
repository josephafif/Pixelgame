import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, T, MARKET_CELL } from '../../src/game/world.js';
import { villageLayout, villageRoute, villagerTarget, VILLAGE_RADIUS } from '../../src/game/villages.js';
import { marketLayout, marketDef } from '../../src/game/markets.js';
import { createRng } from '../../src/core/rng.js';
import { loadData } from './helpers.js';

const data = loadData();

function villagesOf(world, n = 8) {
  const out = [];
  for (let mx = -8; mx <= 8 && out.length < n; mx++) {
    for (let my = -8; my <= 8 && out.length < n; my++) {
      const m = world.marketForCell(mx, my);
      if (m?.village) out.push(m);
    }
  }
  return out;
}

test('villages: here and there, a first one near camp, never on a market or boss arena', () => {
  const w = new World(data, 31337);
  const v = w.firstVillage;
  assert.ok(v && v.village, 'a first village near camp');
  assert.ok(Math.hypot(v.x, v.y) > 60 && Math.hypot(v.x, v.y) < 100, `a short walk away (${v.x}, ${v.y})`);
  assert.equal(w.marketById('v:first'), v);
  const f = w.firstMarket;
  assert.notEqual(`${Math.floor(v.x / MARKET_CELL)},${Math.floor(v.y / MARKET_CELL)}`, `${Math.floor(f.x / MARKET_CELL)},${Math.floor(f.y / MARKET_CELL)}`);
  let villages = 0;
  let cells = 0;
  for (let mx = -8; mx <= 8; mx++) {
    for (let my = -8; my <= 8; my++) {
      cells++;
      const m = w.marketForCell(mx, my);
      if (!m?.village) continue;
      villages++;
      for (const lm of w.landmarks) assert.ok(Math.hypot(m.x - lm.x, m.y - lm.y) > 40, 'away from boss arenas');
    }
  }
  assert.ok(villages >= 5 && villages / cells < 0.3, `here and there: ${villages} in ${cells} cells`);
});

test('a village is built from blocks: houses of walls and floors with a doorway, paths, a green and its people', () => {
  const w = new World(data, 99);
  for (const m of villagesOf(w)) {
    const L = marketLayout(m);
    assert.ok(L.houses, 'a village layout');
    assert.ok(L.houses.length >= 4, `${m.name}: ${L.houses.length} houses`);
    const at = new Map();
    for (const s of L.structs) {
      assert.ok(marketDef(data, s.id), `${s.id} is a known block`);
      at.set(`${s.x},${s.y},${marketDef(data, s.id).kind === 'floor' ? 'f' : 't'}`, s.id);
      assert.ok(Math.hypot(s.x, s.y) <= m.r + 0.5, `${s.id} inside the village`);
    }
    for (const hs of L.houses) {
      // Walls all round but one doorway, a floor inside, the doorway facing the green.
      let walls = 0;
      for (let x = hs.x0; x <= hs.x1; x++) for (const y of [hs.y0, hs.y1]) if (at.get(`${x},${y},t`)?.endsWith('_wall')) walls++;
      for (let y = hs.y0 + 1; y < hs.y1; y++) for (const x of [hs.x0, hs.x1]) if (at.get(`${x},${y},t`)?.endsWith('_wall')) walls++;
      const perimeter = 2 * (hs.x1 - hs.x0 + 1) + 2 * (hs.y1 - hs.y0 - 1);
      assert.equal(walls, perimeter - 1, 'walls all round but the doorway');
      assert.equal(at.get(`${hs.door.x},${hs.door.y},t`), undefined, 'the doorway is open');
      assert.ok(at.get(`${hs.inside.x},${hs.inside.y},f`)?.endsWith('_floor'), 'a floor inside');
      assert.ok(L.paths.has(`${hs.out.x},${hs.out.y}`), 'a path starts at the door');
    }
    assert.ok(L.structs.some((s) => s.id === 'village_well'));
    assert.equal(L.npcs.filter((n) => n.role === 'merchant').length, 2);
    assert.ok(L.npcs.filter((n) => n.role === 'villager').length >= 8, 'lots of villagers');
    // Everyone can walk from any house to any other.
    for (const a of L.houses) for (const b of L.houses) assert.ok(villageRoute(L, a.inside.x, a.inside.y, b.inside.x, b.inside.y), 'connected');
  }
});

test('village grounds: dirt paths, no trees, no water; markets and workers keep out', () => {
  const w = new World(data, 2024);
  const m = w.firstVillage;
  const L = w.villageLayout(m);
  for (let y = -m.r; y <= m.r; y++) {
    for (let x = -m.r; x <= m.r; x++) {
      if (Math.hypot(x, y) > m.r) continue;
      assert.equal(w.blockAt(m.x + x, m.y + y), 0, 'nothing blocks the ground');
      if (L.paths.has(`${x},${y}`)) assert.equal(w.tile(m.x + x, m.y + y).ground, T.PATH, 'paths are dirt');
    }
  }
  assert.ok(w.marketAt(m.x + 0.5, m.y + 0.5));
  assert.equal(VILLAGE_RADIUS, m.r);
});

test('villagers walk along the paths to where they are going', () => {
  const w = new World(data, 5);
  const m = w.firstVillage;
  const L = w.villageLayout(m);
  const home = L.houses[0];
  const n = { x: m.x + home.inside.x + 0.5, y: m.y + home.inside.y + 0.5, home: 0, wait: 0, route: null };
  let moved = 0;
  const r = createRng(42);
  const rng = () => r.next();
  for (let i = 0; i < 60 * 60; i++) {
    const t = villagerTarget(L, m, n, 1 / 60, rng);
    if (!t) continue;
    const d = Math.hypot(t.x - n.x, t.y - n.y);
    const step = Math.min(d, 1.1 / 60);
    n.x += ((t.x - n.x) / d) * step;
    n.y += ((t.y - n.y) / d) * step;
    moved += step;
    // Never through a wall.
    const tx = Math.floor(n.x - m.x);
    const ty = Math.floor(n.y - m.y);
    assert.ok(!L.structs.some((s) => s.x === tx && s.y === ty && s.id.endsWith('_wall')), 'walks around walls');
  }
  assert.ok(moved > 10, `walked ${moved.toFixed(1)} tiles in a minute`);
});
