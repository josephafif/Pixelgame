// Points of interest in multiplayer: each player finds each one once, and
// what they give is their own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { BTN } from '../../src/net/protocol.js';
import { CHUNK } from '../../src/game/world.js';

function findPoi(gs, types) {
  for (let r = 2; r < 40; r++) {
    for (let cy = -r; cy <= r; cy++) {
      for (let cx = -r; cx <= r; cx++) {
        if (Math.max(Math.abs(cx), Math.abs(cy)) !== r) continue;
        const o = gs.world.getChunk(cx, cy).objects.find((x) => types.includes(x.type));
        if (o) return o;
      }
    }
  }
  return null;
}

test('points of interest: an old campsite heals and gives a stash, once per player', async () => {
  const t = await testServer({ worldSeed: 42 });
  try {
    const a = await t.bot('Vandraren');
    const b = await t.bot('Följaren');
    const o = findPoi(t.gs, ['camp', 'bones', 'wreck']);
    assert.ok(o, 'found a point of interest');
    void CHUNK;
    const pa = t.place(a, o.x, o.y + 0.8);
    pa.hp = 10;
    a.input({ buttons: BTN.INTERACT });
    await sleep(300);
    assert.ok(pa.ch.extra.found.includes(o.key), 'found');
    if (o.type === 'camp') assert.equal(pa.hp, pa.maxHp, 'rested');
    const stash = [...t.gs.pickups.values()].filter((it) => it.owner === pa.id).length;
    assert.ok(stash > 0, 'a stash just for the finder');
    // Again: nothing more for the same player…
    a.input({ buttons: BTN.INTERACT });
    await sleep(300);
    assert.equal(pa.ch.extra.found.filter((k) => k === o.key).length, 1);
    // …but the next adventurer finds it too.
    const pb = t.place(b, o.x, o.y + 0.8);
    b.input({ buttons: BTN.INTERACT });
    await sleep(300);
    assert.ok(pb.ch.extra.found.includes(o.key), 'found by the next player too');
    await a.waitFor((m) => m.t === 'me' && m.found?.includes(o.key));
  } finally {
    await t.close();
  }
});

test('the Waystone: home to your base from the wild, back again, then it recharges', async () => {
  const t = await testServer({ worldSeed: 42 });
  try {
    const a = await t.bot('Resenären');
    // No Waystone of your own: no way home (Fristaden has only a forge now).
    let res = await a.request({ t: 'recall', op: 'go' });
    assert.match(res.error, /vägsten/);
    const { spots } = await t.clanBase(a, { waystone: 2 });
    const p = t.place(a, spots.waystone.x + 140.5, spots.waystone.y + 30.5);
    const from = { x: p.x, y: p.y };
    res = await a.request({ t: 'recall', op: 'go' });
    assert.equal(res.ok, true, res.error);
    assert.ok(Math.hypot(p.x - spots.waystone.x, p.y - spots.waystone.y) < 4, 'home at the Waystone');
    assert.ok(a.json.some((m) => m.t === 'teleport'));
    res = await a.request({ t: 'recall', op: 'go' });
    assert.equal(res.ok, false, 'already home (and recharging)');
    res = await a.request({ t: 'recall', op: 'back' });
    assert.equal(res.ok, true, res.error);
    assert.ok(Math.hypot(p.x - from.x, p.y - from.y) < 2, 'back where you were');
    res = await a.request({ t: 'recall', op: 'go' });
    assert.match(res.error, /laddas om/, 'it recharges');
    // Not in the middle of a fight with another player.
    p.ch.extra.recallAt = 0;
    p.combatUntil = Date.now() + 10000;
    res = await a.request({ t: 'recall', op: 'go' });
    assert.match(res.error, /strid/);
  } finally {
    await t.close();
  }
});

test('research: components drop for you, the library researches them, and the forge and drops use them', async () => {
  const t = await testServer({ worldSeed: 42 });
  try {
    const a = await t.bot('Forskaren');
    const p = t.player(a);
    const loot = await import('../../server/loot.js');
    const id = t.gs.data.components.find((c) => c.research > 0).id;
    loot.dropComponent(t.gs, p, id, p.x + 0.5, p.y);
    await sleep(900);
    assert.equal(p.ch.extra.components[id]?.found, 1, 'picked up');
    p.ch.resources.essence = 0;
    let res = await a.request({ t: 'research', id });
    assert.match(res.error, /essens/);
    p.ch.resources.essence = 100000;
    res = await a.request({ t: 'research', id });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.extra.components[id].researched, true);
    assert.ok(p.ch.resources.essence < 100000, 'paid');
    assert.deepEqual(loot.researchedOf(p), [id], 'drops and the forge draw from it');
    await a.waitFor((m) => m.t === 'me' && m.components?.[id]?.researched);
  } finally {
    await t.close();
  }
});
