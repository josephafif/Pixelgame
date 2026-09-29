// Pixel art for camp structures, drawn procedurally like the rest of the
// game. Solid structures are 16×24 sprites standing on their tile (the top
// 8 px rise above it); floors and traps are flat 16×16 tiles. Walls join
// up with their neighbours (the mask says which sides are connected).

import { createCanvas, ctx2d } from './canvas.js';

const O = '#161622';
export const STRUCT_W = 16;
export const STRUCT_H = 24;

// Neighbour mask bits.
export const LEFT = 1;
export const RIGHT = 2;
export const UP = 4;
export const DOWN = 8;

const cache = new Map();

function rect(g, x, y, w, h, c) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

function woodWall(g, mask) {
  const logs = [[0, 5], [5, 6], [11, 5]];
  logs.forEach(([x, w], i) => {
    const top = 3 + (i % 2);
    rect(g, x, top + 2, w, 22 - top - 2, '#9a6a3c');
    rect(g, x, top + 2, 1, 22 - top - 2, '#c8945a');
    rect(g, x + w - 1, top + 2, 1, 22 - top - 2, '#6b4a2a');
    // Pointed tip.
    rect(g, x + 1, top + 1, w - 2, 1, '#9a6a3c');
    rect(g, x + (w >> 1), top, 1, 1, '#c8945a');
    // Outline between logs.
    if (i > 0 || !(mask & LEFT)) rect(g, x, top + 1, 1, 21 - top, O);
  });
  if (!(mask & RIGHT)) rect(g, 15, 4, 1, 18, O);
  // Rope bindings.
  rect(g, 0, 9, 16, 2, '#4a3220');
  rect(g, 0, 17, 16, 2, '#4a3220');
  rect(g, 0, 9, 16, 1, '#6b4a2a');
  rect(g, 0, 22, 16, 2, O);
  // Tips outline.
  g.fillStyle = O;
  for (const [x, w] of logs) g.fillRect(x + (w >> 1), 2 + (x === 5 ? 1 : 0), 1, 1);
}

function stoneWall(g, mask) {
  const top = mask & UP ? 6 : 6;
  // Merlons.
  for (const mx of [1, 10]) {
    rect(g, mx, 2, 5, 5, '#a4a8b8');
    rect(g, mx, 2, 5, 1, '#d0d4e0');
    rect(g, mx - 1, 1, 7, 1, O);
    rect(g, mx - 1, 1, 1, 6, O);
    rect(g, mx + 5, 1, 1, 6, O);
  }
  rect(g, 0, top, 16, 3, '#c0c4d0');
  rect(g, 0, top + 3, 16, 14, '#8d8a9e');
  // Brick courses.
  g.fillStyle = '#6e6b80';
  for (let row = 0; row < 4; row++) {
    const y = top + 3 + row * 4;
    g.fillRect(0, y, 16, 1);
    const off = row % 2 ? 4 : 0;
    for (let x = off; x < 16; x += 8) g.fillRect(x, y, 1, 4);
  }
  rect(g, 0, 21, 16, 1, '#5d5a6e');
  rect(g, 0, 22, 16, 2, O);
  rect(g, 0, top - 1, 16, 1, O);
  if (!(mask & LEFT)) rect(g, 0, top - 1, 1, 24 - top, O);
  if (!(mask & RIGHT)) rect(g, 15, top - 1, 1, 24 - top, O);
}

function gate(g, mask, open) {
  // Posts.
  for (const x of [0, 13]) {
    rect(g, x, 2, 3, 21, '#6b4a2a');
    rect(g, x, 2, 1, 21, '#8a5a33');
    rect(g, x, 1, 3, 1, O);
    rect(g, x + 3, 2, 1, 21, O);
    rect(g, x - 1 < 0 ? 0 : x - 1, 2, 1, 21, O);
  }
  rect(g, 3, 3, 10, 2, '#4a3220');
  rect(g, 3, 2, 10, 1, O);
  if (open) {
    rect(g, 3, 5, 10, 17, '#2a1c10');
    rect(g, 3, 5, 2, 17, '#9a6a3c');
    rect(g, 5, 5, 1, 17, O);
  } else {
    for (let x = 3; x < 13; x += 3) {
      rect(g, x, 5, 3, 17, '#9a6a3c');
      rect(g, x, 5, 1, 17, '#c8945a');
      rect(g, x + 2, 5, 1, 17, '#6b4a2a');
    }
    rect(g, 3, 9, 10, 1, '#4a3220');
    rect(g, 3, 17, 10, 1, '#4a3220');
    rect(g, 7, 13, 2, 2, '#e0b040');
  }
  rect(g, 0, 22, 16, 2, O);
}

