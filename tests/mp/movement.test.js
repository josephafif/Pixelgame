import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareGameData } from '../../src/data/gamedata.js';
import { World } from '../../src/game/world.js';
import { stepMove, quantizeAxis, inputDirection, TICK_RATE } from '../../src/net/movement.js';

const data = prepareGameData(JSON.parse(readFileSync(new URL('../../data/v1/gamedata.json', import.meta.url), 'utf8')));

test('one second of walking moves exactly the walking speed', () => {
  const world = new World(data, 1234);
  const s = { x: 0.5, y: 2.6, kx: 0, ky: 0 };
  for (let i = 0; i < TICK_RATE; i++) stepMove(world, s, { mx: 127, my: 0, buttons: 0 }, 4.4, 1.6);
  assert.ok(Math.abs(s.x - 4.9) < 1e-9, String(s.x));
});

test('diagonals are not faster and inputs are clamped', () => {
  const d = inputDirection(127, 127);
  assert.ok(Math.abs(Math.sqrt(d.x * d.x + d.y * d.y) - 1) < 1e-12);
  assert.equal(quantizeAxis(5), 127);
  assert.equal(quantizeAxis(-5), -127);
  assert.ok(Object.is(quantizeAxis(-0.001), 0));
});

test('client and server agree bit for bit (prediction)', () => {
  const a = new World(data, 99);
  const b = new World(data, 99, { hideObjects: true });
  const sa = { x: 3.2, y: 4.1, kx: 2, ky: -1 };
  const sb = { ...sa };
  let seed = 7;
  for (let i = 0; i < 600; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const f = { mx: (seed % 255) - 127, my: ((seed >>> 8) % 255) - 127, buttons: seed & 2 };
    stepMove(a, sa, f, 4.4, 1.6);
    stepMove(b, sb, f, 4.4, 1.6);
  }
  assert.deepEqual(sa, sb);
});

test('walls and trees stop you; gates open only for your clan', () => {
  const world = new World(data, 5);
  const gate = { id: 'gate', x: 3, y: 0, clanId: 7 };
  Object.defineProperty(gate, 'def', { value: data.building.structures.find((s) => s.id === 'gate') });
  world.structures.set(3 * 100003 + 0, gate);
  world.gateFilter = (st) => st.clanId === 7;
  assert.equal(world.isFree(3.5, 0.5, 0.32), true);
  world.gateFilter = (st) => st.clanId === 8;
  assert.equal(world.isFree(3.5, 0.5, 0.32), false);
  world.gateFilter = null;
  assert.equal(world.isFree(3.5, 0.5, 0.32), true);
});

test('server (with the secret seed) and clients (without) see the same terrain', () => {
  const server = new World(data, 4242, { secretSeed: 777 });
  const client = new World(data, 4242, { hideObjects: true });
  let chunks = 0;
  // Near the town, out at sea and around islands.
  for (const [ox, oy] of [[0, 0], [20, 5], [-25, 18], [40, -40], [-60, -10]]) {
    for (let cy = oy - 3; cy <= oy + 3; cy++) {
      for (let cx = ox - 3; cx <= ox + 3; cx++) {
        const a = server.getChunk(cx, cy);
        const b = client.getChunk(cx, cy);
        assert.deepEqual(a.block, b.block, `chunk ${cx},${cy}`);
        assert.deepEqual(a.ground, b.ground);
        chunks++;
      }
    }
  }
  assert.ok(chunks > 200);
  // The client never learns where the loot is.
  const loot = (w) => [...w.chunks.values()].flatMap((c) => c.objects).filter((o) => o.type === 'chest' || o.type === 'treasure').length;
  assert.ok(loot(server) > 0);
  assert.equal(loot(client), 0);
});
