// Blueprints in multiplayer: the first win over a boss gives its set
// blueprint, a duplicate turns into essence and scrap, and the legendary
// Aegis Wall needs its blueprint before a clan can raise it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, clearArea } from './helpers.js';
import { firstKillReward, duplicateValue } from '../../src/game/blueprints.js';

test('the first win over a boss gives its set blueprint, once', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    const bot = await t.bot('Altarjägaren');
    const p = t.player(bot);
    const at = clearArea(gs, 180, 60, 6);
    t.place(bot, at.x + 0.5, at.y + 0.5);
    const { spawnBoss } = await import('../../server/enemies.js');
    const { killEnemy } = await import('../../server/combat.js');
    const blueprintsFor = () => [...gs.pickups.values()].filter((it) => it.kind === 'component' && it.owner === p.id
      && gs.data.byId.components.get(it.componentId)?.type === 'blueprint').map((it) => it.componentId);
    const win = () => {
      const b = spawnBoss(gs, 'bone_king', at.x + 3, at.y, null);
      b.damageBy.set(p.id, b.maxHp);
      killEnemy(gs, b, p);
    };
    win();
    assert.ok(blueprintsFor().includes(firstKillReward(gs.data, 'bone_king')), 'the Bone King\'s blueprint');
    for (const [id, it] of gs.pickups) if (it.kind === 'component') gs.pickups.delete(id);
    // The second win: no set reward (only, now and then, a roll of the table).
    for (let i = 0; i < 5; i++) win();
    const again = blueprintsFor().filter((id) => id === firstKillReward(gs.data, 'bone_king'));
    assert.ok(again.length < 5, 'not every time');
  } finally {
    await t.close();
  }
});

test('a duplicate blueprint turns into essence and scrap; the Aegis Wall needs its blueprint', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    const gs = t.gs;
    const bot = await t.bot('Murmästaren');
    const p = t.player(bot);
    const { discoverComponent } = await import('../../server/loot.js');
    discoverComponent(gs, p, 'bp_aegis_wall');
    const before = { essence: p.ch.resources.essence ?? 0, scrap: p.ch.resources.scrap ?? 0 };
    discoverComponent(gs, p, 'bp_aegis_wall');
    const v = duplicateValue(gs.data, gs.data.byId.components.get('bp_aegis_wall'));
    assert.equal(p.ch.resources.essence, before.essence + v.essence);
    assert.equal(p.ch.resources.scrap, before.scrap + v.scrap);
    // Building it: found is not enough, it has to be researched.
    const { banner } = await t.clanBase(bot, { hearth: 5 });
    Object.assign(p.ch.resources, { stone: 500, scrap: 500, essence: 500 });
    let res = await bot.request({ t: 'build', id: 'aegis_wall', x: banner.x + 3, y: banner.y + 2 });
    assert.equal(res.ok, false, 'not researched yet');
    p.ch.extra.components.bp_aegis_wall.researched = true;
    res = await bot.request({ t: 'build', id: 'aegis_wall', x: banner.x + 3, y: banner.y + 2 });
    assert.equal(res.ok, true, res.error);
    assert.equal(gs.world.structureAt(banner.x + 3, banner.y + 2).def.hp, 2400);
  } finally {
    await t.close();
  }
});
