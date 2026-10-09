// Markets in multiplayer: they appear when someone comes near, merchants
// trade (checked by the server), and hurting someone there turns the
// turrets on you.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { BTN, angleToByte } from '../../src/net/protocol.js';
import { marketStock } from '../../src/game/markets.js';
import { mpVirtualSave } from '../../src/net/mpsave.js';

async function walk(bot, frames, frame = {}) {
  for (let i = 0; i < frames; i++) {
    bot.input(frame);
    await sleep(33);
  }
}

test('markets: walls and people appear, merchants trade, and hurting someone angers the turrets', async () => {
  const t = await testServer({ worldSeed: 42 });
  try {
    const a = await t.bot('Handlaren');
    const p = t.player(a);
    p.protectUntil = Date.now() + 10 * 60 * 1000;
    const m = t.gs.world.firstMarket;
    t.place(a, m.x + 0.5, m.y + m.r + 4);
    await sleep(800);
    const entry = t.gs.markets.get(m.id);
    assert.ok(entry, 'the market is up');
    assert.ok(entry.structures.some((s) => s.def.kind === 'turret'), 'with turrets');
    assert.ok(t.gs.world.structureAt(entry.structures[0].x, entry.structures[0].y), 'its walls are in the world');
    // Nobody can build at a market, or break its walls.
    const building = await import('../../server/building.js');
    assert.equal(building.canDamage(t.gs, p, entry.structures[0]), false);
    // Up to a merchant.
    const merchant = entry.npcs.find((n) => n.role === 'merchant');
    t.place(a, merchant.x, merchant.y + 1.2);
    await sleep(200);
    p.ch.resources.gold = 100000;
    // Buy a bundle of wood, sell some stone, buy a weapon.
    const save = mpVirtualSave(t.gs.data, t.gs.worldSeed, p.ch, p.inv);
    const stock = marketStock(t.gs.data, save, m);
    const wood = stock.items.findIndex((it) => it.kind === 'bundle' && it.res === 'wood');
    const w0 = p.ch.resources.wood ?? 0;
    let res = await a.request({ t: 'market', op: 'buy', id: m.id, i: wood });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.resources.wood, w0 + 20);
    res = await a.request({ t: 'market', op: 'buy', id: m.id, i: wood });
    assert.equal(res.ok, false, 'sold out until the stock turns over');
    p.ch.resources.stone = 50;
    res = await a.request({ t: 'market', op: 'sellBundle', id: m.id, res: 'stone' });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.resources.stone, 30);
    const bag0 = p.inv.bag.length;
    res = await a.request({ t: 'market', op: 'buy', id: m.id, i: 0 });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.inv.bag.length, bag0 + 1, 'a new weapon in the bag');
    // Not from across the map.
    t.place(a, m.x + 40, m.y + 40);
    res = await a.request({ t: 'market', op: 'buy', id: m.id, i: 1 });
    assert.equal(res.ok, false);
    // Hit a villager: the market turns on you, and nobody trades with you.
    const villager = entry.npcs.find((n) => n.role === 'villager') ?? merchant;
    villager.fleeT = 0;
    t.place(a, villager.x - 1, villager.y);
    villager.x = p.x + 0.9;
    villager.y = p.y;
    villager.role = villager.role === 'merchant' ? 'merchant' : 'villager';
    await walk(a, 12, { buttons: BTN.ATTACK, aim: angleToByte(0) });
    await sleep(200);
    const markets = await import('../../server/markets.js');
    assert.ok(markets.isHostile(p, m.id), 'the market is angry');
    t.place(a, merchant.x, merchant.y + 1.2);
    await sleep(100);
    res = await a.request({ t: 'market', op: 'buy', id: m.id, i: 1 });
    assert.match(res.error, /handla/);
    // Its turrets shoot you now.
    p.protectUntil = 0;
    p.hp = p.maxHp = 100000;
    const hp0 = p.hp;
    await walk(a, 90, {});
    assert.ok(p.hp < hp0, 'the turrets hit you');
  } finally {
    await t.close();
  }
});
