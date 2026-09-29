// Deterministic random number utilities.
//
// Everything in here uses only integer operations (Math.imul, bit ops) and
// basic IEEE-754 arithmetic (+ - * / floor round sqrt), which are specified
// exactly by ECMAScript. Transcendental functions (sin, pow, exp, log, ...)
// are implementation-defined and are therefore never used by code that must
// produce identical results on every device (weapon DNA, world layout).

/** Final avalanche step of MurmurHash3. Returns an unsigned 32-bit int. */
export function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over UTF-16 code units, finished with fmix32. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** Combines any number of 32-bit integers into one well-mixed hash. */
export function hashInts(...values) {
  let h = 0x9e3779b9;
  for (const v of values) {
    h = fmix32((h ^ (v | 0)) + 0x7f4a7c15);
  }
  return h >>> 0;
}

/** Derives an independent seed for a named sub-stream. */
export function deriveSeed(seed, label) {
  return fmix32((seed >>> 0) ^ hashString(String(label)) ^ 0x5bd1e995);
}

/** Rounds to a fixed number of decimals using only exact operations. */
export function roundTo(value, decimals = 0) {
  const f = decimals === 0 ? 1 : decimals === 1 ? 10 : decimals === 2 ? 100 : 1000;
  const r = Math.round(value * f) / f;
  return r === 0 ? 0 : r; // never -0: it would not survive a JSON round trip
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Mulberry32 PRNG wrapped in a small helper API.
 * @param {number} seed unsigned 32-bit seed
 */
export function createRng(seed) {
  const origin = seed >>> 0;
  let a = origin;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    seed: origin,
    next,
    /** Float in [min, max). */
    float(min, max) {
      return min + (max - min) * next();
    },
    /** Integer in [min, max] (inclusive). */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
    /** Picks an item with probability proportional to weightFn(item). */
    weighted(list, weightFn = (x) => x.weight ?? 1) {
      let total = 0;
      for (const item of list) total += Math.max(0, weightFn(item));
      if (total <= 0) return list.length ? list[Math.floor(next() * list.length)] : undefined;
      let r = next() * total;
      for (const item of list) {
        const w = Math.max(0, weightFn(item));
        if (r < w) return item;
        r -= w;
      }
      return list[list.length - 1];
    },
    shuffle(list) {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    /** Independent child stream; does not advance this stream. */
    fork(label) {
      return createRng(deriveSeed(origin, label));
    },
  };
  return rng;
}

/** Non-deterministic 32-bit seed for things like a new world. */
export function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (Math.random() * 4294967296) >>> 0;
}

/** Formats a seed the way the UI shows it, e.g. "83920174". */
export function formatSeed(seed) {
  return String(seed >>> 0).padStart(8, '0');
}
