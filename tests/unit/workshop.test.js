import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forgeWeapon, makeModifier, makeEffect, makeAbility, makeDrawback, changeArchetype, recomputeStats, newLook, newName,
  encodeWeaponCode, decodeWeaponCode, workshopCopy, workshopProblems, fingerprint,
} from '../../src/weapons/workshop.js';
import { encodeDnaCode, validateDna } from '../../src/weapons/dna.js';
import { compileWeapon } from '../../src/game/combat.js';
import { effectiveAbility } from '../../src/weapons/legendary.js';
import { loadData } from './helpers.js';

const data = loadData();

test('workshop: forge any rarity, type, material, element and ability', () => {
  for (const rarity of data.rarities.map((r) => r.id)) {
    const w = forgeWeapon(data, { seed: 7, rarity, archetype: 'staff', element: 'lightning', ability: 'meteor' });
    assert.equal(w.rarity, rarity);
    assert.equal(w.archetype, 'staff');
    assert.equal(w.element, 'lightning');
    assert.equal(w.ability?.id, 'meteor', `${rarity} gets the ability too`);
    assert.deepEqual(workshopProblems(data, w), []);
  }
});

test('workshop: modifiers, effects, abilities and drawbacks are built like the generator builds them', () => {
  let w = forgeWeapon(data, { seed: 11, rarity: 'rare', archetype: 'sword' });
  const before = w.stats.damage;
  w = recomputeStats(data, { ...w, modifiers: [...w.modifiers, makeModifier(data, 'dmg', 30)] });
  assert.ok(w.stats.damage > before, 'more damage');
  assert.ok(w.modifiers.some((m) => m.label === '+30% Damage'));
  w = { ...w, effects: [makeEffect(data, data.effects[0].id)], drawback: makeDrawback(data, data.drawbacks[0].id) };
  w = recomputeStats(data, w);
  assert.ok(Object.keys(w.playerBonuses).length > 0, 'the drawback reaches the player');
  w = { ...w, ability: makeAbility(data, 'earthquake', { element: 'fire', twist: 'twin', power: 1 }) };
  assert.match(w.ability.name, /Twin/);
  const compiled = compileWeapon(w, data);
  assert.ok(compiled.hooks.attack.length + compiled.hooks.hit.length > 0, 'hooks compile');
  assert.equal(compiled.ability.id, 'earthquake');
  assert.deepEqual(validateDna(w), []);
});

test('workshop: a weapon changes type, and keeps its modifiers', () => {
  const sword = forgeWeapon(data, { seed: 3, rarity: 'epic', archetype: 'sword' });
  const bow = changeArchetype(data, sword, 'bow');
  assert.equal(bow.archetype, 'bow');
  assert.equal(bow.class, 'ranged');
  assert.equal(bow.attack.pattern, data.byId.archetypes.get('bow').attack.pattern);
  assert.ok(bow.stats.projectiles >= 1, 'a bow shoots');
  assert.deepEqual(bow.modifiers.map((m) => m.id), sword.modifiers.map((m) => m.id));
  assert.ok(data.materials.find((m) => m.id === bow.material).kinds.some((k) => data.byId.archetypes.get('bow').kinds.includes(k)), 'a material that fits');
  assert.deepEqual(workshopProblems(data, bow), []);
  assert.notEqual(newLook(data, bow, 1).variant, undefined);
  assert.ok(newName(data, bow, 2).text.length > 2);
});

test('workshop: a legendary may name its power', () => {
  const w = forgeWeapon(data, { seed: 5, rarity: 'legendary', ability: 'meteor' });
  for (const sig of data.legendaryAbilities) {
    assert.equal(effectiveAbility(data, { ...w, signature: sig.id }).id, sig.id);
  }
});

test('workshop codes carry the whole weapon; old codes still open', async () => {
  const w = forgeWeapon(data, { seed: 21, rarity: 'legendary', archetype: 'axe', element: 'void' });
  const edited = { ...w, name: { ...w.name, text: 'Nothing Like It' }, stats: { ...w.stats, damage: 9999 }, visual: { ...w.visual, palette: { ...w.visual.palette, accent: '#123456' } } };
  const code = await encodeWeaponCode(edited);
  assert.match(code, /^PGX[01]\./);
  const back = await decodeWeaponCode(data, code);
  assert.equal(fingerprint(back), fingerprint(edited));
  assert.equal(back.stats.damage, 9999);
  // A seed code (PGW1) is rebuilt by the generator.
  const plain = forgeWeapon(data, { seed: 99 });
  assert.equal(fingerprint(await decodeWeaponCode(data, encodeDnaCode(plain))), fingerprint(plain));
  await assert.rejects(decodeWeaponCode(data, 'PGX1.garbage'), /not a weapon code/);
  await assert.rejects(decodeWeaponCode(data, 'hello'), /not a weapon code/);
  // A copy for your bag gets its own id and a Workshop mark.
  const copy = workshopCopy(edited);
  assert.notEqual(copy.id, edited.id);
  assert.equal(copy.custom, true);
});
