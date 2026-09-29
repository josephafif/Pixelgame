// Weapon value and the legendary drop roll.
//
// Every weapon has a value in gold (what traders at markets pay), set by
// rarity, level and a little per-weapon variation from its seed. Legendaries
// are worth a fortune: finding one should feel like pulling a knife from a
// case. Normal loot never rolls above epic; legendaries only come from a
// separate, tiny, seeded roll (or a boss's jackpot, or a Golden Catalyst).

import { hashInts } from '../core/rng.js';

// Base gold value per rarity.
const BASE_VALUE = { common: 4, uncommon: 12, rare: 40, epic: 140, legendary: 3200 };

// Chance that a drop from each source is legendary (before luck).
export const LEGENDARY_CHANCE = { drop: 0.0015, elite: 0.005, chest: 0.004, boss: 0.03, market: 0 };

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

/**
 * Rarity limits for a weapon drop. Returns { minRarity, maxRarity }:
 * usually capped at epic, with a tiny seeded chance of a legendary.
 * `roll` is a number in [0, 1) (seeded by the caller for reproducibility).
 */
export function dropRarity({ source = 'drop', minRarity = null, luck = 0, roll = Math.random() }) {
  if (minRarity === 'legendary') return { minRarity, maxRarity: 'legendary' };
  const chance = (LEGENDARY_CHANCE[source] ?? LEGENDARY_CHANCE.drop) * (1 + Math.max(0, luck) * 0.02);
  if (roll < chance) return { minRarity: 'legendary', maxRarity: 'legendary' };
  return { minRarity, maxRarity: 'epic' };
}

/** Seeded [0, 1) roll for the n-th drop of a save. */
export function seededRoll(save, salt, n) {
  return hashInts(save.worldSeed, salt, n) / 4294967296;
}
