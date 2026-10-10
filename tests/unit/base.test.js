import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import {
  buildingLevel, upgradeBlockers, upgradeBuilding, baseBonuses, syncInventoryCaps, wellPending, collectWell,
  researchCost, campRank, describeBonus, maxLevel,
} from '../../src/game/base.js';
import { computePlayerStats } from '../../src/game/stats.js';
import { attackDuration, impactDelay, weaponPose, MELEE_PATTERNS, restAngle } from '../../src/render/weapon-anim.js';
import { loadData } from './helpers.js';

const data = loadData();
const HOUR = 3600 * 1000;

function rich(level = 25) {
  const save = createNewSave({ worldSeed: 5 });
  save.player.level = level;
  Object.assign(save.resources, { scrap: 100000, essence: 100000, wood: 100000, stone: 100000 });
  return save;
}

test('a new camp has only the Hearth; everything else is built with resources', () => {
  const save = createNewSave({ worldSeed: 1 });
  assert.equal(buildingLevel(data, save, 'hearth'), 1);
  for (const b of data.base.buildings.filter((d) => d.id !== 'hearth')) {
    assert.equal(buildingLevel(data, save, b.id), 0, b.id);
  }
  assert.deepEqual(Object.values(baseBonuses(data, save)).filter(Boolean), [], 'no bonuses yet');
  assert.equal(campRank(data, save), 1);
});

test('upgrades check level, boss and resources, then deduct the cost', () => {
  const save = createNewSave({ worldSeed: 1 });
  assert.ok(upgradeBlockers(data, save, 'forge').some((b) => b.includes('level')));
  save.player.level = 3;
  assert.ok(upgradeBlockers(data, save, 'forge').some((b) => b.includes('scrap')));
  assert.throws(() => upgradeBuilding(data, save, 'forge'), /scrap/);
  const cost = data.base.buildings.find((b) => b.id === 'forge').levels[0];
  save.resources.scrap = cost.scrap + 5;
  save.resources.essence = cost.essence + 5;
  assert.deepEqual(upgradeBlockers(data, save, 'forge'), []);
  assert.equal(upgradeBuilding(data, save, 'forge'), 1);
  assert.deepEqual(save.resources, { scrap: 5, essence: 5, wood: 0, stone: 0, gold: 0, shards: 0, prismite: 0, spores: 0, aether: 0 });
  // Level 2 needs building materials too.
  save.player.level = 20;
  Object.assign(save.resources, { scrap: 9999, essence: 9999 });
  assert.ok(upgradeBlockers(data, save, 'forge').some((b) => /wood|stone/.test(b)), 'wood and stone are required');

  const s = rich();
  for (let i = 0; i < 3; i++) upgradeBuilding(data, s, 'forge');
  assert.ok(upgradeBlockers(data, s, 'forge').includes('Defeat a boss first'), 'Forge 4 needs a boss kill');
  s.bosses.defeated.inferno_titan = 1;
  s.player.level = 40;
  const max = maxLevel(data.base.buildings.find((b) => b.id === 'forge'));
  while (buildingLevel(data, s, 'forge') < max) upgradeBuilding(data, s, 'forge');
  assert.equal(buildingLevel(data, s, 'forge'), max);
  assert.ok(max >= 7, 'the forge goes up to level 7');
  assert.deepEqual(upgradeBlockers(data, s, 'forge'), ['Max level']);
});

test('buildings grant their bonuses to stats, inventory, research and crafting', () => {
  const save = rich();
  const before = computePlayerStats(data, save, null);
  const bagBefore = data.base.baseBag;
  syncInventoryCaps(data, save);
  assert.equal(save.inventory.bagSize, bagBefore);
  for (const id of ['hearth', 'hearth', 'training', 'training', 'vault', 'library']) upgradeBuilding(data, save, id);
  const after = computePlayerStats(data, save, null);
  assert.ok(after.maxHp > before.maxHp, 'Hearth adds max health');
  assert.ok(after.attackPower > before.attackPower && after.defense > before.defense, 'Training adds attack and defense');
  assert.equal(save.inventory.bagSize, bagBefore + 4, 'Vault adds bag slots');
  assert.equal(save.inventory.storageSize, data.base.baseStorage + 30);
  const comp = { research: 100 };
  assert.equal(researchCost(data, save, comp), 90, 'Library discounts research');
  for (const id of ['hearth', 'forge', 'vault', 'library', 'training', 'well', 'waystone']) {
    assert.ok(describeBonus(data, id, 1).length > 0, id);
  }
});

