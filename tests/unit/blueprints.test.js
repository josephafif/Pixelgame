// Blueprints: one table for every source, legendaries only from the hardest
// bosses, a set reward for the first win over each boss, duplicates into
// essence and scrap, merchants without the great ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, isBlueprint, blueprintTier, withoutBlueprints, blueprintPool, isHardBoss, rollBlueprint,
  firstKillReward, duplicateValue, sourceOdds,
} from '../../src/game/blueprints.js';
import { marketStock, townMarket } from '../../src/game/markets.js';
import { createNewSave } from '../../src/storage/save.js';
import { createRng } from '../../src/core/rng.js';
import { loadData } from './helpers.js';

const data = loadData();
const blueprints = data.components.filter(isBlueprint);

/** Rolls a source n times (seeded): { tier: count, ids: Map(id → count), none }. */
function sweep(source, n, opts = {}) {
  const r = createRng(1234);
  const rng = () => r.next();
  const out = { none: 0, ids: new Map(), ...Object.fromEntries(TIERS.map((t) => [t, 0])) };
  for (let i = 0; i < n; i++) {
    const id = rollBlueprint(data, source, { rng, ...opts });
    if (!id) {
      out.none++;
      continue;
    }
    out[blueprintTier(data.byId.components.get(id))]++;
    out.ids.set(id, (out.ids.get(id) ?? 0) + 1);
  }
  return out;
}

test('the table: legendary blueprints exist, and only the hard bosses\' table has them', () => {
  const legendary = blueprints.filter((c) => blueprintTier(c) === 'legendary');
  assert.ok(legendary.length >= 2, 'legendary blueprints to hunt for');
  for (const c of legendary) {
    for (const id of c.unlocks.structures) assert.ok(data.building.structures.find((s) => s.id === id && s.blueprint === c.id), `${id} needs ${c.id}`);
  }
  for (const [source, row] of Object.entries(data.blueprintLoot.sources)) {
    assert.equal(Boolean(row.tiers.legendary), source === 'hardBoss', source);
  }
  // Chests and monsters are poor odds; bosses good ones.
  const odds = (s) => sourceOdds(data, s);
  assert.ok(odds('chest').chance < 0.1 && odds('enemy').chance < 0.01);
  assert.ok(odds('boss').chance > odds('elite').chance && odds('hardBoss').chance > odds('boss').chance);
  assert.equal(odds('chest').tiers.epic, 0);
  // Every blueprint can turn up somewhere.
  const reachable = new Set();
  for (const source of Object.keys(data.blueprintLoot.sources)) {
    for (const t of TIERS) {
      if (!data.blueprintLoot.sources[source].tiers[t]) continue;
      for (const b of data.biomes) for (const c of blueprintPool(data, t, b.id)) reachable.add(c.id);
    }
  }
  for (const reward of Object.values(data.blueprintLoot.firstKill)) if (reward !== 'roll') reachable.add(reward);
  for (const c of blueprints) assert.ok(reachable.has(c.id), `${c.id} can be found`);
});

test('rolls: chests never give the great ones; hard bosses give legendaries about one time in five', () => {
  const chest = sweep('chest', 20000);
  assert.equal(chest.epic + chest.legendary, 0);
  assert.ok(chest.none / 20000 > 0.9, 'most chests have none');
  const hard = sweep('hardBoss', 4000, { sure: true });
  assert.equal(hard.none, 0, 'a sure roll always gives one');
  assert.ok(Math.abs(hard.legendary / 4000 - 0.2) < 0.03, `legendary share ${hard.legendary / 4000}`);
  assert.equal(hard.common, 0);
  const boss = sweep('boss', 4000, { sure: true });
  assert.equal(boss.legendary, 0, 'a lesser altar\'s boss has no legendaries');
});

test('rolls: local blueprints only in their own land, and ones you have not found come first', () => {
  const plains = sweep('boss', 3000, { sure: true, biome: 'plains' });
  for (const id of ['bp_healing_garden', 'bp_wind_beacon', 'bp_prism_relay']) assert.equal(plains.ids.get(id) ?? 0, 0, `${id} not in the plains`);
  const fen = sweep('boss', 3000, { sure: true, biome: 'fen' });
  assert.ok(fen.ids.get('bp_healing_garden') > 0, 'the garden blueprint in the fen');
  // Found every rare one but the Scythe: the next rare roll is the Scythe.
  const components = {};
  for (const c of blueprintPool(data, 'rare', 'plains')) if (c.id !== 'bp_scythe') components[c.id] = { found: 1 };
  const r = createRng(9);
  for (let i = 0; i < 50; i++) {
    const id = rollBlueprint(data, 'ruin', { rng: () => r.next(), components, sure: true, biome: 'plains' });
    if (blueprintTier(data.byId.components.get(id)) === 'rare') assert.equal(id, 'bp_scythe');
  }
});

test('hard bosses: at a great altar or in the far lands', () => {
  const titan = data.byId.bosses.get('inferno_titan');
  assert.equal(isHardBoss(titan, 'a:inferno_titan'), true, 'its great altar');
  assert.equal(isHardBoss(titan, 'a:c3,-2'), false, 'a lesser altar');
  assert.equal(isHardBoss(titan, null), false);
  assert.equal(isHardBoss(data.byId.bosses.get('mireheart'), 'a:c1,1'), true, 'far lands');
});

test('first wins, duplicates and the regular component drops', () => {
  for (const b of data.bosses) {
    const reward = firstKillReward(data, b.id);
    assert.ok(reward, `${b.id} has a first-win reward`);
    if (reward !== 'roll') assert.notEqual(blueprintTier(data.byId.components.get(reward)), 'legendary');
  }
  const v = TIERS.map((t) => duplicateValue(data, blueprints.find((c) => blueprintTier(c) === t)));
  for (let i = 1; i < v.length; i++) assert.ok(v[i].essence > v[i - 1].essence && v[i].scrap > v[i - 1].scrap, 'rarer duplicates are worth more');
  // Biome component drops never include blueprints any more.
  for (const b of data.biomes) for (const id of withoutBlueprints(data, b.components)) assert.equal(isBlueprint(data.byId.components.get(id)), false);
});

test('merchants never sell epic or legendary blueprints', () => {
  const save = createNewSave({ worldSeed: 11 });
  save.player.level = 30;
  const m = { ...townMarket(11), town: false };
  for (let k = 0; k < 400; k++) {
    for (const it of marketStock(data, save, m, k * 3.7e6).items) {
      if (it.kind !== 'component') continue;
      const c = data.byId.components.get(it.id);
      if (isBlueprint(c)) assert.ok(!['epic', 'legendary'].includes(blueprintTier(c)), it.id);
    }
  }
});
