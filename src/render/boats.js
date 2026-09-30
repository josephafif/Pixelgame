// Pixel-art boats, drawn facing right: a `back` layer (mast, sails, flag)
// that goes behind the sailor and a `hull` layer in front of their legs.

import { createCanvas, ctx2d } from './canvas.js';
import { shadeHex } from '../weapons/visuals.js';

const OUT = '#161622';
const cache = new Map();

function px(g, x, y, w, h, c) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

/** A hull shape: flat deck line, rounded bow on the right, raked stern. */
function hull(g, w, h, wood, trim, stripe) {
  for (let y = 0; y < h; y++) {
    const inset = Math.floor((y / h) * (y / h) * 4); // narrows towards the keel
    const bow = Math.floor((y / h) * 5); // bow curves back under the waterline
    const x0 = inset;
    const x1 = w - 1 - bow;
    px(g, x0, y, x1 - x0 + 1, 1, OUT);
    if (y > 0 && y < h - 1) px(g, x0 + 1, y, x1 - x0 - 1, 1, y === 1 ? trim : y % 2 ? wood : shadeHex(wood, -0.12));
  }
  if (stripe) px(g, 2, Math.floor(h / 2), w - 8, 1, stripe);
}

function raft(color) {
  const w = 20;
  const back = createCanvas(w, 16);
  const b = ctx2d(back);
  // A little flag pole at the stern.
  px(b, 2, 3, 1, 12, OUT);
  px(b, 3, 4, 4, 3, OUT);
  px(b, 3, 4, 3, 2, '#e8364a');
  const front = createCanvas(w, 7);
  const f = ctx2d(front);
  px(f, 0, 0, w, 7, OUT);
  for (let row = 0; row < 3; row++) {
    const c = row % 2 ? color : shadeHex(color, -0.18);
    px(f, 1, 1 + row * 2, w - 2, 2, c);
    px(f, 1, 1 + row * 2, w - 2, 1, shadeHex(color, 0.15));
  }
  // Rope bindings.
  for (const x of [4, w - 5]) px(f, x, 0, 1, 7, '#e8d8a8');
  return { back, hull: front, w, backH: 16, hullY: 3 };
}

function sloop(color) {
  const w = 24;
  const back = createCanvas(w, 26);
  const b = ctx2d(back);
  // Mast just aft of the sailor, a big triangular sail towards the bow.
  px(b, 7, 2, 2, 24, OUT);
  px(b, 7, 3, 1, 22, '#8a5a33');
  for (let y = 4; y < 22; y++) {
    const len = Math.floor(((y - 4) / 18) * 13) + 1;
    px(b, 9, y, len + 1, 1, OUT);
    px(b, 9, y, len, 1, y % 5 === 0 ? shadeHex(color, -0.12) : color);
  }
  px(b, 6, 0, 4, 3, OUT);
  px(b, 7, 1, 2, 1, '#3f9ad8');
  const front = createCanvas(w, 8);
  hull(ctx2d(front), w, 8, '#8a5a33', '#c89a60', null);
  return { back, hull: front, w, backH: 26, hullY: 3 };
}

function galleon(color) {
  const w = 30;
  const back = createCanvas(w, 30);
  const b = ctx2d(back);
  const sail = (x, y0, width, height) => {
    px(b, x - 1, y0 - 1, width + 2, height + 2, OUT);
    for (let y = 0; y < height; y++) px(b, x, y0 + y, width, 1, y % 4 === 1 ? color : '#efe6cc');
  };
  // Two masts with square sails and a pennant.
  for (const mx of [7, 19]) {
    px(b, mx, 1, 2, 29, OUT);
    px(b, mx, 2, 1, 27, '#6a4424');
  }
  sail(3, 5, 10, 9);
  sail(15, 7, 10, 10);
  px(b, 20, 0, 6, 3, OUT);
  px(b, 21, 1, 4, 1, color);
  const front = createCanvas(w, 10);
  const f = ctx2d(front);
  hull(f, w, 10, '#5a3a22', '#e0b040', color);
  // Gun ports.
  for (const x of [6, 11, 16]) px(f, x, 6, 2, 1, OUT);
  return { back, hull: front, w, backH: 30, hullY: 3 };
}

const BUILDERS = { raft, sloop, galleon };

function flip(canvas) {
  const c = createCanvas(canvas.width, canvas.height);
  const g = ctx2d(c);
  g.translate(canvas.width, 0);
  g.scale(-1, 1);
  g.drawImage(canvas, 0, 0);
  return c;
}

/** { right: {back, hull}, left: {back, hull}, w, backH, hullY } for a boat. */
export function boatSprite(id, color) {
  const key = `${id}:${color}`;
  let s = cache.get(key);
  if (!s) {
    const art = (BUILDERS[id] ?? raft)(color);
    s = {
      right: { back: art.back, hull: art.hull },
      left: { back: flip(art.back), hull: flip(art.hull) },
      w: art.w,
      backH: art.backH,
      hullY: art.hullY,
    };
    cache.set(key, s);
  }
  return s;
}

/** The whole boat in one canvas (for the Forge and HUD). */
export function boatIcon(id, color) {
  const s = boatSprite(id, color);
  // Same stacking as in the world: the hull sits 4 px above the back layer's foot.
  const c = createCanvas(s.w, s.backH - 4 + s.right.hull.height);
  const g = ctx2d(c);
  g.drawImage(s.right.back, 0, 0);
  g.drawImage(s.right.hull, 0, s.backH - 4);
  return c;
}
