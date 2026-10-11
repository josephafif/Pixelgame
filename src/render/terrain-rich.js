// The rich terrain style: deeper, softer ground with big light and dark
// patches, a darker forest floor under and between trees, damp banks and
// foam along the water, and the shadows of trees and boulders. The ground is
// drawn once per chunk into its canvas, like the classic style, so it costs
// nothing per frame; the trees and boulders themselves are sprites sorted
// with everyone (trees.js). Only the look changes: tiles, collisions and
// rules are exactly as before.

import { createRng, hashInts } from '../core/rng.js';
import { createCanvas, ctx2d } from './canvas.js';
import { T, CHUNK, LIQUID } from '../game/world.js';
import { tileCanvas, growthCanvas, TILE_PX, GROUND_STYLE } from './tiles-art.js';
import { UPRIGHT, standingSprite, undergrowth } from './trees.js';

const SKY_GROUNDS = new Set([T.SKYBRIDGE, T.WIND_N, T.WIND_E, T.WIND_S, T.WIND_W]);

const S = TILE_PX;
const VARIANTS = 4;

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
  [T.FENMOSS]: { base: '#2e5a4a', tones: ['#285244', '#346454', '#2a5646'], tuft: ['#4a8a6a', '#1e4436'] },
  [T.PEAT]: { base: '#463a30', tones: ['#3e332a', '#504236', '#43372e'], pebbles: ['#5a4a3e'] },
  [T.SKYGRASS]: { base: '#64a456', tones: ['#5c9a50', '#6eb060', '#609e52'], tuft: ['#88c878', '#4a8a40'], flowers: ['#ffffff', '#ffe890'] },
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
const FRAYS = new Set([T.GRASS, T.FLOWERS, T.MOSS, T.ROCKGRASS, T.SAND, T.SAND2, T.SNOW, T.ICE, T.ASH, T.BASALT, T.VOIDSTONE, T.VOIDMOSS, T.PATH, T.PRISMSAND, T.PRISMGLASS, T.FENMOSS, T.PEAT, T.BOG, T.SKYGRASS, T.SKYSTONE]);
/** Grass and its kin count as one ground (they already look alike). */
const FAMILY = { [T.FLOWERS]: T.GRASS, [T.MOSS]: T.GRASS };

/** Pale grounds (shade shows strongly on them). */
const LIGHT = new Set([T.SNOW, T.ICE, T.SAND, T.SAND2, T.PRISMSAND, T.PRISMGLASS]);

/** Grounds that get the big light and dark patches (natural ground, not paving). */
const PATCHY = new Set([T.GRASS, T.FLOWERS, T.MOSS, T.ROCKGRASS, T.SAND, T.SAND2, T.SNOW, T.ASH, T.VOIDMOSS, T.VOIDSTONE, T.BASALT, T.PRISMSAND, T.FENMOSS, T.PEAT, T.BOG, T.SKYGRASS, T.SKYSTONE]);

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

/** Blocks that lie flat (drawn with the ground): liquids and Skyreach's clouds. */
const FLAT_BLOCKS = new Set([...LIQUID, T.SKY]);
/** How far (in tiles) a tile's shading reaches its neighbours. */
const SHADES = new Set([T.TREE, T.PINE, T.PALM, T.ROCK, T.ORE, T.OBSIDIAN, T.ROOTS, T.RUIN]);

/** A pixel ellipse (shadows). */
function ellipse(ctx, cx, cy, rx, ry, color) {
  ctx.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / ((ry + 0.5) * (ry + 0.5)))));
    if (w > 0) ctx.fillRect(cx - w, cy + y, w * 2, 1);
  }
}

const SHADOW = 'rgba(8, 20, 12, 0.3)';
const SHADOW_SOFT = 'rgba(8, 20, 12, 0.16)';

/** A standing thing's shadow on the ground (the thing itself is a sprite: trees.js). */
function castShadow(ctx, shadow, px, py) {
  if (!shadow) return;
  const [dx, dy, rx, ry] = shadow;
  ellipse(ctx, px + dx + 2, py + dy, rx + 3, ry + 1, SHADOW_SOFT);
  ellipse(ctx, px + dx + 1, py + dy, rx, ry, SHADOW);
}

// --- The chunk -----------------------------------------------------------------------------

