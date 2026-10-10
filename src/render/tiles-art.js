// Procedural 16×16 tile textures and chunk pre-rendering. A chunk is drawn
// once into a 256×256 canvas and then blitted each frame, which keeps the
// per-frame cost tiny on phones.

import { createRng } from '../core/rng.js';
import { createCanvas, ctx2d } from './canvas.js';
import { T, CHUNK, WIND } from '../game/world.js';

export const TILE_PX = 16;
const VARIANTS = 4;

export const GROUND_STYLE = {
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
  // Prism Barrens: pale sand full of glints, and glassy flats.
  [T.PRISMSAND]: { base: '#e6dff0', dots: ['#d6cce8', '#f6f2ff'], glints: ['#7ae8ff', '#ff9ad8', '#ffd27a'] },
  [T.PRISMGLASS]: { base: '#c8e2ee', dots: ['#b4d6e6', '#e4f4fa'], cracks: '#9cc8de', glints: ['#ffffff'] },
  // Mireglass Fen: dark teal moss, peat, and bubbling bog.
  [T.FENMOSS]: { base: '#2f5e4e', dots: ['#3a6e5a', '#264e40'], blades: '#4a8a6a' },
  [T.PEAT]: { base: '#4a3e34', dots: ['#5a4a3e', '#3a3028'] },
  [T.BOG]: { base: '#3a4a30', dots: ['#4a5a38', '#2a3a24'], bubbles: '#7a9a5a' },
  // Skyreach: bright island grass and pale stone.
  [T.SKYGRASS]: { base: '#6aa85a', dots: ['#7ab86a', '#5a984c'], blades: '#8ac87a' },
  [T.SKYSTONE]: { base: '#a8acb8', dots: ['#b8bcc8', '#9498a4'], cracks: '#8a8e9a' },
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
  if (style.bubbles) {
    // Bog bubbles: little rings coming up through the mud.
    ctx.fillStyle = style.bubbles;
    for (let i = 0; i < 2; i++) {
      const x = rng.int(2, 12);
      const y = rng.int(2, 12);
      ctx.fillRect(x, y - 1, 2, 1);
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x + 2, y, 1, 1);
      ctx.fillRect(x, y + 1, 2, 1);
    }
  }
  if (style.glints) {
    for (let i = 0; i < 2; i++) {
      if (!rng.chance(0.6)) continue;
      ctx.fillStyle = rng.pick(style.glints);
      ctx.fillRect(rng.int(1, 14), rng.int(1, 14), 1, 1);
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
    case T.OBSIDIAN: {
      // A glassy black boulder with violet facets and a glowing seam.
      circle(ctx, 8, 9, 6, '#161622');
      circle(ctx, 8, 9, 5, '#2a2238');
      ctx.fillStyle = '#4a3a66';
      ctx.fillRect(4, 6, 3, 3);
      ctx.fillRect(9, 9, 3, 2);
      ctx.fillStyle = '#9a7aff';
      ctx.fillRect(5, 6, 1, 1);
      ctx.fillRect(10, 9, 1, 1);
      ctx.fillStyle = '#ff6a2a';
      ctx.fillRect(7, 11, 3, 1);
      ctx.fillRect(9, 12, 1, 1);
      break;
    }
    case T.ORE: {
      // A grey rock shot through with rusty iron and bright specks.
      circle(ctx, 8, 9, 6, '#161622');
      circle(ctx, 8, 9, 5, '#6a6a76');
      circle(ctx, 7, 8, 4, '#7d7a86');
      ctx.fillStyle = '#c87a3a';
      for (const [x, y] of [[5, 7], [9, 6], [10, 10], [6, 11], [8, 9]]) ctx.fillRect(x, y, 2, 1);
      ctx.fillStyle = '#e8e4d4';
      for (const [x, y] of [[6, 8], [10, 7], [8, 11]]) ctx.fillRect(x, y, 1, 1);
      break;
    }
    case T.PRISM: {
      // A cluster of clear crystal: cyan, violet and gold faces.
      const shards = [[6, 1, 4, 14, '#7ae8ff', '#c8f6ff'], [10, 5, 3, 10, '#a07aff', '#d8c8ff'], [2, 7, 4, 8, '#ffd27a', '#fff0c8']];
      for (const [x, y, w, h] of shards) {
        ctx.fillStyle = '#161622';
        ctx.fillRect(x - 1, y - 1, w + 2, h + 1);
      }
      for (const [x, y, w, h, c, l] of shards) {
        ctx.fillStyle = c;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = l;
        ctx.fillRect(x, y, 1, h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x + 1, y, 1, 1);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(8, 4, 1, 3);
      break;
    }
    case T.MIRROR: {
      // A tall slab of mirror crystal: silver, with the sky in it.
      ctx.fillStyle = '#161622';
      ctx.fillRect(3, 0, 10, 16);
      ctx.fillStyle = '#d8eef8';
      ctx.fillRect(4, 1, 8, 14);
      ctx.fillStyle = '#9ad0e8';
      ctx.fillRect(4, 9, 8, 6);
      ctx.fillStyle = '#7ab8d8';
      ctx.fillRect(4, 13, 8, 2);
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 6; i++) ctx.fillRect(5 + i, 7 - i, 1, 2);
      ctx.fillRect(10, 3, 1, 1);
      ctx.fillStyle = '#c09aff';
      ctx.fillRect(4, 1, 1, 14);
      ctx.fillStyle = '#7ae8ff';
      ctx.fillRect(11, 1, 1, 14);
      break;
    }
    case T.FENWATER: {
      // Swamp water: dark turquoise, slow ripples and a glint of light.
      ctx.fillStyle = '#1f5a5a';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#2a7070';
      for (let i = 0; i < 5; i++) ctx.fillRect(rng.int(0, 12), rng.int(0, 15), rng.int(2, 4), 1);
      ctx.fillStyle = '#5ab8a8';
      if (rng.next() < 0.6) ctx.fillRect(rng.int(1, 13), rng.int(1, 14), 2, 1);
      break;
    }
    case T.LUMENCAP: {
      // Glowing mushrooms: pale stems and luminous caps.
      const caps = [[5, 6, 4], [10, 9, 3], [4, 11, 2]];
      for (const [x, y, r] of caps) {
        ctx.fillStyle = '#161622';
        ctx.fillRect(x - 1, y, 3, 16 - y);
        ctx.fillStyle = '#e8f0e0';
        ctx.fillRect(x, y, 1, 15 - y);
      }
      for (const [x, y, r] of caps) {
        circle(ctx, x, y, r + 1, '#161622');
        circle(ctx, x, y, r, '#3ad8a8');
        circle(ctx, x - 1, y - 1, Math.max(1, r - 2), '#9affc8');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y - 1, 1, 1);
      }
      break;
    }
    case T.ROOTS: {
      // Great roots heaving out of the mud.
      const root = (pts) => {
        for (const [x, y] of pts) {
          ctx.fillStyle = '#161622';
          ctx.fillRect(x - 1, y - 1, 4, 4);
        }
        for (const [x, y] of pts) {
          ctx.fillStyle = '#5a3a22';
          ctx.fillRect(x, y, 2, 2);
          ctx.fillStyle = '#7a5232';
          ctx.fillRect(x, y, 1, 1);
        }
      };
      root([[1, 13], [3, 10], [5, 8], [7, 7], [9, 7], [11, 8], [13, 11], [14, 14]]);
      root([[4, 14], [6, 12], [8, 11], [10, 12], [11, 14]]);
      ctx.fillStyle = '#4f8a44';
      ctx.fillRect(7, 6, 2, 1);
      ctx.fillRect(12, 7, 1, 1);
      break;
    }
    case T.RUIN: {
      // A ruined pillar, half sunk in the ground, moss on top.
      ctx.fillStyle = '#161622';
      ctx.fillRect(3, 2, 10, 14);
      ctx.fillStyle = '#8a8a96';
      ctx.fillRect(4, 3, 8, 12);
      ctx.fillStyle = '#a8a8b4';
      ctx.fillRect(4, 3, 2, 12);
      ctx.fillStyle = '#6a6a76';
      ctx.fillRect(4, 7, 8, 1);
      ctx.fillRect(4, 11, 8, 1);
      ctx.fillRect(9, 3, 1, 4);
      ctx.fillStyle = '#4f8a44';
      ctx.fillRect(4, 3, 8, 1);
      ctx.fillRect(5, 4, 3, 1);
      ctx.fillStyle = '#161622';
      ctx.fillRect(11, 2, 2, 2);
      break;
    }
    case T.MENDBLOOM: {
      // A healing bloom: soft pink petals over broad leaves.
      ctx.fillStyle = '#161622';
      ctx.fillRect(3, 9, 10, 5);
      ctx.fillStyle = '#3a8a4a';
      ctx.fillRect(4, 10, 8, 3);
      ctx.fillStyle = '#5ab85a';
      ctx.fillRect(4, 10, 3, 1);
      circle(ctx, 8, 7, 4, '#161622');
      circle(ctx, 8, 7, 3, '#ff9ad8');
      circle(ctx, 7, 6, 1, '#ffd8f0');
      ctx.fillStyle = '#9affc8';
      ctx.fillRect(8, 7, 1, 1);
      break;
    }
    case T.PUFFCAP: {
      // A puffball: round, yellow-green and spotted (best not touched).
      circle(ctx, 8, 10, 5, '#161622');
      circle(ctx, 8, 10, 4, '#b8d84a');
      circle(ctx, 7, 9, 2, '#d8f07a');
      ctx.fillStyle = '#7a9a2a';
      for (const [x, y] of [[10, 9], [6, 12], [9, 12], [11, 11]]) ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = '#161622';
      ctx.fillRect(7, 15, 3, 1);
      break;
    }
    case T.SKY: {
      // Looking down into the sea of clouds.
      ctx.fillStyle = '#b8cce4';
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#a4bcd8';
      for (let i = 0; i < 4; i++) ctx.fillRect(rng.int(0, 11), rng.int(0, 15), rng.int(3, 6), 1);
      for (let i = 0; i < 2; i++) circle(ctx, rng.int(3, 12), rng.int(3, 12), rng.int(1, 2), '#dce8f6');
      ctx.fillStyle = '#ffffff';
      if (rng.next() < 0.5) ctx.fillRect(rng.int(2, 12), rng.int(2, 13), 2, 1);
      break;
    }
    case T.AETHERCRYSTAL: {
      // Pale floating crystal, light as air.
      const shards = [[6, 1, 4, 12], [10, 5, 3, 8], [3, 6, 3, 7]];
      for (const [x, y, w, h] of shards) {
        ctx.fillStyle = '#161622';
        ctx.fillRect(x - 1, y - 1, w + 2, h + 1);
      }
      for (const [x, y, w, h] of shards) {
        ctx.fillStyle = '#d8ecff';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, 1, h);
        ctx.fillStyle = '#8ab8f0';
        ctx.fillRect(x + w - 1, y + 1, 1, h - 1);
      }
      break;
    }
    case T.STARSTONE: {
      // A golden crystal cluster that glitters.
      const shards = [[6, 2, 4, 13], [10, 6, 3, 9], [3, 8, 3, 7]];
      for (const [x, y, w, h] of shards) {
        ctx.fillStyle = '#161622';
        ctx.fillRect(x - 1, y - 1, w + 2, h + 1);
        ctx.fillStyle = '#c8961a';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#ffd24a';
        ctx.fillRect(x, y, 1, h);
        ctx.fillStyle = '#fff4b0';
        ctx.fillRect(x + 1, y, 1, 1);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(8, 5, 1, 1);
      ctx.fillRect(11, 9, 1, 1);
      break;
    }
    default:
      break;
  }
}

