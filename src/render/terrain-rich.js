// The rich terrain style: deeper, softer ground with big light and dark
// patches, a darker forest floor under and between trees, damp banks and
// foam along the water, and fuller trees and boulders with outlines,
// shading and cast shadows (their crowns reach into the tile above, so a
// forest closes up). Everything is drawn once per chunk into its canvas,
// like the classic style, so it costs nothing per frame. Only the look
// changes: tiles, collisions and rules are exactly as before.

import { createRng, hashInts } from '../core/rng.js';
import { createCanvas, ctx2d } from './canvas.js';
import { T, CHUNK, LIQUID } from '../game/world.js';
import { tileCanvas, growthCanvas, TILE_PX, GROUND_STYLE } from './tiles-art.js';

const S = TILE_PX;
const VARIANTS = 4;
const O = '#141a16'; // outline

// --- Ground ------------------------------------------------------------------------------

const RICH_GROUND = {
  [T.GRASS]: { base: '#3f7a3b', tones: ['#376f35', '#47833f', '#4c8a43'], tuft: ['#5c9d4c', '#2f6230'] },
  [T.FLOWERS]: { base: '#3f7a3b', tones: ['#376f35', '#47833f', '#4c8a43'], tuft: ['#5c9d4c', '#2f6230'], flowers: ['#ffd84a', '#ff8ab8', '#f4f0e8', '#9ac0ff'] },
  [T.MOSS]: { base: '#3a733a', tones: ['#336a35', '#41793f', '#376e38'], tuft: ['#558f4a', '#2a5a2e'] },
  [T.ROCKGRASS]: { base: '#5f7f4e', tones: ['#577547', '#6a8a58', '#7a7d76'], tuft: ['#7c9a62', '#4c6a3e'], pebbles: ['#8a8c88', '#6e706c'] },
  [T.PATH]: { base: '#8f7048', tones: ['#82633e', '#9c7c52', '#7a5c3a'], pebbles: ['#b39a76', '#6a5034'] },
  [T.SAND]: { base: '#d8bd7e', tones: ['#ccb070', '#e2c88c', '#d2b676'], pebbles: ['#bfa264'] },
  [T.SAND2]: { base: '#d0b272', tones: ['#c4a666', '#dabd80', '#c9ab6c'], ripples: '#b89a5a' },
  [T.SNOW]: { base: '#e6eef6', tones: ['#d8e2ee', '#f2f6fb', '#dfe8f2'], pebbles: ['#c4d2e2'] },
  [T.ASH]: { base: '#45404b', tones: ['#3d3843', '#504a56', '#3a3540'], embers: '#ff7a3a' },
  [T.VOIDMOSS]: { base: '#36284c', tones: ['#2f2242', '#3f3058', '#33264a'], tuft: ['#55407a', '#261c38'] },
  [T.PRISMSAND]: { base: '#e2dbee', tones: ['#d6cde8', '#ece6f6', '#dcd4ec'], pebbles: ['#c4b8dc'], glints: ['#7ae8ff', '#ff9ad8', '#ffd27a'] },
  [T.PRISMGLASS]: { base: '#c4dfec', tones: ['#b6d6e6', '#d4eaf4', '#bcdaea'], ripples: '#a6cce0', glints: ['#ffffff', '#7ae8ff'] },
};

