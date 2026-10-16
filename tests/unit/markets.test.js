import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, MARKET_CELL } from '../../src/game/world.js';
import { marketLayout, marketStock, RESTOCK_MS, SELL_BUNDLES } from '../../src/game/markets.js';
import {
  dropRarity, weaponValue, sellPrice, buyPrice, rarityOdds, FOUND_MAX_RARITY, WEAPON_DROP_CHANCE,
} from '../../src/game/economy.js';
import { salvageValue } from '../../src/game/loot.js';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import { generateWeapon } from '../../src/weapons/generator.js';
import { loadData, seeds } from './helpers.js';

const data = loadData();

// --- Found weapons -------------------------------------------------------------------

test('found weapons stop at rare: epics and legendaries are grown in the weapon tree', () => {
  assert.deepEqual(dropRarity({}), { minRarity: null, maxRarity: 'rare' });
  assert.deepEqual(dropRarity({ minRarity: 'uncommon' }), { minRarity: 'uncommon', maxRarity: 'rare' });
  assert.deepEqual(dropRarity({ minRarity: 'epic' }), { minRarity: 'rare', maxRarity: 'rare' }, 'a higher floor is lowered');
  assert.equal(FOUND_MAX_RARITY, 'rare');
  assert.equal(WEAPON_DROP_CHANCE.drop, 0, 'monsters drop no weapons');
  assert.ok(WEAPON_DROP_CHANCE.elite <= 0.08 && WEAPON_DROP_CHANCE.chest <= 0.1, 'elites and chests now and then');
  assert.equal(WEAPON_DROP_CHANCE.boss, 1, 'every boss drops one');
});

