// The player's base (the camp at the world origin). Buildings are data
// driven (gamedata.json → base.buildings); each level has a cost and a
// player-level requirement, and grants a bonus per level. Pure functions,
// so they run in tests and in the game alike.

const HOUR_MS = 3600 * 1000;

/** Resources a building level can cost, in display order. */
export const COST_KEYS = ['scrap', 'essence', 'wood', 'stone'];

/** True when `resources` covers every entry of `cost`. */
export function canAfford(resources, cost) {
  return COST_KEYS.every((k) => (resources[k] ?? 0) >= (cost[k] ?? 0));
}

/** Subtracts `cost` from `resources` (call canAfford first). */
export function pay(resources, cost) {
  for (const k of COST_KEYS) if (cost[k]) resources[k] = (resources[k] ?? 0) - cost[k];
}

/** Human readable shortfalls, e.g. ["Needs 12 more wood"]. */
export function shortfalls(resources, cost) {
  const out = [];
  for (const k of COST_KEYS) {
    const missing = (cost[k] ?? 0) - (resources[k] ?? 0);
    if (missing > 0) out.push(`Needs ${missing} more ${k}`);
  }
  return out;
}

export function buildingDefs(data) {
  return data.base.buildings;
}

export function buildingDef(data, id) {
  return data.base.buildings.find((b) => b.id === id) ?? null;
}

export function buildingLevel(data, save, id) {
  const def = buildingDef(data, id);
  return save.base?.buildings?.[id] ?? def?.startLevel ?? 0;
}

export function maxLevel(def) {
  return def.levels.length;
}

/** Cost/requirements of the next level, or null when maxed. */
export function nextLevelInfo(data, save, id) {
  const def = buildingDef(data, id);
  const level = buildingLevel(data, save, id);
  if (!def || level >= maxLevel(def)) return null;
  return { level: level + 1, ...def.levels[level] };
}

/** Why the next level can't be bought right now (empty = can upgrade). */
export function upgradeBlockers(data, save, id) {
  const next = nextLevelInfo(data, save, id);
  if (!next) return ['Max level'];
  const out = [];
  if (save.player.level < next.playerLevel) out.push(`Requires level ${next.playerLevel}`);
  if (next.boss && !Object.keys(save.bosses?.defeated ?? {}).length) out.push('Defeat a boss first');
  out.push(...shortfalls(save.resources, next));
  return out;
}

/** Levels that count towards a building's per-level bonus. */
function bonusLevels(def, level) {
  return Math.max(0, level - (def.bonusFrom ?? 1) + 1);
}

/** Sums every building's per-level bonuses. */
export function baseBonuses(data, save) {
  const out = {
    maxHpPct: 0, attackPower: 0, defense: 0, storage: 0, bag: 0,
    craftDiscountPct: 0, craftLevel: 0, researchDiscountPct: 0, essencePerHour: 0,
  };
  for (const def of buildingDefs(data)) {
    const n = bonusLevels(def, buildingLevel(data, save, def.id));
    for (const [k, v] of Object.entries(def.perLevel ?? {})) out[k] = (out[k] ?? 0) + v * n;
  }
  return out;
}

/** Bag/storage capacity follows the Vault. */
export function syncInventoryCaps(data, save) {
  const b = baseBonuses(data, save);
  save.inventory.bagSize = data.base.baseBag + b.bag;
  save.inventory.storageSize = data.base.baseStorage + b.storage;
}

export function campRank(data, save) {
  return buildingDefs(data).reduce((sum, def) => sum + buildingLevel(data, save, def.id), 0);
}

// --- Essence Well --------------------------------------------------------------

export function wellPending(data, save, now = Date.now()) {
  const rate = baseBonuses(data, save).essencePerHour;
  if (!rate) return 0;
  const since = save.base?.wellAt ?? now;
  const hours = Math.min(data.base.wellCapHours, Math.max(0, now - since) / HOUR_MS);
  return Math.floor(rate * hours);
}

export function wellFull(data, save, now = Date.now()) {
  const rate = baseBonuses(data, save).essencePerHour;
  return rate > 0 && wellPending(data, save, now) >= Math.floor(rate * data.base.wellCapHours);
}

/** Moves pending essence into the player's resources. Returns the amount. */
export function collectWell(data, save, now = Date.now()) {
  const amount = wellPending(data, save, now);
  save.resources.essence += amount;
  save.base.wellAt = now;
  return amount;
}

// --- Upgrading -------------------------------------------------------------------

/**
 * Buys the next level of a building. Returns the new level, or throws with
 * a player-readable reason.
 */
export function upgradeBuilding(data, save, id, now = Date.now()) {
  const blockers = upgradeBlockers(data, save, id);
  if (blockers.length) throw new Error(blockers[0]);
  const next = nextLevelInfo(data, save, id);
  // Bank what the well produced at the old rate before changing it.
  if (id === 'well') {
    if (buildingLevel(data, save, 'well') > 0) collectWell(data, save, now);
    else save.base.wellAt = now;
  }
  pay(save.resources, next);
  save.base.buildings[id] = next.level;
  syncInventoryCaps(data, save);
  return next.level;
}

/** Research cost after Library discounts. */
export function researchCost(data, save, component) {
  const pct = baseBonuses(data, save).researchDiscountPct;
  return Math.ceil(component.research * (1 - Math.min(60, pct) / 100));
}

function catalystForForge(data, level) {
  const best = data.catalysts.filter((c) => c.requiresForge && c.requiresForge <= level).pop();
  return best ? best.name : null;
}

/** Human readable bonus of a building at a given level. */
export function describeBonus(data, id, level) {
  const def = buildingDef(data, id);
  if (!def) return '';
  if (level <= 0) return 'Not built';
  const n = bonusLevels(def, level);
  const p = def.perLevel ?? {};
  switch (id) {
    case 'hearth': {
      const area = data.building ? `camp area ${data.building.radius + data.building.radiusPerHearth * level} tiles` : null;
      return [n > 0 ? `+${p.maxHpPct * n}% max Health` : 'Rest to heal', area].filter(Boolean).join(' · ');
    }
    case 'forge':
      return [
        'Crafting',
        n > 0 ? `-${p.craftDiscountPct * n}% cost` : null,
        n > 0 ? `+${p.craftLevel * n} item level` : null,
        catalystForForge(data, level),
      ].filter(Boolean).join(' · ');
    case 'vault':
      return `+${p.storage * n} storage · +${p.bag * n} bag slots`;
    case 'library':
      return `-${p.researchDiscountPct * n}% research cost`;
    case 'training':
      return `+${p.attackPower * n} Attack Power · +${p.defense * n} Defense`;
    case 'well':
      return `${p.essencePerHour * n} essence per hour`;
    case 'waystone':
      return ['', 'Recall to camp', 'Recall + return'][level] ?? '';
    default:
      return '';
  }
}
