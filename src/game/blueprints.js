// Blueprints: how rare they are and where they come from. One table in the
// data (`blueprintLoot`) decides it for single player and the server alike:
// per source (a chest, a ruin, a monster, an elite, a boss, a hard boss) the
// chance of a blueprint and how likely each tier is. Legendary blueprints
// are only in the hard bosses' table (great altars and the far lands'
// bosses). The first win over each boss gives a set reward, and a blueprint
// you already have turns into essence and scrap.

export const TIERS = ['common', 'rare', 'epic', 'legendary'];

const TIER_OF_RARITY = { common: 'common', uncommon: 'common', rare: 'rare', epic: 'epic', legendary: 'legendary' };

export function isBlueprint(def) {
  return def?.type === 'blueprint';
}

/** A blueprint's tier: common, rare, epic or legendary. */
export function blueprintTier(def) {
  return TIER_OF_RARITY[def?.rarity] ?? 'common';
}

/** Components that drop as they always have (cores, materials …): never blueprints. */
export function withoutBlueprints(data, ids) {
  return (ids ?? []).filter((id) => !isBlueprint(data.byId.components.get(id)));
}

const localCache = new WeakMap();

/**
 * Blueprint id → the biomes it belongs to. A camp blueprint (a structure or
 * a building) listed in a biome's `components` only turns up in that land;
 * weapon blueprints turn up anywhere.
 */
function localMap(data) {
  let m = localCache.get(data);
  if (!m) {
    m = new Map();
    for (const b of data.biomes) {
      for (const id of b.components) {
        const c = data.byId.components.get(id);
        if (!isBlueprint(c) || !(c.unlocks?.structures?.length || c.unlocks?.buildings?.length)) continue;
        if (!m.has(id)) m.set(id, new Set());
        m.get(id).add(b.id);
      }
    }
    localCache.set(data, m);
  }
  return m;
}

/** The blueprints of a tier that can turn up in a biome. */
export function blueprintPool(data, tier, biomeId = null) {
  const local = localMap(data);
  return data.components.filter((c) => isBlueprint(c) && blueprintTier(c) === tier
    && (!local.has(c.id) || (biomeId && local.get(c.id).has(biomeId))));
}

/** The hardest fights: a boss at its great altar, or one of the far lands' bosses. */
export function isHardBoss(def, altarKey = null) {
  if (def?.far) return true;
  return typeof altarKey === 'string' && altarKey.startsWith('a:') && !altarKey.startsWith('a:c');
}

/**
 * Rolls a source's table: a blueprint id, or null (most of the time).
 * `components` is what the player has found ({ id: { found } }): blueprints
 * not found yet are preferred, so duplicates only come once a tier is done.
 * `luck` raises the chance a little (never the tier).
 */
export function rollBlueprint(data, source, { biome = null, components = {}, luck = 0, rng = Math.random, sure = false } = {}) {
  const row = data.blueprintLoot?.sources?.[source];
  if (!row) return null;
  if (!sure && rng() >= row.chance * (1 + Math.min(50, Math.max(0, luck)) * 0.01)) return null;
  const weights = TIERS.map((t) => row.tiers[t] ?? 0);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let pick = rng() * total;
  let tierIdx = 0;
  while (tierIdx < weights.length - 1 && pick >= weights[tierIdx]) pick -= weights[tierIdx++];
  // A tier with nothing to give here falls back to the next lower one.
  for (let i = tierIdx; i >= 0; i--) {
    if (!weights[i] && i !== tierIdx) continue;
    const pool = blueprintPool(data, TIERS[i], biome);
    if (!pool.length) continue;
    const fresh = pool.filter((c) => !(components?.[c.id]?.found > 0));
    const list = fresh.length ? fresh : pool;
    return list[Math.floor(rng() * list.length) % list.length].id;
  }
  return null;
}

/** The set reward for the first win over a boss: a blueprint id, 'roll' (a sure roll of its table) or null. */
export function firstKillReward(data, bossId) {
  return data.blueprintLoot?.firstKill?.[bossId] ?? null;
}

/** What a duplicate blueprint turns into: { essence, scrap }. */
export function duplicateValue(data, def) {
  return data.blueprintLoot?.duplicate?.[blueprintTier(def)] ?? { essence: 10, scrap: 0 };
}

/** The odds of a source, for the odds panel: { chance, tiers: { tier: pct } }. */
export function sourceOdds(data, source) {
  const row = data.blueprintLoot?.sources?.[source];
  if (!row) return null;
  const total = TIERS.reduce((s, t) => s + (row.tiers[t] ?? 0), 0) || 1;
  return { chance: row.chance, tiers: Object.fromEntries(TIERS.map((t) => [t, ((row.tiers[t] ?? 0) * 100) / total])) };
}