function drawRichGround(ctx, style, rng) {
  ctx.fillStyle = style.base;
  ctx.fillRect(0, 0, S, S);
  // Soft mottling: little clumps of the neighbouring tones.
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = rng.pick(style.tones);
    const x = rng.int(0, 14);
    const y = rng.int(0, 14);
    ctx.fillRect(x, y, rng.int(1, 2), 1);
    if (rng.chance(0.5)) ctx.fillRect(x + rng.int(-1, 1), y + 1, 1, 1);
  }
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = rng.pick(style.tones);
    ctx.fillRect(rng.int(0, 15), rng.int(0, 15), 1, 1);
  }
  if (style.tuft) {
    // Tufts of grass: a lit blade pair over a dark root.
    for (let i = 0; i < 3; i++) {
      const x = rng.int(1, 13);
      const y = rng.int(3, 14);
      ctx.fillStyle = style.tuft[1];
      ctx.fillRect(x, y, 3, 1);
      ctx.fillStyle = style.tuft[0];
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x + 2, y - 1, 1, 1);
      ctx.fillRect(x + 1, y - 2, 1, 2);
    }
  }
  if (style.pebbles) {
    for (let i = 0; i < 3; i++) {
      const x = rng.int(1, 14);
      const y = rng.int(1, 14);
      ctx.fillStyle = style.pebbles[0];
      ctx.fillRect(x, y, 2, 1);
      if (style.pebbles[1]) {
        ctx.fillStyle = style.pebbles[1];
        ctx.fillRect(x, y + 1, 2, 1);
      }
    }
  }
  if (style.flowers) {
    for (let i = 0; i < 2; i++) {
      const x = rng.int(2, 13);
      const y = rng.int(2, 13);
      ctx.fillStyle = '#2a5a2c';
      ctx.fillRect(x, y + 1, 1, 2);
      ctx.fillStyle = rng.pick(style.flowers);
      ctx.fillRect(x - 1, y, 3, 1);
      ctx.fillRect(x, y - 1, 1, 3);
      ctx.fillStyle = '#ffe890';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  if (style.ripples) {
    ctx.fillStyle = style.ripples;
    for (let i = 0; i < 3; i++) ctx.fillRect(rng.int(0, 8), rng.int(2, 14), rng.int(4, 8), 1);
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
}

const groundCache = new Map();

function groundTile(id, variant) {
  const style = RICH_GROUND[id];
  if (!style) return tileCanvas(id, variant);
  const key = `${id}:${variant}`;
  let c = groundCache.get(key);
  if (!c) {
    c = createCanvas(S, S);
    drawRichGround(ctx2d(c), style, createRng(id * 1931 + variant * 211 + 5));
    groundCache.set(key, c);
  }
  return c;
}

/** The main colour of a ground (for the frayed edges between grounds). */
function groundColor(id) {
  return RICH_GROUND[id]?.base ?? GROUND_STYLE[id]?.base ?? null;
}

/** Ground kinds that blend into each other at their edges (not paving or the camp). */
const FRAYS = new Set([T.GRASS, T.FLOWERS, T.MOSS, T.ROCKGRASS, T.SAND, T.SAND2, T.SNOW, T.ICE, T.ASH, T.BASALT, T.VOIDSTONE, T.VOIDMOSS, T.PATH, T.PRISMSAND, T.PRISMGLASS]);
/** Grass and its kin count as one ground (they already look alike). */
const FAMILY = { [T.FLOWERS]: T.GRASS, [T.MOSS]: T.GRASS };

/** Pale grounds (shade shows strongly on them). */
const LIGHT = new Set([T.SNOW, T.ICE, T.SAND, T.SAND2, T.PRISMSAND, T.PRISMGLASS]);

/** Grounds that get the big light and dark patches (natural ground, not paving). */
const PATCHY = new Set([T.GRASS, T.FLOWERS, T.MOSS, T.ROCKGRASS, T.SAND, T.SAND2, T.SNOW, T.ASH, T.VOIDMOSS, T.VOIDSTONE, T.BASALT, T.PRISMSAND]);

// Smooth value noise over world pixels (a few tiles per bump), for the patches.
function lattice(seed, x, y) {
  return (hashInts(seed, x, y) % 1024) / 1023;
}

function vnoise(seed, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(seed, x0, y0);
  const b = lattice(seed, x0 + 1, y0);
  const c = lattice(seed, x0, y0 + 1);
  const d = lattice(seed, x0 + 1, y0 + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

// --- Upright things: trees, boulders and the rest ------------------------------------------

/** Tiles drawn standing up (with a shadow), in row order, over the ground. */
const UPRIGHT = new Set([T.TREE, T.PINE, T.PALM, T.ROCK, T.CACTUS, T.CRYSTAL, T.OBSIDIAN, T.ORE, T.STARSTONE, T.PRISM, T.MIRROR]);
/** How far (in tiles) a tile's shading reaches its neighbours. */
const SHADES = new Set([T.TREE, T.PINE, T.PALM, T.ROCK, T.ORE, T.OBSIDIAN]);

function disc(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  const rr = r * r + r * 0.8;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(Math.max(0, rr - y * y)));
    ctx.fillRect(cx - w, cy + y, w * 2 + 1, 1);
  }
}

/** A pixel ellipse (shadows). */
function ellipse(ctx, cx, cy, rx, ry, color) {
  ctx.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / ((ry + 0.5) * (ry + 0.5)))));
    if (w > 0) ctx.fillRect(cx - w, cy + y, w * 2, 1);
  }
}

