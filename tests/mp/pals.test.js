// Pals in multiplayer: eggs, hatching in your clan's Pal Den, growing them,
// and the pal that walks with you (fighting, gathering, napping when beaten).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { ET } from '../../src/net/protocol.js';
import { T } from '../../src/game/world.js';

async function wild(t, name) {
  const bot = await t.bot(name);
  const p = t.player(bot);
  let x = 120;
  while (!t.gs.world.isFree(x, 0.5, 2.5)) x += 1;
  t.place(bot, x, 0.5);
  p.protectUntil = Date.now() + 10 * 60 * 1000;
  return { bot, p };
}

test('pals: an egg from a boss, hatched in your base\'s Den, grows with the Den and fights with you', async () => {
  const t = await testServer();
  try {
    const { bot, p } = await wild(t, 'Herden');
    const pals = await import('../../server/pals.js');
    // The first win over a boss always gives an egg (locked to you), and you pick it up.
    assert.equal(pals.dropEgg(t.gs, p, 'bossFirst', p.x + 0.6, p.y), true);
    await sleep(900);
    assert.equal(p.ch.extra.pals.eggs.length, 1, 'the egg is in your pals');
    // Hatching needs a Pal Den in your clan's base.
    p.ch.resources.essence = 1000;
    let res = await bot.request({ t: 'pal', op: 'hatch', id: p.ch.extra.pals.eggs[0].id });
    assert.equal(res.ok, false);
    assert.match(res.error, /Den|djurhus/i);
    const wildSpot = { x: p.x, y: p.y };
    await t.clanBase(bot, { den: 1 });
    t.place(bot, wildSpot.x, wildSpot.y);
    p.ch.resources.essence = 1000;
    res = await bot.request({ t: 'pal', op: 'hatch', id: p.ch.extra.pals.eggs[0].id });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.resources.essence, 1000 - t.gs.data.pals.hatchEssence, 'warming costs essence');
    // Time passes (it hatches even while you're away).
    p.ch.extra.pals.eggs[0].hatchAt = Date.now() - 1;
    await sleep(1300);
    assert.equal(p.ch.extra.pals.owned.length, 1, 'hatched');
    assert.equal(p.ch.extra.pals.active, p.ch.extra.pals.owned[0].id, 'your first pal walks with you');
    assert.ok(p.palEnt, 'and is in the world');
    assert.ok(bot.json.some((m) => m.t === 'pal-born'));
    // Everyone around sees it.
    await sleep(200);
    assert.ok([...bot.known.values()].some((k) => k.type === ET.PAL), 'pals are sent in snapshots');
    // Growing: a level 1 Den lets pals reach level 2, not further.
    p.ch.resources = { essence: 5000, scrap: 5000, wood: 5000, stone: 5000, gold: 0, shards: 0 };
    const id = p.ch.extra.pals.owned[0].id;
    res = await bot.request({ t: 'pal', op: 'upgrade', id });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.extra.pals.owned[0].level, 2);
    res = await bot.request({ t: 'pal', op: 'upgrade', id });
    assert.equal(res.ok, false, 'capped by the Den');
    // Fighting at your side.
    await bot.request({ t: 'pal', op: 'mode', mode: 'fight' });
    const { spawnEnemy } = await import('../../server/enemies.js');
    const spot = t.gs.world.findFreeSpot(p.x + 2.5, p.y, 0.4);
    const e = spawnEnemy(t.gs, 'slime', spot.x, spot.y, { level: 1 });
    e.hp = e.maxHp = 5000;
    await sleep(3000);
    assert.ok(e.hp < 5000, 'the pal bit the monster');
    // Beaten, it naps and comes back.
    p.palEnt.hp = 1;
    p.palEnt.hurtCd = 0;
    e.x = p.palEnt.x + 0.3;
    e.y = p.palEnt.y;
    await sleep(600);
    assert.equal(p.palEnt.state, 'down', 'knocked out');
    p.palEnt.downUntil = t.gs.time;
    await sleep(300);
    assert.notEqual(p.palEnt.state, 'down', 'back on its feet');
    assert.equal(p.palEnt.hp, p.palEnt.stats.maxHp);
    // Let it rest: it leaves the world.
    await bot.request({ t: 'pal', op: 'active', id: null });
    assert.equal(p.palEnt, null);
  } finally {
    await t.close();
  }
});

test('a gathering pal chops trees and hands you the wood', async () => {
  const t = await testServer();
  try {
    const { bot, p } = await wild(t, 'Huggaren');
    // A tree a few steps away.
    let tree = null;
    for (let x = 100; x < 400 && !tree; x++) {
      for (let y = -20; y < 20 && !tree; y++) {
        if (t.gs.world.blockAt(x, y) === T.TREE && t.gs.world.isFree(x + 2.5, y + 0.5, 0.5)) tree = { x, y };
      }
    }
    assert.ok(tree, 'found a tree');
    t.place(bot, tree.x + 2.5, tree.y + 0.5);
    for (const e of t.gs.enemies.values()) e.dead = true;
    t.gs.config.maxEnemies = 0;
    p.ch.level = 30;
    p.ch.extra.pals = { eggs: [], owned: [{ id: 'pal1', species: 'mossling', name: 'Mossling', level: 10 }], active: 'pal1', mode: 'gather', nextId: 2 };
    const pals = await import('../../server/pals.js');
    pals.sync(t.gs, p);
    const wood = p.ch.resources.wood ?? 0;
    await sleep(6000);
    assert.ok((p.ch.resources.wood ?? 0) > wood, `the pal brought wood (${wood} → ${p.ch.resources.wood})`);
    void bot;
  } finally {
    await t.close();
  }
});
