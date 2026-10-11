// Light and dark over the world. By day only a soft warm glow around fires,
// lava and glowing stones; at dusk and dawn a red warmth; at night a soft
// moonlit blue with pools of light around torches, camp fires, lava, lumen
// caps and crystals (fading gently into the dark, no hard edges), and a
// little light around you. Drawn once a frame over the
// world (under the HUD): the dark is a layer with holes cut where the
// lights are, then each light adds its colour on top.

import { createCanvas, ctx2d } from './canvas.js';

const COLORS = {
  warm: [255, 168, 78], gold: [255, 212, 110], lava: [255, 104, 40], lumen: [110, 255, 200],
  violet: [178, 118, 255], cyan: [120, 228, 255], pale: [214, 236, 255], you: [255, 236, 200],
};

let hole = null;
const glows = new Map();

const SIZE = 128;

/**
 * A soft disc that fades smoothly from the middle to nothing at the rim (no
 * edge you can see): `inner` is its strength in the middle.
 */
function softDisc(r, g, b, inner) {
  const c = createCanvas(SIZE, SIZE);
  const x = ctx2d(c);
  const h = SIZE / 2;
  const grad = x.createRadialGradient(h, h, 0, h, h, h);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const k = (1 - t * t) ** 2; // flat in the middle, a long gentle tail
    grad.addColorStop(t, `rgba(${r},${g},${b},${(inner * k).toFixed(3)})`);
  }
  x.fillStyle = grad;
  x.fillRect(0, 0, SIZE, SIZE);
  return c;
}

/** What each light cuts out of the dark. */
function holeSprite() {
  hole ??= softDisc(255, 255, 255, 1);
  return hole;
}

/** A soft disc of a light's colour (added on top). */
function glowSprite(name) {
  let c = glows.get(name);
  if (c) return c;
  const [r, g, b] = COLORS[name] ?? COLORS.warm;
  c = softDisc(r, g, b, 0.75);
  glows.set(name, c);
  return c;
}

/** How a light breathes: fires flicker softly, stones pulse slowly. */
function flicker(L, t) {
  const s = L.seed ?? 0;
  if (L.color === 'warm' || L.color === 'lava' || L.color === 'gold') return 1 + 0.028 * Math.sin(t * 5.2 + s) + 0.014 * Math.sin(t * 11.3 + s * 1.7);
  return 1 + 0.02 * Math.sin(t * 1.6 + s);
}

/** How far the dark reaches past a light's radius: the light fades out over this much more. */
const REACH = 1.45;

export class Lighting {
  constructor() {
    this.canvas = null;
  }

  /**
   * Draws the light over the view `v` (W × H game pixels, at R buffer pixels
   * each). `lights`: [{ sx, sy (screen pixels), r (tiles), color, seed, k }].
   */
  draw(v, { W, H, R, T, lights, darkness, glow, time }) {
    // Dusk and dawn: a warm red over everything.
    if (glow > 0.01) {
      v.globalCompositeOperation = 'source-over';
      v.fillStyle = `rgba(255, 112, 56, ${(0.15 * glow).toFixed(3)})`;
      v.fillRect(0, 0, W, H);
    }
    if (darkness > 0.01) {
      const cw = Math.ceil(W * R);
      const ch = Math.ceil(H * R);
      if (!this.canvas || this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas = createCanvas(cw, ch);
      }
      const g = ctx2d(this.canvas);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.clearRect(0, 0, cw, ch);
      // A soft moonlit blue: dark enough for the lights to matter, never pitch black.
      g.fillStyle = `rgba(16, 22, 54, ${(0.6 * darkness).toFixed(3)})`;
      g.fillRect(0, 0, cw, ch);
      g.setTransform(R, 0, 0, R, 0, 0);
      g.globalCompositeOperation = 'destination-out';
      const hs = holeSprite();
      for (const L of lights) {
        const rad = L.r * T * REACH * (1 + (flicker(L, time) - 1) * 0.5);
        g.globalAlpha = Math.min(1, L.k ?? 1);
        g.drawImage(hs, L.sx - rad, L.sy - rad, rad * 2, rad * 2);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      v.drawImage(this.canvas, 0, 0, W, H);
    }
    // Every light adds its colour: faint by day, warm and strong at night.
    v.globalCompositeOperation = 'lighter';
    const base = 0.08 + 0.22 * darkness;
    for (const L of lights) {
      if (L.color === 'you') continue;
      const f = flicker(L, time);
      const rad = L.r * T * 1.05 * (1 + (f - 1) * 0.5);
      v.globalAlpha = Math.min(1, base * (L.k ?? 1) * f);
      v.drawImage(glowSprite(L.color), L.sx - rad, L.sy - rad, rad * 2, rad * 2);
    }
    v.globalAlpha = 1;
    v.globalCompositeOperation = 'source-over';
  }
}