const CANOPY = [
  { o: O, d: '#22492a', m: '#2f6634', l: '#3f8040', h: '#5f9f4c' }, // deep green
  { o: O, d: '#254d2a', m: '#336b36', l: '#468743', h: '#6aa852' },
  { o: O, d: '#1f4428', m: '#2b5f33', l: '#3a783e', h: '#58954a' },
  { o: O, d: '#2a4f26', m: '#3a7030', l: '#4f8c3c', h: '#78b058' }, // a lighter, yellower one
];

/** A broadleaf tree, 32×32, its trunk's foot at the bottom middle. */
function drawTree(ctx, variant) {
  const rng = createRng(0x7e3 + variant * 97);
  const c = CANOPY[variant % CANOPY.length];
  // Trunk and roots.
  ctx.fillStyle = O;
  ctx.fillRect(13, 19, 6, 13);
  ctx.fillRect(11, 29, 10, 3);
  ctx.fillStyle = '#5a3a22';
  ctx.fillRect(14, 19, 4, 12);
  ctx.fillRect(12, 30, 8, 1);
  ctx.fillStyle = '#7a5030';
  ctx.fillRect(14, 20, 1, 10);
  ctx.fillStyle = '#3e2816';
  ctx.fillRect(17, 21, 1, 9);
  // The crown: overlapping clumps.
  const clumps = [
    [16, 13, 10],
    [9 + rng.int(-1, 1), 15, 6 + rng.int(0, 1)],
    [23 + rng.int(-1, 1), 15, 6 + rng.int(0, 1)],
    [16 + rng.int(-2, 2), 6, 6 + rng.int(0, 1)],
  ];
  for (const [x, y, r] of clumps) disc(ctx, x, y, r + 1, c.o);
  for (const [x, y, r] of clumps) disc(ctx, x, y, r, c.d);
  for (const [x, y, r] of clumps) disc(ctx, x - 1, y - 1, r - 1, c.m);
  for (const [x, y, r] of clumps) disc(ctx, x - 2, y - 2, Math.max(1, r - 4), c.l);
  // Leaf texture: dark nicks below, bright flecks up left.
  for (let i = 0; i < 26; i++) {
    const [x, y, r] = rng.pick(clumps);
    const a = rng.next() * Math.PI * 2;
    const d = rng.next() * (r - 2);
    const px = Math.round(x + Math.cos(a) * d);
    const py = Math.round(y + Math.sin(a) * d);
    const lit = px + py < x + y - 2;
    ctx.fillStyle = lit ? c.h : c.d;
    ctx.fillRect(px, py, 1, 1);
  }
  ctx.fillStyle = c.h;
  ctx.fillRect(10, 9, 2, 1);
  ctx.fillRect(13, 4, 2, 1);
  ctx.fillRect(7, 13, 1, 1);
}

