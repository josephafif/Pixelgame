// Weapon crafting (spec §17): Blueprint + Material + Core (element) +
// Modifier rune + Catalyst (+ optional unlocked Ability) → the procedural
// generator. Pure logic; works offline and in tests.

import { hashInts } from '../core/rng.js';
import { buildPool } from './pool.js';
import { createRuleState, incompatibility } from './rules.js';
import { buildingLevel, baseBonuses } from '../game/base.js';

export function researchedComponents(save) {
  return Object.entries(save.components)
    .filter(([, c]) => c.researched)
    .map(([id]) => id)
    .sort();
}

/** Crafting needs a Forge at the base. */
export function isCraftingUnlocked(data, save) {
  return buildingLevel(data, save, 'forge') >= 1;
}

function anyBossDefeated(save) {
  return Object.keys(save.bosses?.defeated ?? {}).length > 0;
}

export function catalystAvailability(data, save, catalyst) {
  if (catalyst.requiresForge && buildingLevel(data, save, 'forge') < catalyst.requiresForge) {
    return `Forge level ${catalyst.requiresForge}`;
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

/** Tier (1 = basic … 5 = masterwork) of a material, element core or rune. */
export function optionTier(kind, item) {
  if (!item) return 0;
  return (kind === 'rune' ? item.runeTier : item.tier) ?? 1;
}

/** What picking this material / core / rune adds to the price. */
export function optionCost(data, kind, item) {
  if (!item) return {};
  const table = { material: data.crafting.materialCost, core: data.crafting.coreCost, rune: data.crafting.runeCost }[kind];
  return table?.[optionTier(kind, item) - 1] ?? {};
}

/** Options sorted from basic to best (then cheapest first, then by name). */
export function byTier(kind, list) {
  return [...list].sort((a, b) => optionTier(kind, a) - optionTier(kind, b) || a.name.localeCompare(b.name));
}

/**
 * Cost of a craft: a base price, plus the catalyst, plus every better
 * material, element core and rune you pick. With a `save`, the price grows
 * with the player's level (income grows too) and the Forge's level
 * discounts it.
 */
export function craftCost(data, choice, save = null) {
  const catalyst = data.byId.catalysts.get(choice.catalyst ?? 'none');
  const cfg = data.crafting;
  const scale = save ? 1 + ((cfg.levelScalePct ?? 0) / 100) * (save.player.level - 1) : 1;
  const keep = (1 - (save ? baseBonuses(data, save).craftDiscountPct : 0) / 100) * scale;
  const extras = [
    optionCost(data, 'material', data.byId.materials.get(choice.material)),
    optionCost(data, 'core', choice.core ? data.byId.components.get(choice.core) : null),
    optionCost(data, 'rune', choice.rune ? data.byId.modifiers.get(choice.rune) : null),
  ];
  const extra = (k) => extras.reduce((sum, c) => sum + (c[k] ?? 0), 0);
  return {
    scrap: Math.ceil((cfg.scrapCost + (catalyst?.scrap ?? 0) + extra('scrap')) * keep),
    essence: Math.ceil((cfg.essenceCost + (catalyst?.essence ?? 0) + extra('essence')
      + (choice.ability ? cfg.abilityCost : 0)) * keep),
    // Star Shards (Golden Catalyst) are never discounted.
    shards: catalyst?.shards ?? 0,
  };
}

/** A material's effect in words, e.g. "+6% damage · +1% crit chance". */
export function materialEffects(m) {
  const pct = (x) => Math.round((x - 1) * 100);
  const out = [];
  const st = m.stats ?? {};
  const add = (v, label) => {
    if (v) out.push(`${v > 0 ? '+' : '−'}${Math.abs(v)}% ${label}`);
  };
  add(pct(st.damage ?? 1), 'damage');
  add(pct(st.attackSpeed ?? 1), 'attack speed');
  add(pct(st.range ?? 1), 'reach');
  add(st.crit ?? 0, 'crit chance');
  return out.length ? out.join(' · ') : 'No bonuses';
}

/** A weapon type in words: how it attacks and its base numbers. */
export function archetypeSummary(a) {
  const b = a.base;
  const style = {
    melee: 'Melee', ranged: 'Ranged', special: 'Special',
  }[a.class] ?? a.class;
  const span = ([lo, hi], d = 0) => `${lo.toFixed(d)}–${hi.toFixed(d)}`;
  return `${style} · ${span(b.damage)} damage · ${span(b.attackSpeed, 1)} attacks/s · reach ${span(b.range, 1)}`;
}

/** Why a rune can't go on the weapon being forged (null = it can). */
export function runeProblem(data, choice, rune) {
  const archetype = data.byId.archetypes.get(choice.archetype);
  const catalyst = data.byId.catalysts.get(choice.catalyst ?? 'none');
  if (!archetype || !catalyst || !rune) return null;
  const core = choice.core ? data.byId.components.get(choice.core) : null;
  const state = createRuleState(data, {
    archetype, rarity: data.byId.rarities.get(catalyst.maxRarity), element: core?.element ?? 'physical',
  });
  return incompatibility(rune, state, 'modifier');
}

/** Returns a list of reasons the choice can't be crafted (empty = ok). */
export function validateCraft(data, save, choice) {
  const errors = [];
  if (!isCraftingUnlocked(data, save)) errors.push('Build a Forge at your camp first');
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
  const cost = craftCost(data, choice, save);
  if (save.resources.scrap < cost.scrap) errors.push(`Needs ${cost.scrap} scrap`);
  if (save.resources.essence < cost.essence) errors.push(`Needs ${cost.essence} essence`);
  if (cost.shards && (save.resources.shards ?? 0) < cost.shards) errors.push(`Needs ${cost.shards} Star Shards (from bosses)`);
  return errors;
}

/** Generator request for a validated choice. Deterministic per save. */
export function buildCraftRequest(data, save, choice, luck = 0) {
  const catalyst = data.byId.catalysts.get(choice.catalyst ?? 'none');
  return {
    seed: hashInts(save.worldSeed, 0xc4af7, save.counters.craft),
    level: save.player.level + baseBonuses(data, save).craftLevel,
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
