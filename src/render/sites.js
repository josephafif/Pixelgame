// Procedural pixel art for the bigger sites to explore: a watchtower, old
// ruins, an abandoned mine and a runestone. They are landmarks, so they are
// drawn larger than the small finds (bones, signposts …), with the same
// automatic dark outline as the camp's buildings. Anchored bottom-centre,
// cached per kind and state (used ones lose their glow).

import { createCanvas, ctx2d } from './canvas.js';

const C = {
  outline: '#161622',
  stone: '#8d8a9e', stoneDark: '#5d5a6e', stoneLight: '#b8b6c8', stoneDeep: '#46435a',
  wood: '#9a6a3d', woodDark: '#5b3a21', woodLight: '#c08850',
  roof: '#a8323a', roofDark: '#6e1f28',
  moss: '#5fa84a', mossDark: '#3a6a2e',
  dark: '#15121f', ore: '#7ae0ff', oreDark: '#3a8ab0', gold: '#e8b84a', iron: '#4a4a5a',
  rune: '#7ae0ff', runeDim: '#5d5a6e', lamp: '#ffd060',
};

class Painter {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Array.from({ length: h }, () => new Array(w).fill(null));
  }
  set(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y][x] = c;
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** Stone blocks: a running bond of bricks with light tops. */
  bricks(x, y, w, h) {
    this.rect(x, y, w, h, C.stone);
    for (let j = 0; j < h; j++) {
      const row = Math.floor(j / 3);
      if (j % 3 === 2) this.rect(x, y + j, w, 1, C.stoneDark);
      else if (j % 3 === 0) this.rect(x, y + j, w, 1, C.stoneLight);
      for (let i = (row % 2) * 3; i < w; i += 6) if (j % 3 !== 2) this.set(x + i, y + j, C.stoneDark);
    }
    this.rect(x + w - 1, y, 1, h, C.stoneDark);
  }
  disc(cx, cy, r, c) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) this.set(cx + x, cy + y, c);
  }
  roof(x0, x1, y, h, c, dark) {
    for (let j = 0; j < h; j++) {
      const inset = Math.round(((x1 - x0) / 2) * (j / h));
      this.rect(x0 + inset, y - j, x1 - x0 - inset * 2 + 1, 1, j % 3 === 0 ? dark : c);
    }
  }
  outline() {
    const marks = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.px[y][x]) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const v = this.px[y + dy]?.[x + dx];
          return v && v !== C.outline;
        })) marks.push([x, y]);
      }
    }
    for (const [x, y] of marks) this.px[y][x] = C.outline;
  }
  toCanvas() {
    const canvas = createCanvas(this.w, this.h);
    const ctx = ctx2d(canvas);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = this.px[y][x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    return canvas;
  }
}

function tower() {
  const p = new Painter(28, 50);
  // Base and shaft.
  p.bricks(5, 40, 18, 9);
  p.bricks(7, 16, 14, 25);
  // Platform with battlements.
  p.rect(4, 13, 20, 3, C.stoneDark);
  p.rect(4, 12, 20, 1, C.stoneLight);
  for (let x = 4; x < 24; x += 4) p.rect(x, 9, 2, 3, C.stone);
  // A little wooden roof on posts.
  p.rect(7, 4, 1, 8, C.woodDark);
  p.rect(20, 4, 1, 8, C.woodDark);
  p.roof(4, 23, 6, 7, C.roof, C.roofDark);
  // Windows and the door.
  p.rect(13, 21, 2, 4, C.dark);
  p.rect(13, 30, 2, 4, C.dark);
  p.rect(11, 42, 6, 7, C.woodDark);
  p.rect(12, 43, 4, 6, C.wood);
  p.rect(13, 43, 1, 6, C.woodDark);
  p.set(15, 46, C.gold);
  // A banner on the side.
  p.rect(21, 18, 1, 9, C.woodDark);
  p.rect(22, 18, 3, 5, C.roof);
  p.set(24, 23, C.roof);
  p.outline();
  return p.toCanvas();
}