const tileCache = new Map();

/** Skyreach's plank bridges (over the clouds) and wind currents (arrows the way they blow). */
function drawSkyGround(ctx, id, rng) {
  drawBlocker(ctx, T.SKY, rng);
  if (id === T.SKYBRIDGE) {
    ctx.fillStyle = '#161622';
    ctx.fillRect(1, 0, 14, 16);
    for (let y = 0; y < 16; y += 4) {
      ctx.fillStyle = (y / 4) % 2 ? '#9a6a3a' : '#a8784a';
      ctx.fillRect(2, y, 12, 3);
      ctx.fillStyle = '#c89a62';
      ctx.fillRect(2, y, 12, 1);
    }
    ctx.fillStyle = '#5a3a1e';
    ctx.fillRect(1, 0, 1, 16);
    ctx.fillRect(14, 0, 1, 16);
    return;
  }
  // A wind current: a pale streak of air with chevrons.
  const [dx, dy] = WIND.get(id) ?? [0, -1];
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  if (dx) ctx.fillRect(0, 4, 16, 8);
  else ctx.fillRect(4, 0, 8, 16);
  ctx.fillStyle = '#ffffff';
  for (let k = 0; k < 2; k++) {
    const c = 4 + k * 8;
    for (let i = -2; i <= 2; i++) {
      // A chevron pointing (dx, dy).
      const a = Math.abs(i);
      if (dx) ctx.fillRect(c + dx * (2 - a) - (dx < 0 ? 0 : 1), 8 + i, 1, 1);
      else ctx.fillRect(8 + i, c + dy * (2 - a) - (dy < 0 ? 0 : 1), 1, 1);
    }
  }
}

