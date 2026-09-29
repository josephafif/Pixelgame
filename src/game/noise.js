// Deterministic 2D value noise (integer hashing + polynomial smoothing only,
// so the same world seed builds the same world on every device).

import { fmix32 } from '../core/rng.js';

function lattice(seed, i, j) {
  return fmix32(seed ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1)) / 4294967296;
}

export function valueNoise(seed, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = lattice(seed, xi, yi);
  const b = lattice(seed, xi + 1, yi);
  const c = lattice(seed, xi, yi + 1);
  const d = lattice(seed, xi + 1, yi + 1);
  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/** Two-octave fractal noise in roughly [0, 1]. */
export function fbm(seed, x, y) {
  return valueNoise(seed, x, y) * 0.65 + valueNoise(seed ^ 0x9e3779b9, x * 2.03, y * 2.03) * 0.35;
}

/** Uniform [0, 1) hash for a tile, independent of neighbours. */
export function tileHash(seed, x, y, salt = 0) {
  return lattice(seed ^ Math.imul(salt + 1, 0x85ebca6b), x, y);
}