test('the Essence Well fills in real time, caps, and banks before upgrading', () => {
  const save = rich();
  const t0 = 1_000_000;
  upgradeBuilding(data, save, 'well', t0);
  const rate = baseBonuses(data, save).essencePerHour;
  assert.equal(wellPending(data, save, t0 + 2 * HOUR), 2 * rate);
  assert.equal(wellPending(data, save, t0 + 100 * HOUR), rate * data.base.wellCapHours, 'capped');
  const essence = save.resources.essence;
  assert.equal(collectWell(data, save, t0 + 3 * HOUR), 3 * rate);
  assert.equal(save.resources.essence, essence + 3 * rate);
  assert.equal(wellPending(data, save, t0 + 3 * HOUR), 0);
  // Upgrading banks what the old level produced.
  const before = save.resources.essence;
  upgradeBuilding(data, save, 'well', t0 + 5 * HOUR);
  const cost = data.base.buildings.find((b) => b.id === 'well').levels[1].essence;
  assert.equal(save.resources.essence, before + 2 * rate - cost);
});

test('old saves without a base get one (additive migration)', () => {
  const save = createNewSave({ worldSeed: 1 });
  delete save.base;
  delete save.inventory.favorites;
  delete save.inventory.unseen;
  const filled = fillDefaults(save);
  assert.deepEqual(filled.base.buildings, {});
  assert.deepEqual(filled.inventory.favorites, []);
  assert.deepEqual(filled.inventory.unseen, []);
  assert.equal(buildingLevel(data, filled, 'hearth'), 1);
});

test('weapon animation: wind-up, strike on the impact frame, follow-through', () => {
  for (const pattern of MELEE_PATTERNS) {
    const dur = attackDuration(pattern, 1.2);
    const hit = impactDelay(pattern, dur);
    assert.ok(hit > 0 && hit < dur, `${pattern} lands mid-animation`);
    const rest = restAngle(pattern, 0, 1);
    const start = weaponPose(pattern, { t: 0, dur, angle: 0, dir: 1 }, 0).angle;
    const impact = weaponPose(pattern, { t: hit, dur, angle: 0, dir: 1 }, 0);
    const end = weaponPose(pattern, { t: dur, dur, angle: 0, dir: 1 }, 0);
    assert.ok(Number.isFinite(start) && Number.isFinite(impact.angle) && Number.isFinite(end.angle));
    assert.ok(Number.isFinite(rest));
  }
  // A swing is winding up before the impact frame and striking right after it.
  const dur = attackDuration('swing', 1);
  const at = (t, dir = 1) => weaponPose('swing', { t, dur, angle: 0, dir }, 0);
  assert.equal(at(impactDelay('swing', dur) * 0.5).striking, false);
  assert.equal(at(impactDelay('swing', dur) + dur * 0.05).striking, true);
  assert.ok(at(impactDelay('swing', dur) + dur * 0.05).trail.length > 0, 'strike leaves a trail');
  // Alternating combo: the next swing comes from the other side.
  assert.ok(Math.sign(Math.sin(at(0.01, 1).angle)) !== Math.sign(Math.sin(at(0.01, -1).angle)));
  // Ranged attacks are instant: nothing to wait for.
  assert.equal(impactDelay('shoot', 0.3), 0);
  // Faster weapons animate faster, but never below a readable minimum.
  assert.ok(attackDuration('swing', 3) < attackDuration('swing', 1));
  assert.ok(attackDuration('swing', 100) >= 0.14);
});
