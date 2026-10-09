// Clan bases with the camp's buildings, and Fristaden with only a simple
// forge and its traders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { craftingOptions } from '../../src/weapons/crafting.js';
import { ET } from '../../src/net/protocol.js';
import * as baseMod from '../../server/base.js';

function craftChoice(gs, p, catalyst) {
  const opts = craftingOptions(gs.data, baseMod.saveFor(gs, p, { level: 5 }));
  const bp = opts.blueprints[0];
  return { archetype: bp.id, material: opts.materialsFor(bp.id)[0].id, catalyst };
}

test('Fristaden: only the forge and the fire, and its forge makes up to rare weapons', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Stadsbo');
    const p = t.player(a);
    const kinds = [...t.gs.world.objectsNear(0, 0, 2)].filter((o) => o.type === 'building').map((o) => o.buildingId).sort();
    assert.deepEqual(kinds, ['forge', 'hearth']);
    const forge = t.gs.data.base.buildings.find((b) => b.id === 'forge');
    t.place(a, forge.x + 1, forge.y + 1);
    p.ch.resources = { essence: 50000, scrap: 50000, wood: 0, stone: 0, gold: 0, shards: 0 };
    let res = await a.request({ t: 'craft', choice: craftChoice(t.gs, p, 'none') });
    assert.equal(res.ok, true, res.error);
    res = await a.request({ t: 'craft', choice: craftChoice(t.gs, p, 'rare') });
    assert.equal(res.ok, false, 'no Azure Catalyst in town');
    assert.match(res.error, /sällsynta|smedja/);
    // No storage in town any more: it is in your base.
    res = await a.request({ t: 'move', id: p.inv.bag[0].id, to: 'storage' });
    assert.match(res.error, /förråd/i);
  } finally {
    await t.close();
  }
});

test('Fristaden: traders on the square sell and buy (never epics, nobody gets hurt)', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Kunden');
    const p = t.player(a);
    t.place(a, 0.5, 2.5);
    await sleep(800);
    const entry = t.gs.markets.get('town');
    assert.ok(entry, 'the town square has traders');
    const merchants = entry.npcs.filter((n) => n.role === 'merchant');
    assert.equal(merchants.length, 3);
    assert.ok([...a.known.values()].some((k) => k.type === ET.NPC), 'people are sent in snapshots');
    // Trade with one.
    const n = merchants[0];
    t.place(a, n.x, n.y + 1.2);
    p.ch.resources.gold = 5000;
    p.ch.resources.wood = 100;
    let res = await a.request({ t: 'market', op: 'sellBundle', id: 'town', res: 'wood' });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.resources.wood, 80);
    const { marketStock } = await import('../../src/game/markets.js');
    const stock = marketStock(t.gs.data, baseMod.saveFor(t.gs, p), t.gs.world.town);
    assert.ok(stock.items.every((it) => it.kind !== 'shard'), 'no star shards in town');
    assert.ok(stock.items.filter((it) => it.kind === 'weapon').every((it) => it.request.maxRarity === 'rare'), 'up to rare');
    const bundle = stock.items.findIndex((it) => it.kind === 'bundle');
    res = await a.request({ t: 'market', op: 'buy', id: 'town', i: bundle });
    assert.equal(res.ok, true, res.error);
    // A careless swing hurts nobody here.
    const markets = await import('../../server/markets.js');
    assert.equal(markets.hitNpcs(t.gs, p, n.x, n.y, 2, 50, () => true), false);
    assert.equal(n.hp, n.maxHp);
  } finally {
    await t.close();
  }
});

