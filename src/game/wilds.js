// How many monsters roam the wild and how far they see. Shared by single
// player (enemies.js) and the server (server/enemies.js), so both feel the
// same: a few monsters around you by day, more at night (daynight.js), and
// they only notice you when you come fairly close.

import { spawnFactor } from './daynight.js';

/** How far monsters notice you, as a share of the sight in their data. */
export const SIGHT_SCALE = 0.6;

/** How far a monster notices you (tiles). */
export function sightOf(def) {
  return (def?.sight ?? 7) * SIGHT_SCALE;
}

/** Most monsters around one player, however far out (before day and night). */
const CAP = 10;

/**
 * How many monsters roam around a player in the wild: grows with the
 * world's level (and a little with yours), shrinks by day and grows at
 * night, and a biome can have fewer (`spawnScale`). With others close by
 * (multiplayer) there are a few more, never double.
 */
export function wildTarget({ worldLevel, playerLevel = 0, others = 0, darkness = 0, biome = null }) {
  const base = Math.min(CAP, 2.5 + worldLevel * 0.9 + playerLevel / 6);
  const group = Math.min(1 + others * 0.3, 2);
  return Math.round(base * group * spawnFactor(darkness) * (biome?.spawnScale ?? 1));
}

/** How many sea monsters swim around a sailor. */
export function seaTarget(worldLevel) {
  return Math.min(4, 1 + Math.floor(worldLevel / 3));
}
