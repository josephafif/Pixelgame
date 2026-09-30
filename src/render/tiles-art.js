// Procedural 16×16 tile textures and chunk pre-rendering. A chunk is drawn
// once into a 256×256 canvas and then blitted each frame, which keeps the
// per-frame cost tiny on phones.

import { createRng } from '../core/rng.js';
import { createCanvas, ctx2d } from './canvas.js';
import { T, CHUNK } from '../game/world.js';

export const TILE_PX = 16;
const VARIANTS = 4;

const GROUND_STYLE = {
  [T.GRASS]: { base: '#4f9a44', dots: ['#5fb050', '#3f7f38'], blades: '#6cc15c' },
  [T.FLOWERS]: { base: '#4f9a44', dots: ['#5fb050', '#3f7f38'], flowers: ['#ffd84a', '#ff7ab0', '#ffffff', '#8ab8ff'] },
  [T.MOSS]: { base: '#3c7437', dots: ['#58944a', '#2f5e2c'], blades: '#4f8a44' },
  [T.SAND]: { base: '#e3c886', dots: ['#d4b56e', '#f0d9a0'] },
  [T.SAND2]: { base: '#dcbf7a', dots: ['#cfb070', '#ead29a'], ripples: '#c9a862' },
  [T.SNOW]: { base: '#eef4fa', dots: ['#d6e2ee', '#ffffff'] },
  [T.ICE]: { base: '#b8e0f4', dots: ['#a4d4ee', '#e8f8ff'], cracks: '#86bcde' },
  [T.ASH]: { base: '#4a4450', dots: ['#5c5562', '#3a3540'], embers: '#ff7a3a' },
  [T.BASALT]: { base: '#3a3640', dots: ['#46414e', '#2e2a34'], cracks: '#26222c' },
  [T.ROCKGRASS]: { base: '#6e8f5a', dots: ['#7fa06a', '#8a8a90'], blades: '#86ac6c' },
  [T.VOIDSTONE]: { base: '#2e2440', dots: ['#3a2e52', '#241c34'], cracks: '#6b3fc6' },
  [T.VOIDMOSS]: { base: '#3a2a52', dots: ['#4a3868', '#2e2044'], blades: '#5a3f7a' },
  [T.CAMP]: { base: '#8a7f70', bricks: '#6e6458', dots: ['#958a7a', '#7a7064'] },
  [T.PATH]: { base: '#b89a6a', dots: ['#a88a5a', '#c8aa7a'] },
};

function drawGround(ctx, style, rng) {
  ctx.fillStyle = style.base;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = rng.pick(style.dots);
    ctx.fillRect(rng.int(0, 15), rng.int(0, 15), 1, 1);
  }
  if (style.blades) {
    ctx.fillStyle = style.blades;
    for (let i = 0; i < 4; i++) {
      const x = rng.int(0, 14);
      const y = rng.int(1, 14);
      ctx.fillRect(x, y, 1, 2);
      ctx.fillRect(x + 1, y - 1, 1, 2);
    }
  }
  if (style.flowers) {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = rng.pick(style.flowers);
      const x = rng.int(1, 14);
      const y = rng.int(1, 14);
      ctx.fillRect(x, y, 1, 1);
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x, y + 1, 1, 1);
      ctx.fillStyle = '#ffe890';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  if (style.ripples) {
    ctx.fillStyle = style.ripples;
    for (let i = 0; i < 3; i++) ctx.fillRect(rng.int(0, 8), rng.int(2, 14), rng.int(4, 8), 1);
  }
  if (style.cracks) {
    ctx.fillStyle = style.cracks;
    let x = rng.int(2, 13);
    let y = 0;
    while (y < 16) {
      ctx.fillRect(x, y, 1, 1);
      y += 1;
      x += rng.int(-1, 1);
    }
  }
  if (style.embers && rng.chance(0.5)) {
    ctx.fillStyle = style.embers;
    ctx.fillRect(rng.int(1, 14), rng.int(1, 14), 1, 1);
  }
  if (style.bricks) {
    ctx.fillStyle = style.bricks;
    for (let y = 0; y < 16; y += 4) {
      ctx.fillRect(0, y, 16, 1);
      const off = (y / 4) % 2 ? 4 : 0;
      for (let x = off; x < 16; x += 8) ctx.fillRect(x, y, 1, 4);
    }
  }
}

