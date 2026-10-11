// Light and dark over the world. By day only a soft warm glow around fires,
// lava and glowing stones; at dusk and dawn a red warmth; at night a deep
// blue dark with pools of light around torches, camp fires, lava, lumen caps
// and crystals, and a little light around you. Drawn once a frame over the
// world (under the HUD): the dark is a layer with holes cut where the
// lights are, then each light adds its colour on top.

import { createCanvas, ctx2d } from './canvas.js';

const COLORS = {
  warm: [255, 168, 78], gold: [255, 212, 110], lava: [255, 104, 40], lumen: [110, 255, 200],
  violet: [178, 118, 255], cyan: [120, 228, 255], pale: [214, 236, 255], you: [255, 236, 200],
};

let hole = null;
const glows = new Map();

/** A soft white disc (alpha 1 in the middle, 0 at the rim): what each light cuts out of the dark. */
function holeSprite() {
  if (hole) return hole;
  hole = createCanvas(64, 64);
  const g = ctx2d(hole);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return hole;
}

/** A soft disc of a light's colour (added on top). */
function glowSprite(name) {
  let c = glows.get(name);
  if (c) return c;
  const [r, gg, b] = COLORS[name] ?? COLORS.warm;
  c = createCanvas(64, 64);
  const g = ctx2d(c);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${r},${gg},${b},0.9)`);
  grad.addColorStop(0.35, `rgba(${r},${gg},${b},0.42)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glows.set(name, c);
  return c;
}

/** How a light breathes: fires flicker, stones pulse slowly. */
function flicker(L, t) {
  const s = L.seed ?? 0;
  if (L.color === 'warm' || L.color === 'lava' || L.color === 'gold') return 1 + 0.07 * Math.sin(t * 9 + s) + 0.04 * Math.sin(t * 23 + s * 1.7);
  return 1 + 0.05 * Math.sin(t * 2 + s);
}

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
      g.fillStyle = `rgba(10, 14, 38, ${(0.8 * darkness).toFixed(3)})`;
      g.fillRect(0, 0, cw, ch);
      g.setTransform(R, 0, 0, R, 0, 0);
      g.globalCompositeOperation = 'destination-out';
      const hs = holeSprite();
      for (const L of lights) {
        const rad = L.r * T * flicker(L, time);
        g.globalAlpha = Math.min(1, L.k ?? 1);
        g.drawImage(hs, L.sx - rad, L.sy - rad, rad * 2, rad * 2);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      v.drawImage(this.canvas, 0, 0, W, H);
    }
    // Every light adds its colour: faint by day, warm and strong at night.
    v.globalCompositeOperation = 'lighter';
    const base = 0.1 + 0.34 * darkness;
    for (const L of lights) {
      if (L.color === 'you') continue;
      const f = flicker(L, time);
      const rad = L.r * T * 0.85 * f;
      v.globalAlpha = Math.min(1, base * (L.k ?? 1) * f);
      v.drawImage(glowSprite(L.color), L.sx - rad, L.sy - rad, rad * 2, rad * 2);
    }
    v.globalAlpha = 1;
    v.globalCompositeOperation = 'source-over';
  }
}
