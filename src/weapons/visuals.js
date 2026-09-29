// Visual and audio parameters derived from weapon DNA (pipeline step 8).
// Only parameters are produced here; src/render/weapon-sprite.js turns them
// into pixels. Colour maths is integer-only so every device agrees.

import { roundTo } from '../core/rng.js';

export function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Mixes two hex colours; t is in [0, 1]. */
export function mixHex(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex(ca.map((v, i) => Math.round(v + (cb[i] - v) * t)));
}

export function shadeHex(hex, amount) {
  return amount >= 0 ? mixHex(hex, '#ffffff', amount) : mixHex(hex, '#000000', -amount);
}

const PARTICLE_FALLBACK = ['sparkle', 'sparkle', 'sparkle', 'sparkle', 'sparkle'];

/**
 * @param {object} parts { archetype, material, element (def), rarity, rarityIdx, stateTags }
 */
export function generateVisual(data, parts, rng) {
  const { archetype, material, element, rarity, rarityIdx, stateTags } = parts;
  const dims = {};
  for (const [key, [lo, hi]] of Object.entries(archetype.sprite.dims ?? {})) {
    dims[key] = rng.int(lo, hi);
  }
  const choices = {};
  for (const [key, list] of Object.entries(archetype.sprite.choices ?? {})) {
    choices[key] = rng.pick(list);
  }

  const metal = material.palette;
  const tint = element.palette;
  // Elemental weapons get their blade/head pushed towards the element palette;
  // higher rarity = stronger tint so legendaries read clearly at a glance.
  const tintAmount = tint ? 0.45 + 0.08 * rarityIdx : 0;
  const blade = tint ? metal.map((c, i) => mixHex(c, tint[i], tintAmount)) : metal.slice();
  const accent = tint ? tint[1] : rarityIdx >= 2 ? rarity.color : shadeHex(metal[1], -0.2);
  const gem = rarityIdx >= 2 ? (tint ? tint[0] : rarity.color) : null;

  let edge = element.edge ?? 'smooth';
  if (edge === 'smooth' && (stateTags.has('bleed') || material.id === 'fang')) edge = 'serrated';
  if (edge === 'smooth' && material.id === 'crystal') edge = 'crystal';

  const particleKind = element.particles ?? (rarityIdx >= 3 ? PARTICLE_FALLBACK[rarityIdx] : null);
  return {
    template: archetype.sprite.template,
    dims,
    choices,
    palette: {
      blade,
      handle: material.handle.slice(),
      accent,
      gem,
      glow: element.glow ?? (rarityIdx >= 3 ? rarity.color : null),
      outline: shadeHex(blade[2], -0.55),
    },
    edge,
    glow: Boolean(element.glow && rarityIdx >= 1) || rarityIdx >= 3,
    particles: particleKind ? { kind: particleKind, rate: roundTo(0.25 + 0.15 * rarityIdx, 2) } : null,
    distortion: Boolean(element.distortion),
    runes: rarityIdx >= 4,
    trail: element.glow ?? rarity.color,
    variant: rng.int(0, 255),
  };
}

const WAVES = ['square', 'sawtooth', 'triangle'];

export function generateSound(data, parts, rng) {
  const { archetype, element, rarityIdx } = parts;
  const [lo, hi] = archetype.sound.pitch;
  return {
    type: archetype.sound.type,
    wave: rng.pick(WAVES),
    pitch: Math.round((lo + (hi - lo) * rng.next()) * element.soundPitch),
    decay: roundTo(0.07 + 0.1 * rng.next(), 2),
    sweep: roundTo(-0.5 + rng.next(), 2),
    shimmer: rarityIdx >= 3,
  };
}
