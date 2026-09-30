// Sailing: boats are built at the Forge (Tools) from wood, stone, scrap and
// essence. You carry your boat with you: at any shore, Use launches it onto
// the water; next to land, Use takes you ashore. Three boats, each better:
//   Log Raft       – slow, lakes and coastal (shallow) water only
//   Sailing Sloop  – faster and crosses the open sea
//   War Galleon    – fastest, and its hull takes much of the damage at sea

import { SAILABLE, T } from './world.js';
import { buildingLevel, canAfford, pay, shortfalls } from './base.js';

const anyBossDefeated = (save) => Object.values(save.bosses?.defeated ?? {}).some((n) => n > 0);

export function boatDefs(data) {
  return data.sailing?.boats ?? [];
}

/** The best boat the player owns, or null. */
export function currentBoat(data, save) {
  const tier = save.tools?.boat ?? 0;
  return boatDefs(data).find((b) => b.tier === tier) ?? null;
}

/** Why a boat can't be built right now (empty = can). */
export function boatBlockers(data, save, def) {
  if (!def) return ['Max tier'];
  const owned = save.tools?.boat ?? 0;
  if (def.tier <= owned) return ['Already owned'];
  if (def.tier > owned + 1) return ['Build the previous boat first'];
  const out = [];
  const forge = buildingLevel(data, save, 'forge');
  if (forge < def.requiresForge) out.push(forge ? `Needs Forge level ${def.requiresForge}` : 'Build a Forge first');
  if (def.requiresBoss && !anyBossDefeated(save)) out.push('Defeat a boss first');
  out.push(...shortfalls(save.resources, def.cost));
  return out;
}

/** Pays for and grants the next boat. Throws with a readable reason. */
export function buildBoat(data, save, tier) {
  const def = boatDefs(data).find((b) => b.tier === tier);
  const blockers = boatBlockers(data, save, def);
  if (blockers.length) throw new Error(blockers[0]);
  if (!canAfford(save.resources, def.cost)) throw new Error('Not enough materials');
  pay(save.resources, def.cost);
  save.tools.boat = def.tier;
  return def;
}

/** Collision mode for a boat: rafts stay out of deep water. */
export function boatMode(boat) {
  return boat?.openSea ? 'boat' : 'raft';
}

/** Can this boat float on tile (tx, ty)? */
export function sailableFor(world, tx, ty, boat) {
  const b = world.blockAt(tx, ty);
  return SAILABLE.has(b) && (boat?.openSea || b !== T.DEEP);
}

const NEAR = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/** The tile next to you that best matches where you face (for launching / landing). */
function bestNeighbour(p, test) {
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  let best = null;
  let bestScore = Infinity;
  const fx = Math.cos(p.facing);
  const fy = Math.sin(p.facing);
  for (const [dx, dy] of NEAR) {
    for (const reach of [1, 2]) {
      const tx = px + dx * reach;
      const ty = py + dy * reach;
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      const d = Math.hypot(cx - p.x, cy - p.y);
      if (d > 1.6 || !test(tx, ty)) continue;
      // Prefer close tiles in the direction you face.
      const score = d - ((cx - p.x) * fx + (cy - p.y) * fy) / (d || 1) * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = { tx, ty, x: cx, y: cy };
      }
    }
  }
  return best;
}

/**
 * On land: where you could launch your boat (or why not).
 * Returns { type: 'launch', x, y, boat } | { type: 'shore', reason } | null.
 */
export function findLaunch(game) {
  const { world, player: p } = game;
  const water = bestNeighbour(p, (tx, ty) => SAILABLE.has(world.blockAt(tx, ty)));
  if (!water) return null;
  const boat = currentBoat(game.data, game.save);
  const sea = world.isSea(water.x, water.y);
  if (!boat) return sea ? { type: 'shore', x: water.x, y: water.y, reason: 'Build a boat at the Forge (Tools) to sail' } : null;
  const spot = bestNeighbour(p, (tx, ty) => sailableFor(world, tx, ty, boat) && world.isFree(tx + 0.5, ty + 0.5, p.r, boatMode(boat)));
  if (!spot) return { type: 'shore', x: water.x, y: water.y, reason: `The ${boat.name} can't handle the open sea` };
  return { type: 'launch', ...spot, boat };
}

/** At sea: the land you could step onto, or null. */
export function findLanding(game) {
  const { world, player: p } = game;
  const spot = bestNeighbour(p, (tx, ty) => !world.blockedFor(tx, ty, 'player') && world.isFree(tx + 0.5, ty + 0.5, p.r));
  return spot ? { type: 'land', ...spot } : null;
}
