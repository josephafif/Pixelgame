// Weapon value, drop chances and the rarity rolls.
//
// Every weapon has a value in gold (what traders at markets pay), set by
// rarity, level and a little per-weapon variation from its seed. Legendaries
// are worth a fortune: finding one should feel like pulling a knife from a
// case. Normal loot never rolls above rare; epics and legendaries only come
// from a separate, small, seeded roll (or a Violet/Golden Catalyst).

import { hashInts } from '../core/rng.js';
import { rarityWeights } from '../weapons/generator.js';

// Base gold value per rarity.
const BASE_VALUE = { common: 4, uncommon: 12, rare: 40, epic: 140, legendary: 3200 };

// Chance that a weapon from each source is legendary / epic (before luck).
// Everything else rolls common → rare with the generator's weights.
export const LEGENDARY_CHANCE = { drop: 0.0015, elite: 0.005, chest: 0.004, boss: 0.03, market: 0 };
export const EPIC_CHANCE = { drop: 0.012, elite: 0.04, chest: 0.03, boss: 0.3, market: 0.1 };

// Chance that something drops a weapon at all.
export const WEAPON_DROP_CHANCE = { drop: 0.018, elite: 0.15, chest: 0.25, boss: 1 };

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

const luckMult = (luck) => 1 + Math.max(0, luck) * 0.02;

/** Legendary and epic chances for a source (luck nudges them a little). */
export function tierChances(source = 'drop', luck = 0) {
  return {
    legendary: (LEGENDARY_CHANCE[source] ?? LEGENDARY_CHANCE.drop) * luckMult(luck),
    epic: (EPIC_CHANCE[source] ?? EPIC_CHANCE.drop) * luckMult(luck),
  };
}

/**
 * Rarity limits for a weapon drop. Returns { minRarity, maxRarity }.
 * One uniform `roll` in [0, 1) (seeded by the caller) decides: below the
 * legendary chance → legendary, below legendary + epic → epic, otherwise
 * the drop is capped at rare. A minimum above rare is kept.
 */
export function dropRarity({ source = 'drop', minRarity = null, luck = 0, roll = Math.random() }) {
  if (minRarity === 'legendary') return { minRarity, maxRarity: 'legendary' };
  const c = tierChances(source, luck);
  if (roll < c.legendary) return { minRarity: 'legendary', maxRarity: 'legendary' };
  if (roll < c.legendary + c.epic || minRarity === 'epic') return { minRarity: 'epic', maxRarity: 'epic' };
  return { minRarity, maxRarity: 'rare' };
}

/**
 * The real odds of each rarity for a source, as fractions that sum to 1:
 * the legendary/epic rolls above, then the generator's weights (with your
 * level and luck) for common → rare. Forge rows use the catalyst's range.
 */
export function rarityOdds(data, { source = 'drop', minRarity = null, maxRarity = null, level = 1, luck = 0, forge = false }) {
  const out = Object.fromEntries(data.rarities.map((r) => [r.id, 0]));
  let rest = 1;
  let min = minRarity;
  let max = maxRarity;
  if (!forge) {
    if (minRarity === 'legendary') return { ...out, legendary: 1 };
    const c = tierChances(source, luck);
    out.legendary = c.legendary;
    if (minRarity === 'epic') {
      out.epic = 1 - c.legendary;
      return out;
    }
    out.epic = c.epic;
    rest = 1 - c.legendary - c.epic;
    max = 'rare';
  }
  const list = rarityWeights(data, { min, max, luck, lvl: level });
  const total = list.reduce((sum, x) => sum + x.weight, 0) || 1;
  for (const x of list) out[x.rarity.id] += (rest * x.weight) / total;
  return out;
}

/** Seeded [0, 1) roll for the n-th drop of a save. */
export function seededRoll(save, salt, n) {
  return hashInts(save.worldSeed, salt, n) / 4294967296;
}
