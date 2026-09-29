// Weapon crafting (spec §17): Blueprint + Material + Core (element) +
// Modifier rune + Catalyst (+ optional unlocked Ability) → the procedural
// generator. Pure logic; works offline and in tests.

import { hashInts } from '../core/rng.js';
import { buildPool } from './pool.js';
import { createRuleState, incompatibility } from './rules.js';

export function researchedComponents(save) {
  return Object.entries(save.components)
    .filter(([, c]) => c.researched)
    .map(([id]) => id)
    .sort();
}

export function isCraftingUnlocked(data, save) {
  return save.player.level >= data.crafting.unlockLevel;
}

function anyBossDefeated(save) {
  return Object.keys(save.bosses?.defeated ?? {}).length > 0;
}

export function catalystAvailability(data, save, catalyst) {
  if (catalyst.requiresLevel && save.player.level < catalyst.requiresLevel) {
    return `Requires level ${catalyst.requiresLevel}`;
  }
  if (catalyst.requiresBoss && !anyBossDefeated(save)) return 'Defeat a boss first';
  return null;
}

/** Everything the crafting UI can offer right now. */
export function craftingOptions(data, save) {
  const researched = researchedComponents(save);
  const pool = buildPool(data, researched);
  const knownMods = new Set(save.codex.modifiers);
  const knownAbilities = new Set(save.codex.abilities);
  return {
    blueprints: pool.archetypes,
    materialsFor(archetypeId) {
      const a = data.byId.archetypes.get(archetypeId);
      return a ? pool.materials.filter((m) => m.kinds.some((k) => a.kinds.includes(k))) : [];
    },
    cores: researched.map((id) => data.byId.components.get(id)).filter((c) => c.type === 'core'),
    runes: pool.modifiers.filter((m) => knownMods.has(m.id)),
    abilities: pool.abilities.filter((a) => knownAbilities.has(a.id)),
    catalysts: data.catalysts.map((c) => ({ ...c, locked: catalystAvailability(data, save, c) })),
  };
}

export function craftCost(data, choice) {
  const catalyst = data.byId.catalysts.get(choice.catalyst ?? 'none');
  const cfg = data.crafting;
  return {
    scrap: cfg.scrapCost + (catalyst ? data.catalysts.indexOf(catalyst) * 10 : 0),
    essence: cfg.essenceCost + (catalyst?.essence ?? 0) + (choice.rune ? cfg.runeCost : 0)
      + (choice.ability ? cfg.abilityCost : 0),
  };
}

/** Returns a list of reasons the choice can't be crafted (empty = ok). */
export function validateCraft(data, save, choice) {
  const errors = [];
  if (!isCraftingUnlocked(data, save)) errors.push(`Crafting unlocks at level ${data.crafting.unlockLevel}`);
  const opts = craftingOptions(data, save);
  const archetype = opts.blueprints.find((a) => a.id === choice.archetype);
  if (!archetype) errors.push('Choose a known blueprint');
  const material = archetype && opts.materialsFor(archetype.id).find((m) => m.id === choice.material);
  if (archetype && !material) errors.push('Choose a material that fits the blueprint');
  const core = choice.core ? opts.cores.find((c) => c.id === choice.core) : null;
  if (choice.core && !core) errors.push('That core has not been researched');
  const catalyst = data.byId.catalysts.get(choice.catalyst ?? 'none');
  if (!catalyst) errors.push('Unknown catalyst');
  else {
    const locked = catalystAvailability(data, save, catalyst);
    if (locked) errors.push(locked);
  }
  if (choice.rune) {
    const rune = opts.runes.find((m) => m.id === choice.rune);
    if (!rune) errors.push('That modifier rune is unknown');
    else if (archetype && catalyst) {
      const rarity = data.byId.rarities.get(catalyst.maxRarity);
      const state = createRuleState(data, { archetype, rarity, element: core?.element ?? 'physical' });
      const why = incompatibility(rune, state, 'modifier');
      if (why) errors.push(`${rune.name} can't go on this weapon (${why})`);
    }
  }
  if (choice.ability) {
    if (!opts.abilities.some((a) => a.id === choice.ability)) errors.push('That ability is not unlocked');
    const minIdx = catalyst ? data.rarityIndex.get(catalyst.minRarity) : 0;
    if (minIdx < data.rarityIndex.get('epic')) errors.push('Abilities need a Violet or Golden catalyst');
  }
  const cost = craftCost(data, choice);
  if (save.resources.scrap < cost.scrap) errors.push(`Needs ${cost.scrap} scrap`);
  if (save.resources.essence < cost.essence) errors.push(`Needs ${cost.essence} essence`);
  return errors;
}

/** Generator request for a validated choice. Deterministic per save. */
export function buildCraftRequest(data, save, choice, luck = 0) {
  const catalyst = data.byId.catalysts.get(choice.catalyst ?? 'none');
  return {
    seed: hashInts(save.worldSeed, 0xc4af7, save.counters.craft),
    level: save.player.level,
    luck,
    source: 'craft',
    unlocked: researchedComponents(save),
    minRarity: catalyst.minRarity,
    maxRarity: catalyst.maxRarity,
    craft: {
      archetype: choice.archetype,
      material: choice.material,
      core: choice.core ?? null,
      rune: choice.rune ?? null,
      ability: choice.ability ?? null,
    },
  };
}
