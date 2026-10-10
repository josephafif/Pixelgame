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
