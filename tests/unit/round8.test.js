// Better pickaxes, a forge that explains itself, one fight per altar with
// more bosses, and legendary signature powers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import { World, T, SEA, ALTAR_CELL } from '../../src/game/world.js';
import { pickaxeDefs, pickaxeBlockers, forgePickaxe, harvestInfo, rollDrops } from '../../src/game/gathering.js';
import {
  craftCost, optionCost, optionTier, byTier, materialEffects, archetypeSummary, runeProblem,
} from '../../src/weapons/crafting.js';
import { generateWeapon } from '../../src/weapons/generator.js';
import { signatureFor, effectiveAbility } from '../../src/weapons/legendary.js';
import { loadData, seeds } from './helpers.js';

const data = loadData();

test('five pickaxes, each faster and dearer, each opening up harder stone', () => {
  const defs = pickaxeDefs(data);
  assert.equal(defs.length, 5);
  for (let i = 1; i < defs.length; i++) {
    assert.ok(defs[i].power > defs[i - 1].power, 'faster');
    assert.ok(defs[i].cost.essence > defs[i - 1].cost.essence, 'dearer');
    assert.ok(defs[i].requiresForge >= defs[i - 1].requiresForge);
  }
  // Every tier above the first unlocks something to mine.
  for (const def of defs.slice(1)) {
    assert.ok(Object.values(data.gathering.harvest).some((h) => h.tier === def.tier), `tier ${def.tier} mines something new`);
  }
  assert.equal(harvestInfo(data, T.OBSIDIAN).tier, 3);
  assert.ok(harvestInfo(data, T.ORE).drops.scrap, 'ore gives scrap');
  assert.ok(harvestInfo(data, T.STARSTONE).bonus.shards > 0, 'starstone can hold a Star Shard');
  // The best pickaxes bring in more.
  const ore = harvestInfo(data, T.ORE);
  const plain = rollDrops(ore, 1, () => 0.5);
  const rich = rollDrops(ore, defs[4].yield, () => 0.5);
  assert.ok(rich.scrap > plain.scrap);
  // The Starforged Pickaxe needs two different bosses beaten.
  const save = createNewSave({ worldSeed: 1 });
  save.base.buildings.forge = 5;
  Object.assign(save.resources, { scrap: 1e5, essence: 1e5, wood: 1e5, stone: 1e5 });
  for (let t = 1; t <= 4; t++) forgePickaxe(data, save, t);
  assert.ok(pickaxeBlockers(data, save, defs[4]).some((b) => /bosses/.test(b)));
  save.bosses.defeated = { inferno_titan: 1, frost_warden: 1 };
  forgePickaxe(data, save, 5);
  assert.equal(save.tools.pickaxe, 5);
});

test('the new stone shows up in its biomes', () => {
  const w = new World(data, 12345);
  const found = new Set();
  for (let cy = -40; cy <= 40 && found.size < 3; cy += 2) {
    for (let cx = -40; cx <= 40; cx += 2) {
      const c = w.getChunk(cx, cy);
      for (const b of c.block) if (b === T.OBSIDIAN || b === T.ORE || b === T.STARSTONE) found.add(b);
    }
    w.prune(1e9);
  }
  assert.equal(found.size, 3, 'obsidian, iron ore and starstone all exist');
});

test('forge options run from basic to best, and better picks cost more', () => {
  const mats = byTier('material', data.materials);
  for (let i = 1; i < mats.length; i++) assert.ok(optionTier('material', mats[i]) >= optionTier('material', mats[i - 1]));
  const cost = (kind, item) => {
    const c = optionCost(data, kind, item);
    return (c.essence ?? 0) + (c.scrap ?? 0);
  };
  for (let i = 1; i < mats.length; i++) assert.ok(cost('material', mats[i]) >= cost('material', mats[i - 1]));
  const cores = byTier('core', data.components.filter((c) => c.type === 'core'));
  for (let i = 1; i < cores.length; i++) assert.ok(cost('core', cores[i]) >= cost('core', cores[i - 1]));
  const runes = byTier('rune', data.modifiers);
  for (let i = 1; i < runes.length; i++) assert.ok(cost('rune', runes[i]) >= cost('rune', runes[i - 1]));
  assert.ok(cost('material', data.byId.materials.get('ancient')) > cost('material', data.byId.materials.get('iron')));
  // The total price follows the picks.
  const base = { archetype: 'sword', material: 'iron', catalyst: 'none' };
  const fancy = { ...base, material: 'dragonscale', core: 'inferno_core', rune: 'chain' };
  assert.ok(craftCost(data, fancy).essence > craftCost(data, base).essence + 250);
  // Everything has words to explain it.
  for (const m of data.materials) assert.ok(m.desc && materialEffects(m));
  assert.equal(materialEffects(data.byId.materials.get('iron')), 'No bonuses');
  assert.match(materialEffects(data.byId.materials.get('steel')), /\+6% damage/);
  for (const e of data.elements) assert.ok(e.desc, `${e.id} is explained`);
  assert.match(archetypeSummary(data.byId.archetypes.get('sword')), /Melee/);
  // Runes that can't go on a weapon say why.
  assert.ok(runeProblem(data, base, data.byId.modifiers.get('pierce')));
  assert.equal(runeProblem(data, base, data.byId.modifiers.get('dmg')), null);
});

