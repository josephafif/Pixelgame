// Pixel art for hired workers: the same little figure as you and the market
// people, in the worker's own colours, with a cap; plus the woodcutter's
// axe and a bundle of logs or stones on the back.

import { createCanvas, ctx2d, flipped, silhouette } from './canvas.js';
import { playerSprites } from './sprites.js';

const O = '#161622';
const cache = new Map();

function withCap(frame, hat) {
  const c = createCanvas(frame.width, frame.height);
  const g = ctx2d(c);
  g.drawImage(frame, 0, 0);
  g.fillStyle = O;
  g.fillRect(2, 0, 6, 1);
  g.fillRect(0, 1, 10, 2);
  g.fillStyle = hat;
  g.fillRect(3, 0, 4, 1);
  g.fillRect(1, 1, 8, 1);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(1, 1, 8, 1);
  g.fillStyle = hat;
  g.fillRect(3, 1, 4, 1);
  return c;
}

/** Walk frames { right: [3], left: [3], flash } for a worker's look ({ cloak, hat }). */
export function workerSprites(look) {
  const key = `w:${look.cloak}:${look.hat}`;
  let s = cache.get(key);
  if (!s) {
    const base = playerSprites(look.cloak);
    const right = base.right.map((f) => withCap(f, look.hat));
    s = { right, left: right.map(flipped), flash: silhouette(right[0]) };
    cache.set(key, s);
  }
  return s;
}

/** A standing worker, for panels. */
export function workerPortrait(look) {
  return workerSprites(look).right[0];
}

/** Small woodcutter's axe (head at the top, handle pointing down), 12×14. */
export function axeSprite() {
  let c = cache.get('axe');
  if (c) return c;
  c = createCanvas(12, 14);
  const g = ctx2d(c);
  g.fillStyle = O;
  g.fillRect(5, 1, 2, 13);
  g.fillStyle = '#b07a48';
  g.fillRect(6, 2, 1, 11);
  g.fillStyle = O;
  g.fillRect(6, 0, 6, 6);
  g.fillStyle = '#c8ccd8';
  g.fillRect(7, 1, 4, 4);
  g.fillStyle = '#ffffff';
  g.fillRect(10, 1, 1, 4);
  cache.set('axe', c);
  return c;
}

/** What a worker carries home: a bundle of logs, or a sack of stones. */
export function carrySprite(kind) {
  const key = `carry:${kind}`;
  let c = cache.get(key);
  if (c) return c;
  c = createCanvas(8, 7);
  const g = ctx2d(c);
  g.fillStyle = O;
  if (kind === 'wood') {
    g.fillRect(0, 0, 8, 7);
    for (const y of [1, 3, 5]) {
      g.fillStyle = '#9a6a3c';
      g.fillRect(1, y, 6, 1);
      g.fillStyle = '#d8b07a';
      g.fillRect(6, y, 1, 1);
    }
  } else {
    g.fillRect(1, 0, 6, 7);
    g.fillRect(0, 2, 8, 4);
    g.fillStyle = '#c8a878';
    g.fillRect(1, 2, 6, 4);
    g.fillRect(2, 1, 4, 5);
    g.fillStyle = '#8d8a9e';
    g.fillRect(3, 2, 2, 1);
  }
  cache.set(key, c);
  return c;
}

// --- Soldiers (army.js): a helmet with a plume in the role's colour, and their weapon --------------------

const PLUME = { guard: '#3f6fd8', infantry: '#c8364a', archer: '#4fb04f', rider: '#e0a030', engineer: '#9a6a3c' };

function withHelmet(frame, role) {
  const c = createCanvas(frame.width, frame.height);
  const g = ctx2d(c);
  g.drawImage(frame, 0, 0);
  g.fillStyle = O;
  g.fillRect(1, 0, 8, 3);
  g.fillRect(0, 2, 10, 1);
  g.fillStyle = '#a4abb6';
  g.fillRect(2, 1, 6, 1);
  g.fillRect(1, 2, 8, 1);
  g.fillStyle = '#d0d4e0';
  g.fillRect(2, 1, 2, 1);
  // The plume.
  g.fillStyle = PLUME[role] ?? '#c8364a';
  g.fillRect(4, 0, 3, 1);
  return c;
}

/** Walk frames for a soldier: the worker's colours under a helmet. */
export function soldierSprites(look, role) {
  const key = `s:${look.cloak}:${role}`;
  let s = cache.get(key);
  if (!s) {
    const base = playerSprites(look.cloak);
    const right = base.right.map((f) => withHelmet(f, role));
    s = { right, left: right.map(flipped), flash: silhouette(right[0]) };
    cache.set(key, s);
  }
  return s;
}

export function soldierPlume(role) {
  return PLUME[role] ?? '#c8364a';
}

/** A soldier's weapon (blade or head at the top, handle pointing down), 12×14. */
export function soldierWeapon(role) {
  const key = `weapon:${role}`;
  let c = cache.get(key);
  if (c) return c;
  c = createCanvas(12, 14);
  const g = ctx2d(c);
  const px = (x, y, w, h, col) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  if (role === 'archer') {
    // A bow: the curve and its string.
    px(4, 0, 3, 14, O);
    px(5, 1, 1, 12, '#b07a48');
    px(6, 0, 2, 2, O);
    px(6, 12, 2, 2, O);
    px(8, 1, 1, 12, '#e8e0c8');
  } else if (role === 'rider') {
    // A spear.
    px(5, 3, 2, 11, O);
    px(6, 4, 1, 10, '#b07a48');
    px(4, 0, 4, 4, O);
    px(5, 0, 2, 3, '#e8ecf4');
  } else if (role === 'engineer') {
    // A mallet.
    px(5, 4, 2, 10, O);
    px(6, 5, 1, 9, '#b07a48');
    px(2, 0, 8, 5, O);
    px(3, 1, 6, 3, '#8a8a96');
    px(3, 1, 6, 1, '#b0b0bc');
  } else {
    // A sword.
    px(5, 0, 2, 10, O);
    px(6, 0, 1, 9, '#e8ecf4');
    px(3, 9, 6, 2, O);
    px(4, 9, 4, 1, '#ffd24a');
    px(5, 11, 2, 3, O);
    px(6, 11, 1, 2, '#6b4a2a');
  }
  cache.set(key, c);
  return c;
}

/** A guard's round shield (on its arm), 7×8. */
export function shieldSprite() {
  let c = cache.get('shield');
  if (c) return c;
  c = createCanvas(7, 8);
  const g = ctx2d(c);
  g.fillStyle = O;
  g.fillRect(0, 1, 7, 6);
  g.fillRect(1, 0, 5, 8);
  g.fillStyle = '#3f6fd8';
  g.fillRect(1, 1, 5, 6);
  g.fillStyle = '#ffd24a';
  g.fillRect(3, 2, 1, 4);
  g.fillRect(2, 3, 3, 1);
  cache.set('shield', c);
  return c;
}