test('clan bases: build the camp buildings, pay from the vault, upgrades help the whole clan', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Hövding');
    const p = t.player(a);
    const { clan, spots } = await t.clanBase(a, { forge: 1, vault: 1, training: 1, hearth: 1, well: 1 });
    await a.waitFor((m) => m.t === 'clan' && m.base?.placed?.forge);
    // Bonuses for members: Training Grounds and Hearth.
    const hp1 = p.maxHp;
    const atk1 = p.stats.attackPower;
    p.ch.resources = { essence: 0, scrap: 0, wood: 0, stone: 0, gold: 0, shards: 0 };
    clan.vault = { essence: 100000, scrap: 100000, wood: 100000, stone: 100000 };
    let res = await a.request({ t: 'base', op: 'upgrade', id: 'training' });
    assert.equal(res.ok, true, res.error);
    res = await a.request({ t: 'base', op: 'upgrade', id: 'hearth' });
    assert.equal(res.ok, true, res.error);
    assert.ok(p.stats.attackPower > atk1, 'more attack');
    assert.ok(p.maxHp > hp1, 'more health');
    assert.ok(clan.vault.scrap < 100000, 'paid from the vault');
    assert.equal(p.ch.resources.scrap, 0, 'not from your pockets while the vault has enough');
    // The vault runs short: the rest comes from what you carry; nothing at all: refused.
    clan.vault = { essence: 0, scrap: 0, wood: 0, stone: 0 };
    res = await a.request({ t: 'base', op: 'upgrade', id: 'forge' });
    assert.match(res.error, /fattas/);
    p.ch.resources = { essence: 100000, scrap: 100000, wood: 100000, stone: 100000, gold: 0, shards: 0 };
    res = await a.request({ t: 'base', op: 'upgrade', id: 'forge' });
    assert.equal(res.ok, true, res.error);
    assert.equal(clan.base.buildings.forge, 2);
    // The base forge (level 2) makes rare-to-epic weapons with the Azure Catalyst.
    t.nextTo(a, spots.forge);
    res = await a.request({ t: 'craft', choice: craftChoice(t.gs, p, 'rare') });
    assert.equal(res.ok, true, res.error);
    // The Vault: storage is here, and the bag grows with it.
    const bag0 = baseMod.sizesFor(t.gs, p).bagSize;
    res = await a.request({ t: 'base', op: 'upgrade', id: 'vault' });
    assert.equal(res.ok, true, res.error);
    assert.ok(baseMod.sizesFor(t.gs, p).bagSize > bag0, 'bigger bag');
    await a.waitFor((m) => m.t === 'invsize' && m.bagSize > bag0);
    const weapon = p.inv.bag.find((w) => w.id !== p.inv.equipped && w.id !== p.inv.secondary);
    res = await a.request({ t: 'move', id: weapon.id, to: 'storage' });
    assert.match(res.error, /förråd/i, 'only at the vault');
    t.nextTo(a, spots.vault);
    res = await a.request({ t: 'move', id: weapon.id, to: 'storage' });
    assert.equal(res.ok, true, res.error);
    // The Essence Well fills up; walk up and take it.
    clan.base.wellAt = Date.now() - 2 * 3600 * 1000;
    t.nextTo(a, spots.well);
    const ess = p.ch.resources.essence;
    res = await a.request({ t: 'base', op: 'well' });
    assert.equal(res.ok, true, res.error);
    assert.ok(p.ch.resources.essence > ess, 'essence from the well');
    // Buildings can't be broken, and moving one keeps its level (for free).
    const st = t.gs.world.structureAt(spots.forge.x, spots.forge.y);
    assert.ok(st && st.def.kind === 'building');
    assert.equal(t.gs.structures.get(st.sid) === st, true);
    t.nextTo(a, spots.forge);
    res = await a.request({ t: 'unbuild', x: spots.forge.x, y: spots.forge.y });
    assert.equal(res.ok, true, res.error);
    assert.equal(baseMod.levelsFor(t.gs, p).forge, undefined, 'gone for now');
    p.ch.resources = { essence: 0, scrap: 0, wood: 0, stone: 0, gold: 0, shards: 0 };
    clan.vault = {};
    res = await a.request({ t: 'build', id: 'b_forge', x: spots.forge.x, y: spots.forge.y });
    assert.equal(res.ok, true, res.error);
    assert.equal(baseMod.levelsFor(t.gs, p).forge, 2, 'level kept, rebuilt for free');
    res = await a.request({ t: 'build', id: 'b_forge', x: spots.forge.x + 3, y: spots.forge.y });
    assert.match(res.error, /redan/, 'one of each');
  } finally {
    await t.close();
  }
});

