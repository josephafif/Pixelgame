// Gathering: pickaxes are forged at the Forge and used to chop trees and
// break rocks for wood and stone (building materials). Cleared tiles are
// remembered in the save; outside the camp they grow back after a while,
// inside the camp they stay cleared so you can build there.

import { BLOCKER_NAME } from './world.js';
import { buildingLevel, canAfford, pay, shortfalls } from './base.js';

const HARVEST_REACH = 1.35;
const REGROW_CHECK = 5;

export function pickaxeDefs(data) {
  return data.gathering?.pickaxes ?? [];
}

/** The pickaxe the player owns, or null. */
export function currentPickaxe(data, save) {
  const tier = save.tools?.pickaxe ?? 0;
  return pickaxeDefs(data).find((p) => p.tier === tier) ?? null;
}

export function nextPickaxe(data, save) {
  const tier = save.tools?.pickaxe ?? 0;
  return pickaxeDefs(data).find((p) => p.tier === tier + 1) ?? null;
}

/** Why a pickaxe can't be forged right now (empty = can). */
export function pickaxeBlockers(data, save, def) {
  if (!def) return ['Max tier'];
  const owned = save.tools?.pickaxe ?? 0;
  if (def.tier <= owned) return ['Already owned'];
  if (def.tier > owned + 1) return ['Forge the previous pickaxe first'];
  const out = [];
  const forge = buildingLevel(data, save, 'forge');
  if (forge < def.requiresForge) out.push(forge ? `Needs Forge level ${def.requiresForge}` : 'Build a Forge first');
  const bosses = Object.keys(save.bosses?.defeated ?? {}).length;
  if (def.requiresBosses && bosses < def.requiresBosses) out.push(`Defeat ${def.requiresBosses} different bosses first`);
  out.push(...shortfalls(save.resources, def.cost));
  return out;
}

/** Pays for and grants the next pickaxe. Throws with a readable reason. */
export function forgePickaxe(data, save, tier) {
  const def = pickaxeDefs(data).find((p) => p.tier === tier);
  const blockers = pickaxeBlockers(data, save, def);
  if (blockers.length) throw new Error(blockers[0]);
  if (!canAfford(save.resources, def.cost)) throw new Error('Not enough materials');
  pay(save.resources, def.cost);
  save.tools.pickaxe = def.tier;
  return def;
}

/** Harvest data for a blocker tile id (null when it can't be harvested). */
export function harvestInfo(data, tileId) {
  const name = BLOCKER_NAME[tileId];
  const info = name ? data.gathering?.harvest?.[name] : null;
  return info ? { key: name, ...info } : null;
}

/**
 * The harvestable tile next to the player, preferring the one they face.
 * Returns { tx, ty, x, y, info } or null.
 */
export function findHarvestTarget(game) {
  const p = game.player;
  const world = game.world;
  let best = null;
  let bestScore = Infinity;
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  for (let ty = py - 1; ty <= py + 1; ty++) {
    for (let tx = px - 1; tx <= px + 1; tx++) {
      const id = world.blockAt(tx, ty);
      if (!id) continue;
      const info = harvestInfo(game.data, id);
      if (!info) continue;
      const dx = tx + 0.5 - p.x;
      const dy = ty + 0.5 - p.y;
      const d = Math.hypot(dx, dy);
      if (d > HARVEST_REACH) continue;
      const facing = Math.cos(Math.atan2(dy, dx) - p.facing);
      const score = d - facing * 0.45;
      if (score < bestScore) {
        bestScore = score;
        best = { type: 'harvest', tx, ty, x: tx + 0.5, y: ty + 0.5, info };
      }
    }
  }
  return best;
}

/**
 * Rolls the drops for a felled tile, e.g. { wood: 4 }. Better pickaxes
 * bring in more (`yieldMult`); some tiles have a small chance of a bonus
 * (a Star Shard from starstone).
 */
export function rollDrops(info, yieldMult = 1, rng = Math.random) {
  const out = {};
  for (const [kind, [lo, hi]] of Object.entries(info.drops ?? {})) {
    out[kind] = Math.round((lo + Math.floor(rng() * (hi - lo + 1))) * yieldMult);
  }
  for (const [kind, chance] of Object.entries(info.bonus ?? {})) {
    if (rng() < chance) out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

/**
 * Regrows trees and rocks that were cleared long enough ago, except inside
 * the camp's build area (that land stays yours).
 */
export function regrow(game, now = Date.now()) {
  const world = game.world;
  const radius = game.buildRadius();
  for (const [key, [at, id]] of Object.entries(world.harvested)) {
    const info = harvestInfo(game.data, id);
    const minutes = info?.regrowMinutes ?? 20;
    if (now - at < minutes * 60000) continue;
    const [tx, ty] = key.split(',').map(Number);
    if (Math.hypot(tx + 0.5 - 0.5, ty + 0.5 - 0.5) <= radius + 1) continue;
    const p = game.player;
    if (Math.abs(p.x - (tx + 0.5)) < 1.2 && Math.abs(p.y - (ty + 0.5)) < 1.2) continue;
    if (game.enemies.some((e) => Math.abs(e.x - (tx + 0.5)) < 1 && Math.abs(e.y - (ty + 0.5)) < 1)) continue;
    world.restoreBlock(tx, ty);
  }
}

export const REGROW_INTERVAL = REGROW_CHECK;
