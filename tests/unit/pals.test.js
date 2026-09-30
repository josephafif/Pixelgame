import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import {
  addEgg, rollEgg, eggChance, hatchBlockers, startHatch, hatchReady, palStats, palLevelCap, upgradeCost,
  palUpgradeBlockers, upgradePal, activePal,
} from '../../src/game/pals.js';
import { upgradeBuilding, buildingLevel } from '../../src/game/base.js';
import { loadData } from './helpers.js';

const data = loadData();

function rich() {
  const save = createNewSave({ worldSeed: 7 });
  save.player.level = 30;
  save.bosses.defeated.inferno_titan = 1;
  Object.assign(save.resources, { scrap: 1e6, essence: 1e6, wood: 1e6, stone: 1e6 });
  return save;
}

test('pal eggs are hard to get: bosses, buried treasure, serpents and (rarely) elites', () => {
  assert.equal(eggChance(data, 'bossFirst'), 1, 'your first win over each boss earns an egg');
  assert.ok(eggChance(data, 'boss') < 0.5);
  assert.ok(eggChance(data, 'treasure') <= 0.3);
  assert.ok(eggChance(data, 'elite') < 0.01, 'elites almost never');
  assert.equal(eggChance(data, 'drop'), 0, 'ordinary monsters never');
  assert.equal(rollEgg(data, 'drop', () => 0), null);
  assert.ok(rollEgg(data, 'bossFirst', () => 0.99));
  let eggs = 0;
  let r = 1;
  const rng = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20000; i++) if (rollEgg(data, 'elite', rng)) eggs++;
  assert.ok(eggs > 40 && eggs < 250, `about 0.6% of elites (${eggs} / 20000)`);
});

test('an egg hatches at the Pal Den: it costs essence and takes a while', () => {
  const save = rich();
  const egg = addEgg(data, save, 'mossling');
  assert.ok(hatchBlockers(data, save, egg).some((b) => /Pal Den/.test(b)), 'needs a Pal Den');
  assert.throws(() => startHatch(data, save, egg.id), /Pal Den/);
  upgradeBuilding(data, save, 'den');
  assert.equal(buildingLevel(data, save, 'den'), 1);
  const essence = save.resources.essence;
  startHatch(data, save, egg.id, 1000);
  assert.equal(save.resources.essence, essence - data.pals.hatchEssence);
  const second = addEgg(data, save, 'emberpup');
  assert.ok(hatchBlockers(data, save, second).some((b) => /already warming/.test(b)), 'one egg at a time');
  assert.deepEqual(hatchReady(data, save, 1000 + data.pals.hatchSeconds * 1000 - 1), [], 'not yet');
  const [pal] = hatchReady(data, save, 1000 + data.pals.hatchSeconds * 1000);
  assert.equal(pal.species, 'mossling');
  assert.equal(pal.level, 1);
  assert.equal(activePal(save).id, pal.id, 'your first pal comes along');
  assert.equal(save.pals.mode, 'gather', 'a mossling starts out gathering');
  assert.equal(save.pals.eggs.length, 1);
});

test('pals grow with upgrades, and the Pal Den caps how far', () => {
  const save = rich();
  upgradeBuilding(data, save, 'den');
  const egg = addEgg(data, save, 'emberpup');
  startHatch(data, save, egg.id, 0);
  const [pal] = hatchReady(data, save, 1e12);
  assert.equal(palLevelCap(data, save), 2);
  upgradePal(data, save, pal.id);
  assert.equal(pal.level, 2);
  assert.ok(palUpgradeBlockers(data, save, pal).some((b) => /Pal Den/.test(b)), 'the Den must grow first');
  while (buildingLevel(data, save, 'den') < 5) upgradeBuilding(data, save, 'den');
  let prev = palStats(data, pal.species, pal.level);
  let prevCost = upgradeCost(data, pal.level);
  while (pal.level < data.pals.maxLevel) {
    const before = save.resources.essence;
    upgradePal(data, save, pal.id);
    assert.equal(save.resources.essence, before - prevCost.essence, 'pays essence');
    const s = palStats(data, pal.species, pal.level);
    assert.ok(s.maxHp > prev.maxHp && s.damage > prev.damage && s.gatherPower > prev.gatherPower, 'stronger every level');
    assert.ok(s.attackInterval <= prev.attackInterval, 'and quicker');
    const cost = upgradeCost(data, pal.level);
    if (pal.level < data.pals.maxLevel) assert.ok(cost.essence > prevCost.essence, 'dearer every level');
    prev = s;
    prevCost = cost;
  }
  assert.equal(pal.level, 10);
  assert.deepEqual(palUpgradeBlockers(data, save, pal), ['Max level']);
  assert.ok(palStats(data, 'mossling', 5).gatherTier === 2 && palStats(data, 'mossling', 4).gatherTier === 1, 'crystals from level 5');
});

test('three kinds of pal with different strengths', () => {
  const at = (id) => palStats(data, id, 5);
  assert.ok(at('mossling').gatherPower > at('emberpup').gatherPower * 2, 'the mossling is the gatherer');
  assert.ok(at('emberpup').damage > at('mossling').damage * 2, 'the emberpup is the fighter');
  assert.ok(at('glimmerfox').range > 3, 'the glimmerfox zaps from range');
  assert.equal(new Set(data.pals.species.map((s) => s.role)).size, 3);
});

test('old saves get an empty pal roster', () => {
  const old = createNewSave({ worldSeed: 3 });
  delete old.pals;
  const filled = fillDefaults(old);
  assert.deepEqual(filled.pals, { eggs: [], owned: [], active: null, mode: 'fight', nextId: 1 });
});