function ruins(found) {
  const p = new Painter(46, 30);
  const moss = found ? C.mossDark : C.moss;
  // Cracked floor.
  p.rect(1, 24, 44, 5, C.stoneDark);
  for (let x = 1; x < 45; x += 5) p.rect(x, 24, 4, 1, C.stone);
  // Left column (whole), with a capital.
  p.bricks(4, 6, 6, 18);
  p.rect(3, 4, 8, 2, C.stoneLight);
  p.rect(3, 6, 8, 1, C.stoneDark);
  p.rect(4, 4, 3, 1, moss);
  // Arch stub leaning from it.
  p.rect(10, 6, 5, 3, C.stone);
  p.rect(10, 8, 4, 1, C.stoneDark);
  // Middle column, broken off.
  p.bricks(19, 13, 6, 11);
  p.set(19, 12, C.stone);
  p.set(20, 11, C.stone);
  p.set(22, 12, C.stone);
  p.set(24, 12, C.stone);
  p.rect(19, 13, 3, 1, moss);
  // Right column, taller and cracked.
  p.bricks(35, 9, 6, 15);
  p.rect(34, 8, 8, 1, C.stoneLight);
  p.rect(37, 12, 1, 6, C.stoneDeep);
  p.rect(38, 17, 1, 3, C.stoneDeep);
  p.rect(39, 8, 3, 1, moss);
  // A fallen drum and rubble.
  p.rect(25, 20, 9, 4, C.stone);
  p.rect(25, 20, 9, 1, C.stoneLight);
  p.rect(33, 20, 1, 4, C.stoneDark);
  p.disc(14, 22, 2, C.stone);
  p.disc(30, 25, 1, C.stoneLight);
  p.disc(43, 22, 1, C.stone);
  p.set(26, 19, moss);
  p.set(27, 19, moss);
  // A glint of something left behind.
  if (!found) {
    p.rect(14, 18, 3, 2, C.gold);
    p.set(15, 17, '#fff0a0');
  }
  p.outline();
  return p.toCanvas();
}

function mine(found) {
  const p = new Painter(38, 30);
  // The hill.
  p.disc(19, 18, 13, C.stoneDark);
  p.disc(10, 22, 8, C.stone);
  p.disc(28, 21, 9, C.stone);
  p.disc(19, 14, 9, C.stone);
  p.rect(0, 24, 38, 5, C.stoneDark);
  for (const [x, y] of [[6, 18], [30, 15], [24, 9], [12, 12], [33, 22]]) p.set(x, y, C.stoneLight);
  // The opening with its timber frame.
  p.rect(13, 13, 12, 14, C.dark);
  p.rect(12, 12, 14, 2, C.wood);
  p.rect(12, 12, 14, 1, C.woodLight);
  p.rect(12, 14, 2, 13, C.wood);
  p.rect(24, 14, 2, 13, C.wood);
  p.rect(13, 14, 1, 13, C.woodDark);
  p.rect(25, 14, 1, 13, C.woodDark);
  // Rails coming out.
  p.rect(14, 26, 1, 3, C.iron);
  p.rect(23, 26, 1, 3, C.iron);
  for (let y = 26; y < 29; y += 2) p.rect(14, y, 10, 1, C.woodDark);
  // A lantern and an ore cart.
  p.set(11, 15, C.woodDark);
  p.rect(10, 16, 2, 2, found ? C.stoneDark : C.lamp);
  p.rect(27, 21, 8, 4, C.iron);
  p.rect(27, 21, 8, 1, '#7a7a8e');
  p.disc(28, 26, 1, C.dark);
  p.disc(34, 26, 1, C.dark);
  if (!found) {
    p.rect(28, 19, 2, 2, C.ore);
    p.rect(31, 19, 2, 2, C.oreDark);
    p.set(33, 20, C.ore);
  }
  p.outline();
  return p.toCanvas();
}

function runestone(found) {
  const p = new Painter(18, 28);
  const rune = found ? C.runeDim : C.rune;
  // The slab with a rounded top.
  p.rect(4, 4, 10, 20, C.stone);
  p.rect(5, 3, 8, 1, C.stone);
  p.rect(6, 2, 6, 1, C.stone);
  p.rect(4, 4, 1, 20, C.stoneLight);
  p.rect(13, 4, 1, 20, C.stoneDark);
  p.rect(5, 3, 2, 1, C.stoneLight);
  // Runes.
  const glyphs = [
    [7, 6], [8, 7], [9, 6], [10, 7],
    [7, 10], [7, 11], [8, 12], [9, 11], [10, 10], [10, 11],
    [8, 15], [9, 15], [8, 16], [10, 17], [7, 17],
    [7, 20], [8, 19], [9, 20], [10, 19],
  ];
  for (const [x, y] of glyphs) p.set(x, y, rune);
  // Base stones.
  p.rect(1, 23, 16, 4, C.stoneDark);
  p.rect(1, 23, 16, 1, C.stone);
  p.disc(2, 25, 1, C.stone);
  p.disc(15, 25, 1, C.stone);
  p.set(5, 22, C.moss);
  p.set(12, 22, C.moss);
  p.outline();
  return p.toCanvas();
}

const cache = new Map();

/** Sprite for a site (`found`: you have used it, so it has lost its glow). */
export function siteSprite(kind, found = false) {
  const key = `${kind}:${found ? 1 : 0}`;
  let c = cache.get(key);
  if (!c) {
    c = { tower, ruins, mine, runestone }[kind]?.(found) ?? null;
    cache.set(key, c);
  }
  return c;
}

export const SITE_TYPES = ['tower', 'ruins', 'mine', 'runestone'];
