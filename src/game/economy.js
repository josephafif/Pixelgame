// Weapon value, drop chances and the rarity rolls.
//
// Every weapon has a value in gold (what traders at markets pay), set by
// rarity, level and a little per-weapon variation from its seed. A weapon
// you find is a base weapon, common to rare (docs/WEAPON-EVOLUTION.md):
// epics and legendaries are never found, they are grown in the weapon's
// tree (src/weapons/evolution.js).

import { hashInts } from '../core/rng.js';
import { rarityWeights } from '../weapons/generator.js';

// Base gold value per rarity.
const BASE_VALUE = { common: 4, uncommon: 12, rare: 40, epic: 140, legendary: 3200 };

/** The best rarity a found (or bought) weapon can have. */
export const FOUND_MAX_RARITY = 'rare';

// Chance that something drops a weapon at all. Monsters never do: weapons
// are found exploring (chests, ruins, buried treasure), from elites now and
// then, and every boss drops one.
export const WEAPON_DROP_CHANCE = { drop: 0, elite: 0.05, chest: 0.08, boss: 1 };

/** Gold value of a weapon (deterministic per weapon). */
export function weaponValue(dna) {
  const base = BASE_VALUE[dna.rarity] ?? 4;
  const lvl = dna.ctx?.lvl ?? 1;
  const spread = ((dna.seed >>> 0) % 1000) / 1000; // 0..1, fixed per weapon
  const power = dna.power?.budget ? Math.min(1, dna.power.used / dna.power.budget) : 0.5;
  return Math.max(1, Math.round(base * (1 + lvl * 0.06) * (0.85 + 0.3 * spread) * (0.9 + 0.2 * power)));
}

/** What a trader pays you for it (they take a cut). */
export function sellPrice(dna) {
  return Math.max(1, Math.floor(weaponValue(dna) * 0.6));
}

/** What a trader asks for it. */
export function buyPrice(dna) {
  return Math.ceil(weaponValue(dna) * 1.7);
}

const RANKS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/**
 * Rarity limits for a found weapon: { minRarity, maxRarity }. Never above
 * rare (a higher floor is lowered to rare).
 */
export function dropRarity({ minRarity = null } = {}) {
  const cap = RANKS.indexOf(FOUND_MAX_RARITY);
  const min = minRarity && RANKS.indexOf(minRarity) > cap ? FOUND_MAX_RARITY : minRarity;
  return { minRarity: min, maxRarity: FOUND_MAX_RARITY };
}

/**
 * The real odds of each rarity for a source, as fractions that sum to 1:
 * the generator's weights (with your level and luck) between the limits.
 * Forge rows use the catalyst's range.
 */
export function rarityOdds(data, { minRarity = null, maxRarity = null, level = 1, luck = 0, forge = false }) {
  const out = Object.fromEntries(data.rarities.map((r) => [r.id, 0]));
  const lim = forge ? { minRarity, maxRarity } : dropRarity({ minRarity });
  const list = rarityWeights(data, { min: lim.minRarity, max: lim.maxRarity, luck, lvl: level });
  const total = list.reduce((sum, x) => sum + x.weight, 0) || 1;
  for (const x of list) out[x.rarity.id] += x.weight / total;
  return out;
}

/** Seeded [0, 1) roll for the n-th drop of a save. */
export function seededRoll(save, salt, n) {
  return hashInts(save.worldSeed, salt, n) / 4294967296;
}