test('the odds table matches the rolls and adds up to 100%', () => {
  for (const minRarity of [null, 'uncommon', 'rare']) {
    const odds = rarityOdds(data, { minRarity, level: 10, luck: 5 });
    const sum = Object.values(odds).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${minRarity} sums to ${sum}`);
    assert.equal(odds.epic + odds.legendary, 0);
    if (minRarity) assert.equal(odds.common, 0, 'a floor keeps commons out');
  }
  // Simulate drops end to end through the generator.
  const odds = rarityOdds(data, { level: 1, luck: 0 });
  const counts = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  const N = 3000;
  for (let n = 0; n < N; n++) {
    const dna = generateWeapon(data, { seed: 50000 + n, level: 1, luck: 0, source: 'drop', unlocked: [], baseOnly: true, ...dropRarity({}) });
    counts[dna.rarity]++;
  }
  for (const r of ['common', 'uncommon', 'rare']) {
    assert.ok(Math.abs(counts[r] / N - odds[r]) < 0.03, `${r}: ${counts[r] / N} vs ${odds[r]}`);
  }
  assert.equal(counts.epic + counts.legendary, 0);
  // Forge rows use the catalyst's range as is.
  const azure = rarityOdds(data, { minRarity: 'rare', maxRarity: 'rare', forge: true });
  assert.equal(azure.rare, 1);
});

test('markets sell base weapons, uncommon or rare', () => {
  const save = createNewSave({ worldSeed: 21 });
  save.player.level = 12;
  for (let k = 0; k < 40; k++) {
    for (const item of marketStock(data, save, { seed: k, town: false }, k * RESTOCK_MS).items) {
      if (item.kind !== 'weapon') continue;
      const dna = generateWeapon(data, item.request);
      assert.ok(['uncommon', 'rare'].includes(dna.rarity), dna.rarity);
      assert.ok(!data.byId.archetypes.get(dna.archetype).evolved, `${dna.archetype} is a base weapon`);
    }
  }
});

test('weapons have a gold value: legendaries are worth a fortune', () => {
  const byRarity = {};
  for (const r of ['common', 'uncommon', 'rare', 'epic', 'legendary']) {
    byRarity[r] = generateWeapon(data, { seed: 1234, level: 10, luck: 0, source: 'drop', unlocked: [], minRarity: r, maxRarity: r });
  }
  const v = Object.fromEntries(Object.entries(byRarity).map(([r, dna]) => [r, weaponValue(dna)]));
  assert.ok(v.common < v.uncommon && v.uncommon < v.rare && v.rare < v.epic && v.epic < v.legendary, JSON.stringify(v));
  assert.ok(v.legendary > v.epic * 15, 'a legendary is worth many epics');
  const leg = byRarity.legendary;
  assert.equal(weaponValue(leg), weaponValue(structuredClone(leg)), 'deterministic');
  assert.ok(sellPrice(leg) < weaponValue(leg) && weaponValue(leg) < buyPrice(leg), 'traders take a cut both ways');
  assert.equal(salvageValue(leg).shards, 1, 'salvaging a legendary leaves a Star Shard');
  assert.equal(salvageValue(byRarity.epic).shards, undefined);
});

test('a legendary is the hardest thing to make: an Awakening in the weapon tree', () => {
  assert.ok(!data.catalysts.some((c) => c.maxRarity === 'legendary' || c.maxRarity === 'epic'), 'the forge never makes one');
  const awakening = data.evolution.tiers.find((t) => t.tier === 5);
  assert.equal(awakening.rarity, 'legendary');
  assert.ok(awakening.cost.shards >= 3, 'needs Star Shards');
  assert.ok(awakening.cost.essence >= 1000, 'very expensive');
  assert.equal(awakening.forge, 5, 'the best Forge');
  const far = new Set(data.bosses.filter((b) => b.far).map((b) => b.drop.component));
  for (const a of data.evolution.awakenings) assert.ok(far.has(a.core), `${a.power}: a core from the far lands`);
});

// --- Markets -------------------------------------------------------------------------

const sampleMarkets = () => {
  const world = new World(data, 4242);
  const found = new Map();
  for (let mx = -8; mx <= 8 && found.size < 4; mx++) {
    for (let my = -8; my <= 8; my++) {
      const m = world.marketForCell(mx, my);
      if (m && !m.village && !found.has(m.layout)) found.set(m.layout, m);
    }
  }
  return { world, found };
};

test('markets are rare, deterministic and never close to camp or a boss', () => {
  const a = new World(data, 777);
  const b = new World(data, 777);
  let count = 0;
  let cells = 0;
  for (let mx = -10; mx <= 10; mx++) {
    for (let my = -10; my <= 10; my++) {
      cells++;
      const m = a.marketForCell(mx, my);
      assert.deepEqual(m, b.marketForCell(mx, my));
      if (!m || m.village) continue; // (villages share the cells: tested in villages.test.js)
      count++;
      if (m === a.firstMarket) continue; // the guaranteed one, checked below
      assert.ok(Math.hypot(m.x, m.y) > 150, 'far from camp');
      for (const lm of a.landmarks) assert.ok(Math.hypot(m.x - lm.x, m.y - lm.y) > 50, 'away from boss arenas');
      assert.equal(Math.floor(m.x / MARKET_CELL), mx);
      assert.equal(Math.floor(m.y / MARKET_CELL), my);
    }
  }
  assert.ok(count / cells < 0.2, `rare: ${count} of ${cells} cells`);
  // One guaranteed market is within reach of a new player.
  const f = a.firstMarket;
  assert.ok(Math.hypot(f.x, f.y) >= 90 && Math.hypot(f.x, f.y) <= 110);
  assert.equal(a.marketById('m:first'), f);
  for (const lm of a.landmarks) assert.ok(Math.hypot(f.x - lm.x, f.y - lm.y) > 30, 'not on a boss arena');
  assert.ok(a.marketAt(f.x + 0.5, f.y + 0.5));
});

test('every market layout is a walled base with gates, turrets, stalls and merchants', () => {
  const { found } = sampleMarkets();
  assert.deepEqual([...found.keys()].sort(), ['bazaar', 'fort', 'oasis', 'palisade']);
  const shapes = new Set();
  for (const [layout, m] of found) {
    const { structs, npcs } = marketLayout(m);
    const count = (pred) => structs.filter(pred).length;
    assert.ok(count((s) => s.id.endsWith('_wall')) >= 16, `${layout} has walls`);
    assert.ok(count((s) => s.id === 'gate') >= 1 || layout === 'oasis', `${layout} has a way in`);
    assert.ok(count((s) => s.id.endsWith('_turret')) >= 4, `${layout} is guarded`);
    assert.ok(count((s) => s.id === 'stall') >= 6, `${layout} has stalls`);
    assert.ok(npcs.filter((n) => n.role === 'merchant').length >= 3, `${layout} has merchants`);
    for (const s of structs) assert.ok(Math.hypot(s.x, s.y) <= m.r + 1.5, `${layout}: ${s.id} inside the grounds`);
    // Nobody starts inside a wall, stall or turret.
    const blocked = new Set(structs.filter((s) => !s.id.endsWith('_floor')).map((s) => `${s.x},${s.y}`));
    for (const n of npcs) assert.ok(!blocked.has(`${n.x},${n.y}`), `${layout}: ${n.name} stands on a free tile`);
    assert.deepEqual(marketLayout(m), { structs, npcs }, 'deterministic');
    shapes.add(structs.filter((s) => s.id.endsWith('_wall')).map((s) => `${s.x},${s.y}`).sort().join(' '));
  }
  assert.equal(shapes.size, 4, 'each layout has its own shape');
});

test('market grounds are open, paved and free of world chests', () => {
  const { world, found } = sampleMarkets();
  for (const m of found.values()) {
    for (let y = -m.r + 1; y <= m.r - 1; y++) {
      for (let x = -m.r + 1; x <= m.r - 1; x++) {
        if (Math.hypot(x, y) > m.r - 1) continue;
        const t = world.tile(m.x + x, m.y + y);
        assert.equal(t.block, 0, `${m.layout}: nothing natural blocks (${x},${y})`);
      }
    }
    const near = world.objectsNear(m.x, m.y, 2).filter((o) => o.type === 'chest' || o.type === 'shrine');
    for (const o of near) assert.ok(!world.marketAt(o.x, o.y, 1), `${o.type} spawned inside ${m.name}`);
  }
});

test('market stock is seeded per period, capped and priced steeply', () => {
  const { found } = sampleMarkets();
  const m = found.get('bazaar');
  const save = createNewSave({ worldSeed: 4242 });
  save.player.level = 8;
  const t = 1_700_000_000_000;
  const a = marketStock(data, save, m, t);
  const b = marketStock(data, save, m, t + 1000);
  assert.deepEqual(a, b, 'same stock within a period');
  assert.equal(a.restockAt - RESTOCK_MS, a.period * RESTOCK_MS);
  const weapons = a.items.filter((i) => i.kind === 'weapon');
  assert.equal(weapons.length, 3);
  for (let p = 0; p < 300; p++) {
    const s = marketStock(data, save, m, t + p * RESTOCK_MS);
    for (const w of s.items.filter((i) => i.kind === 'weapon')) {
      assert.equal(w.request.maxRarity, 'rare', 'market stock is capped at rare');
      assert.ok(w.request.baseOnly, 'base weapons only');
    }
    const shard = s.items.find((i) => i.kind === 'shard');
    if (shard) assert.ok(shard.price >= 3000, 'Star Shards are expensive');
  }
  // Selling resources back returns far less than buying them.
  for (const b2 of SELL_BUNDLES) {
    const buy = a.items.find((i) => i.kind === 'bundle' && i.res === b2.res);
    assert.ok(b2.price * 2 < buy.price, `${b2.res}: no buy/sell loop`);
  }
});

test('buying a market weapon never costs less than it sells back for', () => {
  for (const seed of seeds(40, 7)) {
    const dna = generateWeapon(data, { seed, level: 12, luck: 0, source: 'market', unlocked: [], maxRarity: 'epic' });
    assert.ok(buyPrice(dna) > sellPrice(dna) * 2, 'no infinite money');
  }
});

// --- Save ----------------------------------------------------------------------------

test('saves have a 3-slot loadout, gold, Star Shards, markets and the explored map', () => {
  const save = createNewSave({ worldSeed: 3 });
  assert.equal(save.inventory.equipped, null);
  assert.equal(save.inventory.secondary, null);
  assert.equal(save.inventory.activeSlot, 'main');
  assert.equal(save.resources.gold, 0);
  assert.equal(save.resources.shards, 0);
  assert.deepEqual(save.markets, {});
  assert.deepEqual(save.world.explored, []);
  assert.deepEqual(save.world.pins, []);
  // Older saves get the new fields filled in.
  const old = createNewSave({ worldSeed: 3 });
  delete old.inventory.secondary;
  delete old.inventory.activeSlot;
  delete old.resources.gold;
  delete old.markets;
  delete old.world.explored;
  const filled = fillDefaults(old);
  assert.equal(filled.inventory.activeSlot, 'main');
  assert.equal(filled.resources.gold, 0);
  assert.deepEqual(filled.markets, {});
  assert.deepEqual(filled.world.explored, []);
});
