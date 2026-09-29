import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave } from '../../src/storage/save.js';
import { craftingOptions, validateCraft, buildCraftRequest, craftCost } from '../../src/weapons/crafting.js';
import { generateWeapon } from '../../src/weapons/generator.js';
import { auditWeapon } from '../../src/weapons/rules.js';
import { loadData } from './helpers.js';

const data = loadData();

function crafter() {
  const save = createNewSave({ worldSeed: 42 });
  save.player.level = 8;
  save.resources.scrap = 1000;
  save.resources.essence = 2000;
  save.components.fire_core = { found: 1, researched: true };
  save.components.inferno_core = { found: 1, researched: true };
  save.components.crystal_heart = { found: 1, researched: false };
  save.bosses.defeated.inferno_titan = 1;
  save.base.buildings.forge = 4;
  save.codex.modifiers.push('lifesteal', 'homing', 'freezing');
  save.codex.abilities.push('meteor', 'phoenix');
  return save;
}

test('crafting needs a Forge at the camp; better catalysts need a better Forge', () => {
  const save = createNewSave({ worldSeed: 1 });
  const errors = validateCraft(data, save, { archetype: 'sword', material: 'iron', catalyst: 'none' });
  assert.ok(errors.some((e) => e.includes('Forge')));
  const s = crafter();
  s.base.buildings.forge = 1;
  assert.ok(validateCraft(data, s, { archetype: 'sword', material: 'iron', catalyst: 'rare' }).some((e) => e.includes('Forge level 2')));
  s.base.buildings.forge = 2;
  assert.deepEqual(validateCraft(data, s, { archetype: 'sword', material: 'iron', catalyst: 'rare' }), []);
  s.base.buildings.forge = 4;
  assert.ok(validateCraft(data, s, { archetype: 'sword', material: 'iron', catalyst: 'legendary' }).some((e) => e.includes('Forge level 5')));
});

test('crafting costs grow with the player level; legendary catalysts are expensive', () => {
  const s = crafter();
  s.base.buildings.forge = 1;
  const choice = { archetype: 'sword', material: 'iron', catalyst: 'none' };
  s.player.level = 1;
  const low = craftCost(data, choice, s);
  s.player.level = 20;
  const high = craftCost(data, choice, s);
  assert.ok(high.essence > low.essence * 1.8 && high.scrap > low.scrap * 1.8);
  const golden = craftCost(data, { ...choice, catalyst: 'legendary' }, s);
  assert.ok(golden.essence >= 900, 'a golden catalyst costs a fortune');
});

test('Forge upgrades make crafting cheaper and crafted weapons stronger', () => {
  const s = crafter();
  const choice = { archetype: 'sword', material: 'iron', catalyst: 'none' };
  s.base.buildings.forge = 1;
  const cost1 = craftCost(data, choice, s);
  const level1 = buildCraftRequest(data, s, choice).level;
  s.base.buildings.forge = 3;
  const cost3 = craftCost(data, choice, s);
  assert.ok(cost3.scrap < cost1.scrap && cost3.essence < cost1.essence);
  assert.ok(buildCraftRequest(data, s, choice).level > level1);
});

test('options only offer researched components and known runes/abilities', () => {
  const opts = craftingOptions(data, crafter());
  assert.deepEqual(opts.cores.map((c) => c.id).sort(), ['fire_core', 'inferno_core']);
  assert.ok(!opts.blueprints.some((a) => a.id === 'orb'), 'crystal heart not researched yet');
  assert.deepEqual(opts.runes.map((m) => m.id).sort(), ['freezing', 'homing', 'lifesteal']);
  assert.ok(opts.abilities.some((a) => a.id === 'phoenix'));
});

test('invalid choices are explained', () => {
  const save = crafter();
  const errs = (choice) => validateCraft(data, save, { catalyst: 'none', ...choice });
  assert.ok(errs({ archetype: 'sword', material: 'oak' }).some((e) => e.includes('material')));
  assert.ok(errs({ archetype: 'sword', material: 'iron', rune: 'homing' }).some((e) => e.includes('Homing')));
  assert.ok(errs({ archetype: 'sword', material: 'iron', core: 'fire_core', rune: 'freezing' }).length > 0, 'fire core + freezing is contradictory');
  assert.ok(errs({ archetype: 'sword', material: 'iron', ability: 'meteor' }).some((e) => e.includes('catalyst')));
  const poor = crafter();
  poor.resources.essence = 0;
  assert.ok(validateCraft(data, poor, { archetype: 'sword', material: 'iron', catalyst: 'none' }).some((e) => e.includes('essence')));
});

test('crafted weapons honour the chosen components', () => {
  const save = crafter();
  const choice = { archetype: 'axe', material: 'steel', core: 'inferno_core', rune: 'lifesteal', catalyst: 'epic', ability: 'phoenix' };
  assert.deepEqual(validateCraft(data, save, choice), []);
  save.base.buildings.forge = 5;
  assert.deepEqual(validateCraft(data, save, { ...choice, catalyst: 'legendary' }), []);
  save.base.buildings.forge = 4;
  for (let i = 0; i < 25; i++) {
    save.counters.craft = i;
    const dna = generateWeapon(data, buildCraftRequest(data, save, choice));
    assert.equal(dna.archetype, 'axe');
    assert.equal(dna.material, 'steel');
    assert.equal(dna.element, 'fire');
    assert.ok(dna.modifiers.some((m) => m.id === 'lifesteal'), 'rune applied');
    assert.equal(dna.ability?.id, 'phoenix');
    assert.ok(['epic'].includes(dna.rarity));
    assert.equal(dna.ctx.src, 'craft');
    assert.deepEqual(auditWeapon(data, dna), []);
  }
  const cost = craftCost(data, choice);
  assert.ok(cost.essence > craftCost(data, { catalyst: 'none' }).essence);
});

test('crafting the same choice twice gives different weapons', () => {
  const save = crafter();
  const choice = { archetype: 'sword', material: 'iron', catalyst: 'none' };
  save.counters.craft = 0;
  const a = generateWeapon(data, buildCraftRequest(data, save, choice));
  save.counters.craft = 1;
  const b = generateWeapon(data, buildCraftRequest(data, save, choice));
  assert.notEqual(a.seed, b.seed);
  assert.notDeepEqual(a.stats, b.stats);
});