test('clan bases: members share the buildings; leaving the clan leaves them behind', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Ledaren');
    const b = await t.bot('Följaren');
    const pb = t.player(b);
    await t.clanBase(a, { training: 3 });
    assert.equal((await a.request({ t: 'clan', op: 'invite', name: 'Följaren' })).ok, true);
    const invite = await b.waitFor((m) => m.t === 'invites' && m.list.length);
    const atk0 = pb.stats.attackPower;
    assert.equal((await b.request({ t: 'clan', op: 'accept', id: invite.list[0].id })).ok, true);
    assert.ok(pb.stats.attackPower > atk0, 'the Training Grounds count for the new member');
    // Raiders can't break buildings.
    const building = await import('../../server/building.js');
    const st = [...t.gs.structures.values()].find((s) => s.def.kind === 'building');
    assert.equal(building.canDamage(t.gs, t.player(a), st), false);
    assert.equal((await b.request({ t: 'clan', op: 'leave' })).ok, true);
    assert.equal(pb.stats.attackPower, atk0, 'gone after leaving');
  } finally {
    await t.close();
  }
});

test('building on water: floors make bridges and docks, walls stand on them, and fall in with them', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Bryggbyggaren');
    const p = t.player(a);
    const { banner } = await t.clanBase(a, {});
    const { T, CHUNK } = await import('../../src/game/world.js');
    // A pond inside the claim.
    const w = t.gs.world;
    const pond = [[3, 0], [4, 0], [3, 1], [4, 1]].map(([dx, dy]) => ({ x: banner.x + dx, y: banner.y + dy }));
    for (const { x, y } of pond) {
      const chunk = w.getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
      chunk.block[(y - chunk.cy * CHUNK) * CHUNK + (x - chunk.cx * CHUNK)] = T.WATER;
    }
    Object.assign(p, { x: banner.x + 1.5, y: banner.y + 1.5 });
    Object.assign(p.ch.resources, { wood: 500, stone: 500, scrap: 500 });
    const [tile] = pond;
    let res = await a.request({ t: 'build', id: 'wood_wall', x: tile.x, y: tile.y });
    assert.match(res.error, /golv/, 'no wall straight on water');
    res = await a.request({ t: 'build', id: 'wood_floor', x: tile.x, y: tile.y });
    assert.equal(res.ok, true, res.error);
    assert.equal(w.isFree(tile.x + 0.5, tile.y + 0.5, 0.32), true, 'you can stand on the bridge');
    assert.equal(w.isFree(tile.x + 0.5, tile.y + 0.5, 0.4, 'boat'), false, 'boats bump into it');
    res = await a.request({ t: 'build', id: 'wood_wall', x: tile.x, y: tile.y });
    assert.equal(res.ok, true, res.error);
    // The floor breaks: the wall falls into the water with it.
    const building = await import('../../server/building.js');
    building.destroyStructure(t.gs, w.floorAt(tile.x, tile.y), null);
    assert.equal(w.structureAt(tile.x, tile.y), null, 'the wall fell in');
    // Clan buildings stay on dry land.
    res = await a.request({ t: 'build', id: 'wood_floor', x: pond[1].x, y: pond[1].y });
    assert.equal(res.ok, true, res.error);
    p.ch.level = 30;
    res = await a.request({ t: 'build', id: 'b_hearth', x: pond[1].x, y: pond[1].y });
    assert.match(res.error, /fast mark/);
  } finally {
    await t.close();
  }
});
