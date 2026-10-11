// Light sources. Torches, fires and glowing stones light up the land around
// them (the renderer draws the glow and, at night, the dark between them),
// and monsters shun the light of fire: they never come into a torch's or a
// camp fire's circle, and flee out of it (bosses don't care). Lava, lumen
// caps and crystals only glow. Shared by single player and the server.

import { T } from './world.js';

/** Structures that give light: radius (tiles), colour, and whether monsters shun it. */
export const STRUCTURE_LIGHTS = {
  torch: { r: 4.5, color: 'warm', scare: true },
  flame_turret: { r: 3.2, color: 'warm', scare: true },
  sunfire_obelisk: { r: 5.5, color: 'gold', scare: true },
  prism_relay: { r: 2.6, color: 'cyan', scare: false },
  wind_beacon: { r: 2.4, color: 'pale', scare: false },
  // The camp's buildings in multiplayer (in single player the camp itself: campLights).
  b_hearth: { r: 7, color: 'warm', scare: true },
  b_forge: { r: 4, color: 'warm', scare: true },
};

/** Tiles that glow (never scary): radius, colour and strength (k). */
export const TILE_LIGHTS = new Map([
  [T.LAVA, { r: 2.2, color: 'lava', k: 0.8 }],
  [T.LUMENCAP, { r: 2.4, color: 'lumen', k: 0.6 }],
  [T.CRYSTAL, { r: 1.8, color: 'violet', k: 0.55 }],
  [T.PRISM, { r: 1.6, color: 'cyan', k: 0.35 }],
  [T.AETHERCRYSTAL, { r: 1.8, color: 'pale', k: 0.4 }],
  [T.STARSTONE, { r: 1.5, color: 'gold', k: 0.55 }],
]);

/** The camp's own fires in single player: the hearth (with its fire) and the forge. */
export function campLights(data, buildingLevel) {
  const out = [];
  for (const [id, r] of [['hearth', 7], ['forge', 4]]) {
    const def = data.base?.buildings?.find((b) => b.id === id);
    if (!def || (buildingLevel?.(id) ?? 1) <= 0) continue;
    out.push({ x: def.x ?? 0.5, y: def.y ?? 0.5, r, color: 'warm', scare: true });
  }
  return out;
}

const cache = new WeakMap();

/**
 * The lights monsters shun, gathered from the world's structures (and
 * `extra`, the camp's fires), at most once a second: [{ x, y, r }].
 */
export function scaryLights(world, now, extra = null) {
  let c = cache.get(world);
  if (c && now - c.at < 1000) return c.list;
  const list = [];
  for (const st of world.structures.values()) {
    const L = STRUCTURE_LIGHTS[st.id];
    if (L?.scare && !st.dead) list.push({ x: st.x + 0.5, y: st.y + 0.5, r: L.r });
  }
  for (const L of extra ?? []) if (L.scare) list.push({ x: L.x, y: L.y, r: L.r });
  c = { at: now, list };
  cache.set(world, c);
  return list;
}

/** The light (of `lights`) whose circle (x, y) is in, or null. */
export function litBy(lights, x, y, margin = 0) {
  for (const L of lights) {
    const r = L.r + margin;
    const dx = x - L.x;
    const dy = y - L.y;
    if (dx * dx + dy * dy < r * r) return L;
  }
  return null;
}

/**
 * A monster shuns the light: inside a fire's circle it hurries out; at its
 * edge it never steps further in (it can only wait there, or go round).
 * Changes the monster's velocity (vx, vy) in place.
 */
export function shunLight(lights, e, speed) {
  if (!lights.length || e.boss) return;
  const L = litBy(lights, e.x, e.y, 1.2);
  if (!L) return;
  const dx = e.x - L.x;
  const dy = e.y - L.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = dx / d;
  const ny = dy / d;
  if (d < L.r) {
    // Inside: out, now.
    e.vx = nx * speed * 1.2;
    e.vy = ny * speed * 1.2;
    e.fleeLight = true;
    return;
  }
  // At the edge: no step inwards.
  const inward = -(e.vx * nx + e.vy * ny);
  if (inward > 0) {
    e.vx += nx * inward;
    e.vy += ny * inward;
  }
}