/** A pine, 32×36 (snowy ones in the snow), its foot at the bottom middle. */
function drawPine(ctx, variant, snowy) {
  const rng = createRng(0x9a1 + variant * 53);
  ctx.fillStyle = O;
  ctx.fillRect(14, 28, 4, 8);
  ctx.fillStyle = '#5a3a22';
  ctx.fillRect(15, 28, 2, 7);
  const tiers = [[3, 7], [9, 9], [15, 11], [21, 12]];
  const green = ['#1f4a32', '#2a5e3c', '#3a7448'];
  for (const [top, half] of tiers) {
    for (let row = 0; row < 9; row++) {
      const w = Math.min(half, 1 + Math.floor(row * half / 8));
      ctx.fillStyle = O;
      ctx.fillRect(16 - w - 1, top + row, w * 2 + 2, 1);
    }
  }
  for (const [top, half] of tiers) {
    for (let row = 0; row < 8; row++) {
      const w = Math.min(half, 1 + Math.floor(row * half / 8));
      ctx.fillStyle = green[1];
      ctx.fillRect(16 - w, top + row, w * 2, 1);
      ctx.fillStyle = green[2];
      ctx.fillRect(16 - w, top + row, Math.max(1, Math.floor(w * 0.7)), 1);
      ctx.fillStyle = green[0];
      ctx.fillRect(16 + Math.floor(w * 0.4), top + row, Math.ceil(w * 0.6), 1);
    }
  }
  if (snowy) {
    ctx.fillStyle = '#eef4fa';
    for (const [top, half] of tiers) {
      ctx.fillRect(16 - Math.floor(half / 2), top + 2, half - 1, 1);
      ctx.fillRect(15, top, 2, 1);
    }
  } else {
    ctx.fillStyle = '#4f8a54';
    for (let i = 0; i < 6; i++) ctx.fillRect(rng.int(10, 18), rng.int(6, 26), 1, 1);
  }
}