test('eight bosses, each with a great altar; lesser altars dot the world', () => {
  // (The far lands' bosses rise only at lesser altars in their own lands.)
  const great = data.bosses.filter((b) => !b.far);
  assert.equal(great.length, 8);
  assert.equal(new Set(great.map((b) => b.biome)).size, 8, 'one boss per biome');
  assert.ok(data.bosses.filter((b) => b.far).every((b) => data.byId.biomes.get(b.biome)?.far), 'far bosses live in the far lands');
  for (const seed of [1, 777, 12345]) {
    const w = new World(data, seed);
    assert.equal(w.greatAltars().length, 8);
    const lesser = w.altarsNear(0, 0, 1200);
    assert.ok(lesser.length >= 10, `seed ${seed}: plenty of altars to find (${lesser.length})`);
    for (const a of lesser) {
      assert.ok(Math.hypot(a.x, a.y) > 200, 'never right next to camp');
      assert.ok(w.seaAt(a.x, a.y) < SEA.SHALLOW, 'on dry ground');
      assert.equal(a, w.altarForCell(Math.floor(a.x / ALTAR_CELL), Math.floor(a.y / ALTAR_CELL)), 'stable per cell');
    }
    // The guardian of a lesser altar belongs to the land around it.
    const local = lesser.filter((a) => data.byId.bosses.get(a.bossId).biome === w.biomeAt(Math.floor(a.x), Math.floor(a.y)).id);
    assert.ok(local.length >= lesser.length * 0.8);
  }
});

test('each altar can be beaten once; old saves remember the bosses they beat', () => {
  const save = createNewSave({ worldSeed: 9 });
  assert.deepEqual(save.world.altars, []);
  const old = createNewSave({ worldSeed: 9 });
  delete old.world.altars;
  old.bosses.defeated = { inferno_titan: 2, void_herald: 1 };
  assert.deepEqual(fillDefaults(old).world.altars.sort(), ['a:inferno_titan', 'a:void_herald']);
});

test('legendaries get a signature power: stable, element-themed and stronger than before', () => {
  let n = 0;
  for (const seed of seeds(60, 8)) {
    const dna = generateWeapon(data, { seed, level: 10, minRarity: 'legendary' });
    if (!dna.ability) continue;
    n++;
    const sig = signatureFor(data, dna);
    assert.ok(sig?.legendary, 'every legendary with an ability has a signature power');
    assert.deepEqual(signatureFor(data, dna), sig, 'the same weapon always gets the same power');
    const tpl = data.legendaryAbilities.find((a) => a.id === sig.id);
    if (data.legendaryAbilities.some((a) => a.affinity.includes(dna.element))) assert.ok(tpl.affinity.includes(dna.element));
    assert.ok(sig.cooldown >= tpl.cooldown[0] * 0.75 - 0.05 && sig.cooldown <= tpl.cooldown[1] + 0.05);
    assert.deepEqual(effectiveAbility(data, dna), sig, 'the power is what the weapon casts');
  }
  assert.ok(n > 30);
  // Epics keep their own ability.
  const epic = generateWeapon(data, { seed: 5, level: 10, minRarity: 'epic', maxRarity: 'epic' });
  assert.equal(signatureFor(data, epic), null);
  assert.ok(data.legendaryAbilities.length >= 8);
  const covered = new Set(data.legendaryAbilities.flatMap((a) => a.affinity));
  for (const e of data.elements) assert.ok(covered.has(e.id), `${e.id} legendaries have a power of their own`);
});