const SKY_GROUNDS = new Set([T.SKYBRIDGE, T.WIND_N, T.WIND_E, T.WIND_S, T.WIND_W]);

export function tileCanvas(id, variant, blocker = false) {
  const key = `${blocker ? 'b' : 'g'}${id}:${variant}`;
  let c = tileCache.get(key);
  if (!c) {
    c = createCanvas(TILE_PX, TILE_PX);
    const ctx = ctx2d(c);
    const rng = createRng(id * 977 + variant * 131 + (blocker ? 7 : 0));
    if (blocker) drawBlocker(ctx, id, rng);
    else if (SKY_GROUNDS.has(id)) drawSkyGround(ctx, id, rng);
    else drawGround(ctx, GROUND_STYLE[id] ?? GROUND_STYLE[T.GRASS], rng);
    tileCache.set(key, c);
  }
  return c;
}

const STUMP_TREES = new Set([T.TREE, T.PINE, T.PALM]);

/**
 * A cut tree or rock growing back, stage 0 (stump / rubble) to 3 (nearly
 * grown). Drawn over the ground like a blocker, but walkable.
 */
function drawGrowth(ctx, id, stage) {
  const O = '#161622';
  if (STUMP_TREES.has(id)) {
    if (stage <= 1) {
      // A cut stump with rings on top (and a first green shoot).
      ctx.fillStyle = O;
      ctx.fillRect(5, 9, 6, 6);
      ctx.fillStyle = id === T.PALM ? '#9a6a3a' : '#6a4424';
      ctx.fillRect(6, 11, 4, 3);
      ctx.fillStyle = '#d8b07a';
      ctx.fillRect(6, 10, 4, 1);
      ctx.fillStyle = '#a87a48';
      ctx.fillRect(7, 10, 2, 1);
      if (stage === 1) {
        ctx.fillStyle = O;
        ctx.fillRect(10, 6, 4, 5);
        ctx.fillStyle = '#5cb85a';
        ctx.fillRect(11, 8, 1, 2);
        ctx.fillRect(11, 7, 2, 1);
        ctx.fillRect(12, 6, 1, 1);
      }
      return;
    }
    if (id === T.PINE) {
      const rows = stage === 2 ? 6 : 9;
      const top = 15 - rows - 2;
      ctx.fillStyle = '#5a3a22';
      ctx.fillRect(7, 13, 2, 3);
      for (let row = 0; row < rows; row++) {
        const half = Math.floor(row / 2) + 1;
        ctx.fillStyle = O;
        ctx.fillRect(8 - half - 1, top + row, half * 2 + 2, 1);
        ctx.fillStyle = row % 4 < 2 ? '#2a5a3a' : '#3a7a4a';
        ctx.fillRect(8 - half, top + row, half * 2, 1);
      }
      return;
    }
    if (id === T.PALM) {
      const h = stage === 2 ? 5 : 8;
      ctx.fillStyle = O;
      ctx.fillRect(6, 15 - h, 4, h + 1);
      ctx.fillStyle = '#9a6a3a';
      ctx.fillRect(7, 16 - h, 2, h - 1);
      ctx.fillStyle = '#4fb04f';
      const y = 15 - h;
      ctx.fillRect(3, y, 4, 1);
      ctx.fillRect(9, y, 4, 1);
      ctx.fillRect(5, y - 1, 6, 1);
      ctx.fillStyle = '#2f8a3c';
      ctx.fillRect(2, y + 1, 2, 1);
      ctx.fillRect(12, y + 1, 2, 1);
      return;
    }
    // A broadleaf sapling, then a young tree.
    const r = stage === 2 ? 3 : 5;
    const cy = stage === 2 ? 9 : 8;
    ctx.fillStyle = O;
    ctx.fillRect(7, cy + r - 1, 3, 16 - (cy + r - 1));
    ctx.fillStyle = '#6a4424';
    ctx.fillRect(8, cy + r - 1, 1, 15 - (cy + r - 1));
    circle(ctx, 8, cy, r + 1, O);
    circle(ctx, 8, cy, r, '#3f9a44');
    circle(ctx, 7, cy - 1, Math.max(1, r - 2), '#5cb85a');
    return;
  }
  if (id === T.CACTUS) {
    const h = [3, 5, 8, 10][stage];
    ctx.fillStyle = O;
    ctx.fillRect(6, 15 - h, 4, h + 1);
    ctx.fillStyle = '#4a9a4a';
    ctx.fillRect(7, 16 - h, 2, h - 1);
    ctx.fillStyle = '#7ac86a';
    ctx.fillRect(7, 16 - h, 1, h - 2);
    return;
  }
  // Rocks, ore, obsidian, crystals and starstone: rubble that slowly builds up again.
  const colors = {
    [T.CRYSTAL]: ['#6b3fc6', '#cdb2ff'], [T.STARSTONE]: ['#c8961a', '#fff4b0'],
    [T.OBSIDIAN]: ['#2a2238', '#9a7aff'], [T.ORE]: ['#6a6a76', '#c87a3a'],
  }[id] ?? ['#6a6a76', '#b0b0bc'];
  if (stage <= 1) {
    const bits = stage === 0 ? [[4, 11], [9, 12], [7, 9]] : [[4, 11], [9, 12], [7, 9], [11, 9], [6, 13]];
    for (const [x, y] of bits) {
      ctx.fillStyle = O;
      ctx.fillRect(x - 1, y - 1, 4, 3);
      ctx.fillStyle = colors[0];
      ctx.fillRect(x, y, 2, 1);
      ctx.fillStyle = colors[1];
      ctx.fillRect(x, y, 1, 1);
    }
    return;
  }
  const r = stage === 2 ? 3 : 4;
  circle(ctx, 8, 11, r + 1, O);
  circle(ctx, 8, 11, r, colors[0]);
  ctx.fillStyle = colors[1];
  ctx.fillRect(7, 10 - (r >> 1), 2, 1);
}

const growthCache = new Map();

export function growthCanvas(id, stage) {
  const key = `${id}:${stage}`;
  let c = growthCache.get(key);
  if (!c) {
    c = createCanvas(TILE_PX, TILE_PX);
    drawGrowth(ctx2d(c), id, stage);
    growthCache.set(key, c);
  }
  return c;
}

/**
 * Pre-renders a chunk (ground + blockers) into one canvas. `growth` lists
 * cut trees and rocks growing back ([[tile index, tile id, stage]], from
 * World#growthOf).
 */
export function renderChunk(chunk, growth = null) {
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
  for (const [i, id, stage] of growth ?? []) ctx.drawImage(growthCanvas(id, stage), (i % CHUNK) * TILE_PX, ((i / CHUNK) | 0) * TILE_PX);
  return canvas;
}