function turretBase(g, flame) {
  rect(g, 3, 11, 10, 11, '#8d8a9e');
  rect(g, 3, 11, 10, 2, '#b8bcc8');
  g.fillStyle = '#6e6b80';
  g.fillRect(3, 15, 10, 1);
  g.fillRect(3, 19, 10, 1);
  g.fillRect(7, 13, 1, 2);
  g.fillRect(9, 16, 1, 3);
  rect(g, 2, 10, 1, 12, O);
  rect(g, 13, 10, 1, 12, O);
  rect(g, 2, 22, 12, 2, O);
  if (flame) {
    rect(g, 1, 7, 14, 4, '#3a3640');
    rect(g, 2, 8, 12, 1, '#ff7a2a');
    rect(g, 0, 6, 16, 1, O);
    rect(g, 0, 7, 1, 4, O);
    rect(g, 15, 7, 1, 4, O);
    rect(g, 1, 11, 14, 1, O);
  } else {
    rect(g, 1, 8, 14, 3, '#9a6a3c');
    rect(g, 1, 8, 14, 1, '#c8945a');
    rect(g, 0, 7, 16, 1, O);
    rect(g, 0, 8, 1, 3, O);
    rect(g, 15, 8, 1, 3, O);
    rect(g, 1, 11, 14, 1, O);
  }
}

function torch(g) {
  rect(g, 7, 9, 2, 13, '#8a5a33');
  rect(g, 7, 9, 1, 13, '#b07a48');
  rect(g, 6, 8, 4, 2, '#4a4450');
  rect(g, 5, 7, 6, 1, O);
  rect(g, 6, 9, 1, 13, O);
  rect(g, 9, 9, 1, 13, O);
  rect(g, 6, 22, 4, 2, O);
}

function banner(g) {
  rect(g, 2, 1, 2, 22, '#8a5a33');
  rect(g, 2, 1, 1, 22, '#b07a48');
  rect(g, 1, 0, 4, 1, '#e0b040');
  rect(g, 4, 2, 10, 13, '#3f6fd8');
  rect(g, 4, 2, 10, 2, '#5f8ff0');
  // Notched bottom.
  rect(g, 4, 15, 4, 2, '#3f6fd8');
  rect(g, 10, 15, 4, 2, '#3f6fd8');
  // Gold emblem (a tiny crossed sword).
  rect(g, 8, 5, 2, 7, '#ffd24a');
  rect(g, 6, 9, 6, 1, '#ffd24a');
  g.fillStyle = O;
  g.fillRect(14, 2, 1, 15);
  g.fillRect(4, 1, 10, 1);
  g.fillRect(8, 15, 2, 1);
  g.fillRect(1, 22, 4, 2);
}

/** Market stall: a counter with goods under a striped awning. */
function stall(g, tint = '#c8364a') {
  // Posts.
  rect(g, 1, 4, 2, 18, '#6b4a2a');
  rect(g, 13, 4, 2, 18, '#6b4a2a');
  // Awning with stripes and a scalloped edge.
  for (let x = 0; x < 16; x++) {
    const c = Math.floor(x / 3) % 2 ? '#f3ecdc' : tint;
    rect(g, x, 2, 1, 6, c);
    if (x % 3 === 1) rect(g, x, 8, 1, 1, c);
  }
  rect(g, 0, 1, 16, 1, O);
  rect(g, 0, 8, 16, 1, 'rgba(0,0,0,0.25)');
  // Counter and goods.
  rect(g, 0, 14, 16, 8, '#9a6a3c');
  rect(g, 0, 14, 16, 1, '#c8945a');
  rect(g, 0, 18, 16, 1, '#6b4a2a');
  rect(g, 2, 11, 3, 3, '#e8364a');
  rect(g, 6, 12, 3, 2, '#ffd24a');
  rect(g, 10, 11, 3, 3, '#7ae0ff');
  rect(g, 0, 22, 16, 2, O);
  rect(g, 0, 14, 1, 8, O);
  rect(g, 15, 14, 1, 8, O);
}

function crate(g) {
  rect(g, 2, 10, 12, 12, '#b07a48');
  rect(g, 2, 10, 12, 2, '#d8a870');
  rect(g, 2, 15, 12, 1, '#7a4a28');
  rect(g, 7, 12, 2, 10, '#7a4a28');
  rect(g, 1, 9, 14, 1, O);
  rect(g, 1, 10, 1, 12, O);
  rect(g, 14, 10, 1, 12, O);
  rect(g, 1, 22, 14, 2, O);
}

function woodFloor(g) {
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    rect(g, 0, y, 16, 4, row % 2 ? '#8a5a33' : '#9a6a3c');
    rect(g, 0, y, 16, 1, row % 2 ? '#9a6a3c' : '#b07a48');
    rect(g, 0, y + 3, 16, 1, '#6b4a2a');
    const seam = row % 2 ? 11 : 5;
    rect(g, seam, y, 1, 4, '#6b4a2a');
  }
}

function stoneFloor(g) {
  rect(g, 0, 0, 16, 16, '#6e6b80');
  const stones = [[0, 0, 7, 5], [8, 0, 8, 6], [0, 6, 5, 5], [6, 7, 6, 4], [13, 7, 3, 5], [0, 12, 8, 4], [9, 12, 7, 4]];
  for (const [x, y, w, h] of stones) {
    rect(g, x + 1, y + 1, w - 1, h - 1, '#a4a8b8');
    rect(g, x + 1, y + 1, w - 1, 1, '#c0c4d0');
  }
}