function circle(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r + r * 0.8) ctx.fillRect(cx + x, cy + y, 1, 1);
    }
  }
}

function drawBlocker(ctx, id, rng) {
  switch (id) {
    case T.WATER: {
      ctx.fillStyle = '#3a78c8';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#4a8ad8';
      for (let i = 0; i < 6; i++) ctx.fillRect(rng.int(0, 12), rng.int(0, 15), rng.int(2, 4), 1);
      ctx.fillStyle = '#8ac0f0';
      for (let i = 0; i < 2; i++) ctx.fillRect(rng.int(0, 12), rng.int(0, 15), 3, 1);
      break;
    }
    case T.SEA: {
      // Shallow coastal sea: bright turquoise with glints.
      ctx.fillStyle = '#2f8fc4';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#3aa2d4';
      for (let i = 0; i < 5; i++) ctx.fillRect(rng.int(0, 12), rng.int(0, 15), rng.int(2, 5), 1);
      ctx.fillStyle = '#9ad8f4';
      for (let i = 0; i < 2; i++) ctx.fillRect(rng.int(0, 13), rng.int(0, 15), 2, 1);
      break;
    }
    case T.DEEP: {
      // Open sea: dark blue with long, slow swells.
      ctx.fillStyle = '#1d4e8c';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#255da0';
      for (let i = 0; i < 3; i++) ctx.fillRect(rng.int(0, 10), rng.int(0, 15), rng.int(4, 7), 1);
      if (rng.next() < 0.5) {
        ctx.fillStyle = '#5a8ed0';
        ctx.fillRect(rng.int(1, 12), rng.int(1, 14), 3, 1);
      }
      break;
    }
    case T.PALM: {
      // A curved trunk with drooping fronds and coconuts.
      ctx.fillStyle = '#161622';
      ctx.fillRect(6, 6, 4, 10);
      ctx.fillStyle = '#9a6a3a';
      for (let y = 6; y < 16; y++) ctx.fillRect(7 + (y < 10 ? 1 : 0), y, 2, 1);
      ctx.fillStyle = '#7a4e28';
      for (let y = 7; y < 16; y += 2) ctx.fillRect(7 + (y < 10 ? 1 : 0), y, 2, 1);
      const frond = (pts, dark) => {
        for (const [x, y] of pts) {
          ctx.fillStyle = '#161622';
          ctx.fillRect(x - 1, y - 1, 3, 3);
        }
        for (const [x, y] of pts) {
          ctx.fillStyle = dark ? '#2f8a3c' : '#4fb04f';
          ctx.fillRect(x, y, 2, 1);
        }
      };
      frond([[1, 5], [3, 4], [5, 3], [7, 3]], true);
      frond([[14, 5], [12, 4], [10, 3], [8, 3]], true);
      frond([[2, 2], [4, 2], [6, 2], [8, 2]], false);
      frond([[13, 2], [11, 2], [9, 2]], false);
      frond([[3, 7], [5, 5]], false);
      frond([[13, 7], [11, 5]], false);
      ctx.fillStyle = '#5a3a1a';
      ctx.fillRect(7, 5, 1, 1);
      ctx.fillRect(9, 5, 1, 1);
      break;
    }
    case T.LAVA: {
      ctx.fillStyle = '#c8381a';
      ctx.fillRect(0, 0, 16, 16);
      for (let i = 0; i < 4; i++) circle(ctx, rng.int(2, 13), rng.int(2, 13), 1, '#ff8a2a');
      ctx.fillStyle = '#ffd060';
      for (let i = 0; i < 3; i++) ctx.fillRect(rng.int(1, 14), rng.int(1, 14), 1, 1);
      break;
    }
    case T.TREE: {
      ctx.fillStyle = '#161622';
      ctx.fillRect(6, 10, 4, 6);
      ctx.fillStyle = '#6a4424';
      ctx.fillRect(7, 10, 2, 5);
      circle(ctx, 8, 7, 7, '#161622');
      circle(ctx, 8, 7, 6, '#2f7a34');
      circle(ctx, 7, 6, 4, '#3f9a44');
      circle(ctx, 6, 5, 2, '#5cb85a');
      break;
    }
    case T.PINE: {
      ctx.fillStyle = '#5a3a22';
      ctx.fillRect(7, 12, 2, 4);
      for (let row = 0; row < 12; row++) {
        const half = Math.floor(row / 2) + 1;
        ctx.fillStyle = '#161622';
        ctx.fillRect(8 - half - 1, row + 1, half * 2 + 2, 1);
        ctx.fillStyle = row % 4 < 2 ? '#2a5a3a' : '#3a7a4a';
        ctx.fillRect(8 - half, row + 1, half * 2, 1);
      }
      ctx.fillStyle = '#eef4fa';
      ctx.fillRect(7, 1, 2, 1);
      ctx.fillRect(5, 5, 2, 1);
      ctx.fillRect(10, 8, 2, 1);
      break;
    }
    case T.ROCK: {
      circle(ctx, 8, 9, 6, '#161622');
      circle(ctx, 8, 9, 5, '#6a6a76');
      circle(ctx, 7, 8, 4, '#8a8a96');
      circle(ctx, 6, 7, 1, '#b0b0bc');
      break;
    }
    case T.CACTUS: {
      ctx.fillStyle = '#161622';
      ctx.fillRect(6, 2, 4, 14);
      ctx.fillRect(2, 6, 4, 6);
      ctx.fillRect(10, 4, 4, 6);
      ctx.fillStyle = '#4a9a4a';
      ctx.fillRect(7, 3, 2, 12);
      ctx.fillRect(3, 7, 2, 4);
      ctx.fillRect(11, 5, 2, 4);
      ctx.fillRect(5, 10, 2, 1);
      ctx.fillRect(9, 8, 2, 1);
      ctx.fillStyle = '#7ac86a';
      ctx.fillRect(7, 3, 1, 10);
      break;
    }
    case T.CRYSTAL: {
      const shards = [[5, 3, 3, 12], [9, 6, 3, 9], [2, 9, 3, 6]];
      for (const [x, y, w, h] of shards) {
        ctx.fillStyle = '#161622';
        ctx.fillRect(x - 1, y - 1, w + 2, h + 1);
        ctx.fillStyle = '#6b3fc6';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#9a5cff';
        ctx.fillRect(x, y, 1, h);
        ctx.fillStyle = '#cdb2ff';
        ctx.fillRect(x + 1, y, 1, 1);
      }
      break;
    }
    default:
      break;
  }
}

