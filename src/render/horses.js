// Procedural pixel art for horses: seen from the side, facing right (the
// renderer flips it), three frames (standing, and two gallop strides), the
// coat and mane of the breed, and a saddle once someone rides it. Anchored
// at the hooves' middle; cached per breed, frame and saddle.

import { createCanvas, ctx2d } from './canvas.js';
import { BREED_BY_ID, BREEDS } from '../game/horses.js';

export const HORSE_W = 30;
export const HORSE_H = 24;
const OUT = '#161622';

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => c(v).toString(16).padStart(2, '0')).join('')}`;
}

function paint(breed, frame, saddle) {
  const W = HORSE_W;
  const H = HORSE_H;
  const px = Array.from({ length: H }, () => new Array(W).fill(null));
  const set = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < W && y < H) px[y][x] = c;
  };
  const rect = (x, y, w, h, c) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c);
  };
  const coat = breed.coat;
  const dark = shade(coat, 0.7);
  const light = shade(coat, 1.18);
  const mane = breed.mane;
  const hoof = '#2a2230';
  // Legs (behind the body): two strides when galloping.
  const legs = frame === 0
    ? [[8, 0], [11, 0], [19, 0], [22, 0]]
    : frame === 1
      ? [[7, -1], [11, 1], [18, 1], [23, -1]]
      : [[9, 1], [10, -1], [20, -1], [21, 1]];
  for (const [x, lean] of legs) {
    rect(x, 15, 2, 6, dark);
    set(x + lean, 21, dark);
    set(x + lean + 1, 21, dark);
    set(x + lean, 22, hoof);
    set(x + lean + 1, 22, hoof);
  }
  // Body.
  rect(7, 9, 17, 7, coat);
  rect(8, 8, 15, 1, coat);
  rect(8, 9, 14, 1, light);
  rect(8, 15, 15, 1, dark);
  // Neck and head.
  rect(21, 5, 4, 5, coat);
  rect(22, 3, 4, 3, coat);
  rect(24, 2, 4, 4, coat);
  rect(27, 4, 2, 2, dark); // muzzle
  set(25, 3, OUT); // eye
  set(23, 1, coat); // ear
  set(24, 1, dark);
  // Mane along the neck, tail behind.
  rect(20, 2, 2, 7, mane);
  rect(22, 2, 2, 1, mane);
  const tailSwing = frame === 2 ? 1 : 0;
  rect(4, 9, 3, 2, mane);
  rect(3 - tailSwing, 11, 3, 5, mane);
  // A saddle and a blanket once it is someone's horse.
  if (saddle) {
    rect(12, 8, 6, 2, '#6b3a1e');
    rect(12, 10, 6, 3, '#a8323a');
    rect(12, 12, 6, 1, '#e0b040');
    set(15, 7, '#6b3a1e');
  }
  // Outline.
  const marks = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (px[y][x]) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const v = px[y + dy]?.[x + dx];
        return v && v !== OUT;
      })) marks.push([x, y]);
    }
  }
  for (const [x, y] of marks) px[y][x] = OUT;
  const canvas = createCanvas(W, H);
  const g = ctx2d(canvas);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!px[y][x]) continue;
      g.fillStyle = px[y][x];
      g.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

const cache = new Map();

/** The sprite of a horse: `frame` 0 standing, 1–2 galloping. */
export function horseSprite(breedId, frame = 0, saddle = false) {
  const key = `${breedId}:${frame}:${saddle ? 1 : 0}`;
  let c = cache.get(key);
  if (!c) {
    c = paint(BREED_BY_ID.get(breedId) ?? BREEDS[0], frame, saddle);
    cache.set(key, c);
  }
  return c;
}