function spikes(g, up) {
  rect(g, 1, 1, 14, 14, '#4a4450');
  rect(g, 1, 1, 14, 1, '#5d5a6e');
  rect(g, 0, 0, 16, 1, O);
  rect(g, 0, 15, 16, 1, O);
  rect(g, 0, 0, 1, 16, O);
  rect(g, 15, 0, 1, 16, O);
  for (const [x, y] of [[3, 3], [9, 3], [6, 8], [3, 12], [11, 11]]) {
    if (up) {
      rect(g, x, y - 1, 1, 3, '#e8ecf4');
      rect(g, x + 1, y, 1, 2, '#a4a8b8');
      rect(g, x - 1, y + 1, 1, 1, '#a4a8b8');
    } else {
      rect(g, x, y, 2, 2, O);
    }
  }
}

/** 16×24 sprite (or 16×16 for flat kinds) for a structure. */
export function structureSprite(id, mask = 0, state = 0, tint = null) {
  const key = `${id}:${mask}:${state}:${tint ?? ''}`;
  let c = cache.get(key);
  if (c) return c;
  const flat = id === 'wood_floor' || id === 'stone_floor' || id === 'spikes';
  c = createCanvas(STRUCT_W, flat ? 16 : STRUCT_H);
  const g = ctx2d(c);
  switch (id) {
    case 'wood_wall': woodWall(g, mask); break;
    case 'stone_wall': stoneWall(g, mask); break;
    case 'gate': gate(g, mask, state); break;
    case 'arrow_turret': turretBase(g, false); break;
    case 'flame_turret': turretBase(g, true); break;
    case 'torch': torch(g); break;
    case 'banner': banner(g); break;
    case 'wood_floor': woodFloor(g); break;
    case 'stone_floor': stoneFloor(g); break;
    case 'spikes': spikes(g, state); break;
    case 'stall': stall(g, tint ?? undefined); break;
    case 'crate': crate(g); break;
    default: rect(g, 2, 8, 12, 14, '#8d8a9e');
  }
  cache.set(key, c);
  return c;
}

export function isFlat(id) {
  return id === 'wood_floor' || id === 'stone_floor' || id === 'spikes';
}

/** Draws a flickering flame centred at (x, y) (bottom of the flame). */
export function drawFlame(g, x, y, t, size = 1) {
  const f = Math.sin(t * 17) > 0 ? 1 : 0;
  const s = size;
  g.fillStyle = '#ff4a1a';
  g.fillRect(x - 2 * s, y - 3 * s, 4 * s, 3 * s);
  g.fillStyle = '#ff9a2a';
  g.fillRect(x - s, y - (4 + f) * s, 2 * s, (4 + f) * s);
  g.fillStyle = '#ffe890';
  g.fillRect(x - Math.max(1, s >> 1), y - 2 * s, Math.max(1, s), 2 * s);
}

/** Crossbow head for arrow turrets, rotated to `angle`, centred at (x, y). */
export function drawTurretHead(g, x, y, angle, recoil) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.translate(-recoil, 0);
  g.fillStyle = O;
  g.fillRect(-4, -2, 10, 4);
  g.fillRect(1, -5, 3, 10);
  g.fillStyle = '#8a5a33';
  g.fillRect(-3, -1, 8, 2);
  g.fillStyle = '#c8945a';
  g.fillRect(2, -4, 1, 8);
  g.fillStyle = '#e8ecf4';
  g.fillRect(5, -1, 2, 1);
  g.restore();
}

/** Static icon (build menu): the sprite with its moving parts drawn in. */
export function structureIcon(id) {
  const key = `icon:${id}`;
  let c = cache.get(key);
  if (c) return c;
  const base = structureSprite(id, 0, id === 'spikes' ? 1 : 0);
  c = createCanvas(STRUCT_W, STRUCT_H);
  const g = ctx2d(c);
  g.drawImage(base, 0, isFlat(id) ? 6 : 0);
  if (id === 'arrow_turret') drawTurretHead(g, 8, 8, -Math.PI / 4, 0);
  if (id === 'flame_turret') drawFlame(g, 8, 8, 0, 2);
  if (id === 'torch') drawFlame(g, 8, 7, 0, 1);
  cache.set(key, c);
  return c;
}

/** Small pickaxe sprite (tool swings), head coloured by tier. */
export function pickaxeSprite(color) {
  const key = `pickaxe:${color}`;
  let c = cache.get(key);
  if (c) return c;
  c = createCanvas(12, 14);
  const g = ctx2d(c);
  // Handle (points down from the head).
  rect(g, 5, 3, 2, 11, O);
  rect(g, 6, 4, 1, 9, '#b07a48');
  // Head.
  rect(g, 0, 0, 12, 4, O);
  rect(g, 1, 1, 10, 2, color);
  rect(g, 1, 1, 10, 1, '#ffffff');
  rect(g, 0, 3, 2, 2, O);
  rect(g, 10, 3, 2, 2, O);
  cache.set(key, c);
  return c;
}