const tileCache = new Map();

export function tileCanvas(id, variant, blocker = false) {
  const key = `${blocker ? 'b' : 'g'}${id}:${variant}`;
  let c = tileCache.get(key);
  if (!c) {
    c = createCanvas(TILE_PX, TILE_PX);
    const ctx = ctx2d(c);
    const rng = createRng(id * 977 + variant * 131 + (blocker ? 7 : 0));
    if (blocker) drawBlocker(ctx, id, rng);
    else drawGround(ctx, GROUND_STYLE[id] ?? GROUND_STYLE[T.GRASS], rng);
    tileCache.set(key, c);
  }
  return c;
}

/** Pre-renders a chunk (ground + blockers) into one canvas. */
export function renderChunk(chunk) {
  const size = CHUNK * TILE_PX;
  const canvas = createCanvas(size, size);
  const ctx = ctx2d(canvas);
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = ly * CHUNK + lx;
      const wx = chunk.cx * CHUNK + lx;
      const wy = chunk.cy * CHUNK + ly;
      const variant = ((wx * 73856093) ^ (wy * 19349663)) & (VARIANTS - 1);
      ctx.drawImage(tileCanvas(chunk.ground[i], variant), lx * TILE_PX, ly * TILE_PX);
      if (chunk.block[i]) ctx.drawImage(tileCanvas(chunk.block[i], variant, true), lx * TILE_PX, ly * TILE_PX);
    }
  }
  return canvas;
}