/** The biome of a tile, from its chunk when it is loaded (the same as the sprite pass uses). */
export function biomeIdAt(world, wx, wy) {
  const cx = Math.floor(wx / CHUNK);
  const cy = Math.floor(wy / CHUNK);
  const chunk = world.chunks?.get(`${cx},${cy}`);
  if (chunk?.biomeIdx) return world.biomes[chunk.biomeIdx[(wy - cy * CHUNK) * CHUNK + (wx - cx * CHUNK)]]?.id;
  return world.biomeAt(wx, wy)?.id;
}

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
      if (b && FLAT_BLOCKS.has(b)) ctx.drawImage(tileCanvas(b, v, true), lx * S, ly * S);
    }
  }

  // 1b. Where two kinds of ground meet, the edge frays: a few pixels of the
  //     neighbour's colour scattered over the border.
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = ly * CHUNK + lx;
      const g = chunk.ground[i];
      if (!FRAYS.has(g) || FLAT_BLOCKS.has(chunk.block[i])) continue;
      const wx = x0 + lx;
      const wy = y0 + ly;
      const fam = FAMILY[g] ?? g;
      const rng = createRng(hashInts(wx, wy, 0xf4a7));
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const ng = groundAt(wx + dx, wy + dy);
        if (!FRAYS.has(ng) || (FAMILY[ng] ?? ng) === fam || FLAT_BLOCKS.has(blockAt(wx + dx, wy + dy))) continue;
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
      if (!PATCHY.has(chunk.ground[i]) || FLAT_BLOCKS.has(chunk.block[i])) continue;
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

  // 2b. Mireglass Fen: drifting mist over the bog, and the soft light of the lumen caps.
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = ly * CHUNK + lx;
      const g = chunk.ground[i];
      if (g !== T.FENMOSS && g !== T.PEAT && g !== T.BOG && chunk.block[i] !== T.FENWATER) continue;
      const wx = x0 + lx;
      const wy = y0 + ly;
      const m = vnoise(seed ^ 0x3157, wx / 4, wy / 4);
      if (m > 0.62) {
        ctx.fillStyle = `rgba(210, 240, 232, ${((m - 0.62) * 0.35).toFixed(3)})`;
        ctx.fillRect(lx * S, ly * S, S, S);
      }
      if (chunk.block[i] === T.LUMENCAP) {
        for (const [rr, a] of [[11, 0.07], [7, 0.1]]) {
          ctx.fillStyle = `rgba(120, 255, 200, ${a})`;
          ellipse(ctx, lx * S + 8, ly * S + 9, rr, Math.round(rr * 0.6), ctx.fillStyle);
        }
      }
    }
  }

  // 2c. Undergrowth: bushes, ferns, grass, moss and mushrooms (more of it on a forest floor).
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = ly * CHUNK + lx;
      if (chunk.block[i]) continue;
      const wx = x0 + lx;
      const wy = y0 + ly;
      if (wx * wx + wy * wy < 14 * 14) continue; // (the camp's square stays tidy)
      let near = 0;
      let wet = false;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nb = blockAt(wx + dx, wy + dy);
          if (nb === T.TREE || nb === T.PINE || nb === T.ROOTS) near++;
          else if (Math.abs(dx) + Math.abs(dy) === 1 && nb && LIQUID.has(nb)) wet = true;
        }
      }
      const d = undergrowth(wx, wy, chunk.ground[i], near, wet);
      if (d) ctx.drawImage(d.canvas, lx * S + d.ox, ly * S + d.oy);
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
      if (b === T.SKY) {
        // A floating island's edge: its rock face hangs into the clouds below
        // it, with a shadow under the face.
        const up = blockAt(wx, wy - 1);
        if (up !== T.SKY && !SKY_GROUNDS.has(groundAt(wx, wy - 1))) {
          ctx.fillStyle = '#7a7e8a';
          ctx.fillRect(px, py, S, 5);
          ctx.fillStyle = '#5c606c';
          for (let x = 0; x < S; x += 2) ctx.fillRect(px + x, py + 5, 2, 1 + ((x * 7 + wx) % 3));
          ctx.fillStyle = '#9a9eaa';
          ctx.fillRect(px, py, S, 1);
          ctx.fillStyle = 'rgba(40, 60, 90, 0.18)';
          ctx.fillRect(px, py + 7, S, 5);
        }
        continue;
      }
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
        const fen = b === T.FENWATER;
        ctx.fillStyle = fen ? 'rgba(110, 190, 160, 0.3)' : 'rgba(150, 210, 240, 0.35)';
        if (land(0, -1)) ctx.fillRect(px, py, S, 3);
        if (land(0, 1)) ctx.fillRect(px, py + S - 2, S, 2);
        if (land(-1, 0)) ctx.fillRect(px, py, 2, S);
        if (land(1, 0)) ctx.fillRect(px + S - 2, py, 2, S);
        ctx.fillStyle = fen ? 'rgba(200, 240, 220, 0.55)' : 'rgba(235, 248, 255, 0.75)';
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
        return nb === T.WATER || nb === T.SEA || nb === T.DEEP || nb === T.FENWATER;
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

  // 5. The shadows of the trees, rocks and the rest (they stand as sprites
  //    of their own, sorted with everyone: trees.js; a shadow may reach in
  //    from just outside the chunk).
  for (let ly = -1; ly <= CHUNK; ly++) {
    for (let lx = -1; lx <= CHUNK; lx++) {
      const wx = x0 + lx;
      const wy = y0 + ly;
      const b = blockAt(wx, wy);
      if (!b || !UPRIGHT.has(b)) continue;
      const sp = standingSprite(b, wx, wy, groundAt(wx, wy), biomeIdAt(world, wx, wy), 'rich');
      castShadow(ctx, sp.shadow, lx * S, ly * S);
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