/** A palm, 32×32: a leaning ringed trunk and arching fronds, its foot at the bottom middle. */
function drawPalm(ctx, variant) {
  const lean = variant & 1 ? 1 : -1;
  // The trunk, leaning a little (dark outline, then rings).
  const trunk = [];
  for (let y = 31; y >= 9; y--) trunk.push([16 + Math.round(((31 - y) / 22) ** 1.6 * 4 * lean), y]);
  for (const [x, y] of trunk) {
    ctx.fillStyle = O;
    ctx.fillRect(x - 2, y, 5, 1);
  }
  for (const [x, y] of trunk) {
    ctx.fillStyle = y % 3 === 0 ? '#6e4a28' : '#9a6a3a';
    ctx.fillRect(x - 1, y, 3, 1);
    ctx.fillStyle = '#b8864e';
    ctx.fillRect(x - 1, y, 1, 1);
  }
  const [tx, ty] = trunk[trunk.length - 1];
  // Fronds: arcs out from the top, drooping at the ends.
  const frond = (dir, len, droop, color) => {
    for (let i = 0; i <= len; i++) {
      const x = tx + dir * i;
      const y = ty + Math.round((i / len) ** 2 * droop) - (i < 3 ? 1 : 0);
      ctx.fillStyle = O;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
    for (let i = 0; i <= len; i++) {
      const x = tx + dir * i;
      const y = ty + Math.round((i / len) ** 2 * droop) - (i < 3 ? 1 : 0);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
      if (i > 1 && i < len) ctx.fillRect(x, y + 1, 1, 1);
    }
  };
  frond(-1, 11, 7, '#2f8a3c');
  frond(1, 11, 7, '#2f8a3c');
  frond(-1, 8, 2, '#4fb04f');
  frond(1, 8, 2, '#4fb04f');
  for (const [dx, dy] of [[-6, -3], [6, -3], [-3, -5], [3, -5]]) {
    ctx.fillStyle = O;
    ctx.fillRect(tx + dx - 1, ty + dy - 1, 3, 3);
  }
  ctx.fillStyle = '#5cc05a';
  for (const [dx, dy] of [[-6, -3], [6, -3], [-3, -5], [3, -5], [-4, -4], [4, -4], [-2, -5], [2, -5], [0, -5]]) ctx.fillRect(tx + dx, ty + dy, 1, 1);
  // Coconuts.
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(tx - 2, ty + 1, 2, 2);
  ctx.fillRect(tx + 1, ty + 1, 2, 2);
}

/** A boulder, 24×20 (mossy on green ground), its foot at the bottom middle. */
function drawBoulder(ctx, variant, mossy, tint) {
  const rng = createRng(0xb01 + variant * 41);
  const [d, m, l, h] = tint ?? ['#4e4e5a', '#6a6a76', '#84848f', '#a8a8b4'];
  const w = 8 + (variant & 1);
  disc(ctx, 12, 12, w, O);
  disc(ctx, 12, 12, w - 1, d);
  disc(ctx, 11, 11, w - 2, m);
  disc(ctx, 10, 9, w - 5, l);
  ctx.fillStyle = h;
  ctx.fillRect(8, 6, 3, 1);
  ctx.fillRect(7, 7, 1, 1);
  ctx.fillStyle = d;
  for (let i = 0; i < 3; i++) {
    const x = rng.int(8, 15);
    const y = rng.int(9, 15);
    ctx.fillRect(x, y, 2, 1);
    ctx.fillRect(x + 1, y + 1, 1, 1);
  }
  // The ground line: flatten the bottom.
  ctx.clearRect(0, 19, 24, 1);
  ctx.fillStyle = O;
  ctx.fillRect(5, 18, 14, 1);
  if (mossy) {
    ctx.fillStyle = '#4f8a44';
    ctx.fillRect(7, 5, 6, 1);
    ctx.fillRect(6, 6, 3, 1);
    ctx.fillStyle = '#6aa852';
    ctx.fillRect(8, 5, 2, 1);
  }
}

const uprightCache = new Map();

/** The standing sprite for a tile, and where its foot is: { canvas, ox, oy } (top-left offset from the tile's top-left). */
function upright(id, variant, ground) {
  const snowy = ground === T.SNOW || ground === T.ICE;
  const mossy = ground === T.GRASS || ground === T.MOSS || ground === T.FLOWERS;
  const key = `${id}:${variant}:${snowy ? 's' : mossy ? 'm' : ''}`;
  let u = uprightCache.get(key);
  if (u) return u;
  let canvas;
  let ox;
  let oy;
  if (id === T.TREE) {
    canvas = createCanvas(32, 32);
    drawTree(ctx2d(canvas), variant);
    ox = -8;
    oy = -16;
  } else if (id === T.PINE) {
    canvas = createCanvas(32, 36);
    drawPine(ctx2d(canvas), variant, snowy);
    ox = -8;
    oy = -20;
  } else if (id === T.PALM) {
    canvas = createCanvas(32, 32);
    drawPalm(ctx2d(canvas), variant);
    ox = -8;
    oy = -16;
  } else if (id === T.ROCK) {
    canvas = createCanvas(24, 20);
    drawBoulder(ctx2d(canvas), variant, mossy);
    ox = -4;
    oy = -4;
  } else {
    // Palms, cacti, crystals, ore and the like keep their classic art.
    canvas = tileCanvas(id, variant, true);
    ox = 0;
    oy = 0;
  }
  u = { canvas, ox, oy };
  uprightCache.set(key, u);
  return u;
}

const SHADOW = 'rgba(8, 20, 12, 0.3)';
const SHADOW_SOFT = 'rgba(8, 20, 12, 0.16)';

function castShadow(ctx, id, px, py) {
  // (px, py): the tile's top-left in the chunk canvas.
  if (id === T.TREE) {
    ellipse(ctx, px + 10, py + 14, 13, 5, SHADOW_SOFT);
    ellipse(ctx, px + 9, py + 14, 9, 3, SHADOW);
  } else if (id === T.PALM) {
    ellipse(ctx, px + 11, py + 14, 9, 3, SHADOW_SOFT);
    ellipse(ctx, px + 9, py + 15, 4, 2, SHADOW);
  } else if (id === T.PINE) {
    ellipse(ctx, px + 10, py + 15, 9, 3, SHADOW_SOFT);
    ellipse(ctx, px + 9, py + 15, 6, 2, SHADOW);
  } else if (id === T.ROCK || id === T.ORE || id === T.OBSIDIAN) {
    ellipse(ctx, px + 9, py + 14, 8, 3, SHADOW);
  } else {
    ellipse(ctx, px + 9, py + 14, 6, 2, SHADOW);
  }
}

// --- The chunk -----------------------------------------------------------------------------

function variantOf(wx, wy) {
  return ((wx * 73856093) ^ (wy * 19349663)) & (VARIANTS - 1);
}

/**
 * Pre-renders a chunk in the rich style. `world` gives the neighbours'
 * tiles (crowns, shadows and banks reach across chunk edges).
 */
export function renderChunkRich(chunk, growth, world) {
  const size = CHUNK * S;
  const canvas = createCanvas(size, size);
  const ctx = ctx2d(canvas);
  const x0 = chunk.cx * CHUNK;
  const y0 = chunk.cy * CHUNK;
  const blockAt = (wx, wy) => {
    const lx = wx - x0;
    const ly = wy - y0;
    if (lx >= 0 && ly >= 0 && lx < CHUNK && ly < CHUNK) return chunk.block[ly * CHUNK + lx];
    return world.blockAt(wx, wy);
  };
  const groundAt = (wx, wy) => {
    const lx = wx - x0;
    const ly = wy - y0;
    if (lx >= 0 && ly >= 0 && lx < CHUNK && ly < CHUNK) return chunk.ground[ly * CHUNK + lx];
    return world.groundAt(wx, wy);
  };
  const seed = world.seed ?? 0;

  // 1. Ground, and the liquids (they lie flat).
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = ly * CHUNK + lx;
      const v = variantOf(x0 + lx, y0 + ly);
      ctx.drawImage(groundTile(chunk.ground[i], v), lx * S, ly * S);
      const b = chunk.block[i];
      if (b && LIQUID.has(b)) ctx.drawImage(tileCanvas(b, v, true), lx * S, ly * S);
    }
  }

  // 1b. Where two kinds of ground meet, the edge frays: a few pixels of the
  //     neighbour's colour scattered over the border.
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = ly * CHUNK + lx;
      const g = chunk.ground[i];
      if (!FRAYS.has(g) || LIQUID.has(chunk.block[i])) continue;
      const wx = x0 + lx;
      const wy = y0 + ly;
      const fam = FAMILY[g] ?? g;
      const rng = createRng(hashInts(wx, wy, 0xf4a7));
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const ng = groundAt(wx + dx, wy + dy);
        if (!FRAYS.has(ng) || (FAMILY[ng] ?? ng) === fam || LIQUID.has(blockAt(wx + dx, wy + dy))) continue;
        const color = groundColor(ng);
        if (!color) continue;
        ctx.fillStyle = color;
        for (let k = 0; k < 9; k++) {
          const along = rng.int(0, S - 1);
          const depth = rng.next() < 0.6 ? 0 : rng.next() < 0.7 ? 1 : 2;
          const w = rng.chance(0.4) ? 2 : 1;
          const x = dx ? (dx < 0 ? depth : S - 1 - depth) : along;
          const y = dy ? (dy < 0 ? depth : S - 1 - depth) : along;
          ctx.fillRect(lx * S + x, ly * S + y, dx ? 1 : w, dy ? 1 : w);
        }
      }
    }
  }

  // 2. Big soft patches of light and shade on natural ground (4-pixel cells).
  const CELL = 4;
  for (let cy = 0; cy < size / CELL; cy++) {
    for (let cx = 0; cx < size / CELL; cx++) {
      const lx = (cx * CELL / S) | 0;
      const ly = (cy * CELL / S) | 0;
      const i = ly * CHUNK + lx;
      if (!PATCHY.has(chunk.ground[i]) || LIQUID.has(chunk.block[i])) continue;
      const wx = (x0 * S + cx * CELL) / (S * 5);
      const wy = (y0 * S + cy * CELL) / (S * 5);
      const n = vnoise(seed ^ 0x5a7c, wx, wy) * 0.7 + vnoise(seed ^ 0x5a7d, wx * 2.3, wy * 2.3) * 0.3;
      // (Light ground shows shade much more: softer patches on snow and sand.)
      const k = LIGHT.has(chunk.ground[i]) ? 0.4 : 1;
      if (n < 0.36) {
        ctx.fillStyle = `rgba(10, 30, 16, ${((n < 0.26 ? 0.16 : 0.08) * k).toFixed(3)})`;
        ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
      } else if (n > 0.66) {
        ctx.fillStyle = `rgba(255, 246, 190, ${((n > 0.76 ? 0.09 : 0.05) * k).toFixed(3)})`;
        ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
      }
    }
  }

  // 3. Shade between trees and rocks (a darker forest floor), and banks along the water.
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const wx = x0 + lx;
      const wy = y0 + ly;
      const b = chunk.block[ly * CHUNK + lx];
      const px = lx * S;
      const py = ly * S;
      if (b && LIQUID.has(b)) {
        if (b === T.LAVA) {
          // A dark cooled crust where the lava meets the land.
          const land = (dx, dy) => {
            const nb = blockAt(wx + dx, wy + dy);
            return !nb || !LIQUID.has(nb);
          };
          ctx.fillStyle = 'rgba(40, 14, 8, 0.55)';
          if (land(0, -1)) ctx.fillRect(px, py, S, 2);
          if (land(0, 1)) ctx.fillRect(px, py + S - 2, S, 2);
          if (land(-1, 0)) ctx.fillRect(px, py, 2, S);
          if (land(1, 0)) ctx.fillRect(px + S - 2, py, 2, S);
          continue;
        }
        // Foam and lighter shallows where the water meets the land.
        const land = (dx, dy) => {
          const nb = blockAt(wx + dx, wy + dy);
          return !nb || !LIQUID.has(nb);
        };
        ctx.fillStyle = 'rgba(150, 210, 240, 0.35)';
        if (land(0, -1)) ctx.fillRect(px, py, S, 3);
        if (land(0, 1)) ctx.fillRect(px, py + S - 2, S, 2);
        if (land(-1, 0)) ctx.fillRect(px, py, 2, S);
        if (land(1, 0)) ctx.fillRect(px + S - 2, py, 2, S);
        ctx.fillStyle = 'rgba(235, 248, 255, 0.75)';
        if (land(0, -1)) for (let x = 0; x < S; x += 3) ctx.fillRect(px + x, py + ((x >> 2) & 1), 2, 1);
        if (land(-1, 0)) for (let y = 1; y < S; y += 4) ctx.fillRect(px, py + y, 1, 2);
        if (land(1, 0)) for (let y = 2; y < S; y += 4) ctx.fillRect(px + S - 1, py + y, 1, 2);
        continue;
      }
      // Shade under and between trees: each one darkens the ground around
      // its foot, fading out over a tile and a half (in 4-pixel cells).
      const near = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) if (SHADES.has(blockAt(wx + dx, wy + dy))) near.push([dx * S + 8, dy * S + 11]);
      }
      if (near.length) {
        for (let cy = 0; cy < S; cy += 4) {
          for (let cx = 0; cx < S; cx += 4) {
            let shade = 0;
            for (const [tx, ty] of near) {
              const d = Math.hypot(cx + 2 - tx, (cy + 2 - ty) * 1.25) / S;
              if (d < 1.6) shade += (1.6 - d) * 0.09;
            }
            if (shade > 0.015) {
              ctx.fillStyle = `rgba(6, 22, 12, ${Math.min(0.32, shade).toFixed(2)})`;
              ctx.fillRect(px + cx, py + cy, 4, 4);
            }
          }
        }
      }
      // A warm glow on the ground next to lava.
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        if (blockAt(wx + dx, wy + dy) !== T.LAVA) continue;
        for (let d = 0; d < 6; d += 2) {
          ctx.fillStyle = `rgba(255, 110, 40, ${(0.22 - d * 0.03).toFixed(2)})`;
          if (dy) ctx.fillRect(px, dy < 0 ? py + d : py + S - 2 - d, S, 2);
          else ctx.fillRect(dx < 0 ? px + d : px + S - 2 - d, py, 2, S);
        }
      }
      // A damp bank next to water.
      const wet = (dx, dy) => {
        const nb = blockAt(wx + dx, wy + dy);
        return nb === T.WATER || nb === T.SEA || nb === T.DEEP;
      };
      ctx.fillStyle = 'rgba(30, 40, 20, 0.28)';
      if (wet(0, -1)) ctx.fillRect(px, py, S, 2);
      if (wet(0, 1)) ctx.fillRect(px, py + S - 2, S, 2);
      if (wet(-1, 0)) ctx.fillRect(px, py, 2, S);
      if (wet(1, 0)) ctx.fillRect(px + S - 2, py, 2, S);
    }
  }

  // 4. Cut trees and rocks growing back.
  for (const [i, id, stage] of growth ?? []) {
    const px = (i % CHUNK) * S;
    const py = ((i / CHUNK) | 0) * S;
    if (stage >= 2) ellipse(ctx, px + 9, py + 14, 5, 2, SHADOW);
    ctx.drawImage(growthCanvas(id, stage), px, py);
  }

  // 5. Shadows, then the standing things row by row (crowns reach a tile up
  //    and half a tile to the sides, so neighbours just outside count too).
  const standing = [];
  for (let ly = -1; ly <= CHUNK; ly++) {
    for (let lx = -1; lx <= CHUNK; lx++) {
      const b = blockAt(x0 + lx, y0 + ly);
      if (b && UPRIGHT.has(b)) standing.push([lx, ly, b]);
    }
  }
  for (const [lx, ly, b] of standing) castShadow(ctx, b, lx * S, ly * S);
  for (const [lx, ly, b] of standing) {
    if (ly < 0) continue; // (only its shadow reaches down here)
    const v = variantOf(x0 + lx, y0 + ly);
    const u = upright(b, v, groundAt(x0 + lx, y0 + ly));
    const flip = b === T.TREE && (hashInts(x0 + lx, y0 + ly, 0x1f) & 1);
    if (flip) {
      ctx.save();
      ctx.translate(lx * S + u.ox + u.canvas.width, ly * S + u.oy);
      ctx.scale(-1, 1);
      ctx.drawImage(u.canvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(u.canvas, lx * S + u.ox, ly * S + u.oy);
    }
  }
  return canvas;
}

// --- Per frame: a soft vignette ------------------------------------------------------------

let vignette = null;

/** A cached vignette the size of the view (drawn over the world, under the HUD). */
export function vignetteFor(w, h) {
  if (vignette && vignette.width === w && vignette.height === h) return vignette;
  vignette = createCanvas(w, h);
  const g = ctx2d(vignette);
  const grad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  grad.addColorStop(0, 'rgba(6, 12, 10, 0)');
  grad.addColorStop(1, 'rgba(6, 12, 10, 0.34)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return vignette;
}
