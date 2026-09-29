// Procedural pixel art for the base buildings. Every building has a
// construction plot (not built yet) and three looks that grow with its level:
// tier 1 (levels 1–2), tier 2 (3–4) and tier 3 (5). Sprites are 32×36, drawn
// with an automatic dark outline, anchored bottom-centre on the building's
// world position, and cached.

import { createCanvas, ctx2d } from './canvas.js';

export const BUILDING_W = 32;
export const BUILDING_H = 36;
const GROUND = 33;

const C = {
  outline: '#161622',
  wood: '#9a6a3d', woodDark: '#5b3a21', woodLight: '#c08850',
  stone: '#8d8a9e', stoneDark: '#5d5a6e', stoneLight: '#b8b6c8',
  roof: '#a8323a', roofDark: '#6e1f28', roofBlue: '#3a5aa8', roofBlueDark: '#243a78',
  iron: '#4a4a5a', ironLight: '#7a7a8e', gold: '#e8b84a', goldDark: '#a87a20',
  fire: '#ff8a2a', fireLight: '#ffd060', ember: '#d8401a',
  straw: '#e0c060', strawDark: '#a88a30', cloth: '#d8d0b8', rope: '#c8a878',
  essence: '#7ae0ff', essenceDark: '#3a8ab0', rune: '#cdb2ff', runeDark: '#6b3fc6',
  book: '#b8323a', book2: '#3a78c8', book3: '#5fa84a', paper: '#f4ecd8',
  water: '#3a78c8',
};

class Painter {
  constructor() {
    this.px = Array.from({ length: BUILDING_H }, () => new Array(BUILDING_W).fill(null));
  }
  set(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < BUILDING_W && y < BUILDING_H) this.px[y][x] = c;
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** Rectangle with a light top-left edge and a dark bottom-right edge. */
  box(x, y, w, h, [light, mid, dark]) {
    this.rect(x, y, w, h, mid);
    this.rect(x, y, w, 1, light);
    this.rect(x, y, 1, h, light);
    this.rect(x, y + h - 1, w, 1, dark);
    this.rect(x + w - 1, y, 1, h, dark);
  }
  disc(cx, cy, r, c) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) this.set(cx + x, cy + y, c);
  }
  /** Triangular roof from (x0..x1) with its peak `h` pixels up from `y`. */
  roof(x0, x1, y, h, [c, dark]) {
    for (let j = 0; j < h; j++) {
      const inset = Math.round(((x1 - x0) / 2) * (j / h));
      this.rect(x0 + inset, y - j, x1 - x0 - inset * 2 + 1, 1, j % 3 === 0 ? dark : c);
    }
  }
  outline() {
    const marks = [];
    for (let y = 0; y < BUILDING_H; y++) {
      for (let x = 0; x < BUILDING_W; x++) {
        if (this.px[y][x]) continue;
        const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const v = this.px[y + dy]?.[x + dx];
          return v && v !== C.outline;
        });
        if (n) marks.push([x, y]);
      }
    }
    for (const [x, y] of marks) this.px[y][x] = C.outline;
  }
  toCanvas() {
    const canvas = createCanvas(BUILDING_W, BUILDING_H);
    const ctx = ctx2d(canvas);
    for (let y = 0; y < BUILDING_H; y++) {
      for (let x = 0; x < BUILDING_W; x++) {
        const c = this.px[y][x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    return canvas;
  }
}

const WOOD = [C.woodLight, C.wood, C.woodDark];
const STONE = [C.stoneLight, C.stone, C.stoneDark];
const IRON = [C.ironLight, C.iron, '#2a2a36'];

function campfire(p, cx, big) {
  p.rect(cx - 5, GROUND - 2, 10, 2, C.woodDark);
  p.rect(cx - 4, GROUND - 3, 8, 1, C.wood);
  if (big) for (const dx of [-6, -3, 3, 6]) p.box(cx + dx - 1, GROUND - 2, 2, 2, STONE);
  p.disc(cx, GROUND - 6, 3, C.ember);
  p.disc(cx, GROUND - 7, 2, C.fire);
  p.rect(cx, GROUND - 11, 1, 3, C.fireLight);
  p.set(cx - 1, GROUND - 9, C.fireLight);
  p.set(cx + 1, GROUND - 8, C.fireLight);
}

function banner(p, x, color) {
  p.rect(x, 6, 1, GROUND - 6, C.woodDark);
  p.rect(x + 1, 7, 5, 7, color);
  p.rect(x + 1, 14, 2, 1, color);
  p.rect(x + 4, 14, 2, 1, color);
  p.set(x + 3, 10, C.gold);
}

const DRAW = {
  plot(p) {
    for (const [x, y] of [[5, 22], [26, 22], [5, 32], [26, 32]]) p.rect(x, y - 3, 1, 4, C.woodDark);
    for (let x = 6; x < 26; x++) {
      p.set(x, 20, C.rope);
      p.set(x, 30, C.rope);
    }
    p.rect(15, 20, 2, GROUND - 20, C.wood);
    p.box(10, 13, 12, 8, WOOD);
    // hammer glyph on the sign
    p.rect(13, 15, 5, 2, C.iron);
    p.rect(15, 17, 1, 3, C.woodDark);
  },
  hearth(p, tier) {
    campfire(p, 16, tier >= 2);
    if (tier >= 2) {
      p.box(2, GROUND - 4, 7, 3, WOOD);
      p.box(23, GROUND - 4, 7, 3, WOOD);
    }
    if (tier >= 3) {
      banner(p, 3, '#c8364a');
      banner(p, 24, '#3f6fd8');
      // cooking tripod
      for (let i = 0; i < 9; i++) {
        p.set(12 + i * 0.3, GROUND - 13 + i, C.woodDark);
        p.set(20 - i * 0.3, GROUND - 13 + i, C.woodDark);
      }
    }
  },
  forge(p, tier) {
    if (tier >= 3) {
      p.box(3, 12, 26, GROUND - 12, STONE);
      p.roof(1, 30, 12, 8, [C.roofBlue, C.roofBlueDark]);
      p.box(22, 1, 5, 9, STONE);
      p.box(6, 18, 7, 7, IRON);
      p.rect(7, 19, 5, 5, C.fire);
      p.rect(8, 20, 3, 3, C.fireLight);
      p.rect(3, 12, 26, 1, C.gold);
      p.box(16, 24, 9, GROUND - 24, WOOD);
      return;
    }
    // furnace
    p.box(3, 16, 11, GROUND - 16, STONE);
    p.rect(5, 22, 7, 5, C.ember);
    p.rect(6, 23, 5, 3, C.fire);
    p.rect(7, 24, 3, 1, C.fireLight);
    p.box(6, 9, 5, 7, STONE);
    // anvil on a stump
    p.box(19, GROUND - 5, 6, 5, WOOD);
    p.rect(16, GROUND - 9, 12, 2, C.iron);
    p.rect(18, GROUND - 7, 8, 2, C.iron);
    p.rect(16, GROUND - 9, 12, 1, C.ironLight);
    if (tier >= 2) {
      // shed roof on posts
      p.rect(15, 8, 1, GROUND - 8, C.woodDark);
      p.rect(29, 8, 1, GROUND - 8, C.woodDark);
      p.roof(13, 31, 9, 5, [C.roof, C.roofDark]);
    }
  },
  vault(p, tier) {
    if (tier === 1) {
      p.box(6, 18, 20, 15, WOOD);
      p.rect(6, 23, 20, 2, C.iron);
      p.rect(6, 18, 20, 2, C.woodLight);
      p.box(14, 22, 4, 5, [C.gold, C.gold, C.goldDark]);
      return;
    }
    const walls = tier >= 3 ? STONE : WOOD;
    p.box(3, 13, 26, GROUND - 13, walls);
    p.roof(1, 30, 13, 9, tier >= 3 ? [C.stoneDark, '#44425a'] : [C.roof, C.roofDark]);
    p.box(10, 19, 12, GROUND - 19, tier >= 3 ? IRON : WOOD);
    p.rect(15, 19, 1, GROUND - 19, C.outline);
    p.rect(10, 23, 12, 1, C.iron);
    p.rect(10, 28, 12, 1, C.iron);
    if (tier >= 3) {
      p.disc(16, 8, 2, C.gold);
      p.rect(3, 13, 26, 1, C.gold);
    }
  },
  library(p, tier) {
    if (tier === 1) {
      p.rect(15, 22, 2, GROUND - 22, C.woodDark);
      p.box(9, 17, 14, 5, WOOD);
      p.rect(10, 15, 6, 2, C.paper);
      p.rect(16, 15, 6, 2, C.paper);
      p.rect(16, 15, 1, 2, C.woodDark);
      return;
    }
    if (tier >= 3) {
      p.box(8, 8, 16, GROUND - 8, STONE);
      p.roof(6, 25, 8, 8, [C.roofBlue, C.roofBlueDark]);
      p.disc(16, 15, 3, C.rune);
      p.disc(16, 15, 1, '#ffffff');
      p.box(12, 23, 8, GROUND - 23, WOOD);
      return;
    }
    p.box(3, 14, 26, GROUND - 14, WOOD);
    p.roof(1, 30, 14, 6, [C.roof, C.roofDark]);
    for (let row = 0; row < 3; row++) {
      const y = 17 + row * 5;
      p.rect(5, y + 4, 22, 1, C.woodDark);
      for (let i = 0; i < 10; i++) p.rect(6 + i * 2, y, 1, 4, [C.book, C.book2, C.book3, C.gold][(i + row) % 4]);
    }
  },
  training(p, tier) {
    // straw dummy
    p.rect(15, 18, 2, GROUND - 18, C.woodDark);
    p.rect(9, 20, 14, 2, C.woodDark);
    p.box(12, 17, 8, 10, [C.straw, C.straw, C.strawDark]);
    p.disc(16, 13, 3, C.straw);
    p.rect(14, 12, 1, 1, C.outline);
    p.rect(17, 12, 1, 1, C.outline);
    p.rect(12, 21, 8, 1, C.rope);
    if (tier >= 2) {
      // weapon rack
      p.rect(24, 16, 1, GROUND - 16, C.woodDark);
      p.rect(30, 16, 1, GROUND - 16, C.woodDark);
      p.rect(24, 18, 7, 1, C.wood);
      p.rect(24, 26, 7, 1, C.wood);
      p.rect(26, 12, 1, 18, C.ironLight);
      p.rect(28, 14, 1, 16, C.stoneLight);
    }
    if (tier >= 3) {
      banner(p, 1, '#e8b84a');
      p.disc(6, GROUND - 6, 4, C.cloth);
      p.disc(6, GROUND - 6, 2, '#c8364a');
    }
  },
  well(p, tier) {
    p.box(6, 22, 20, GROUND - 22, STONE);
    p.rect(8, 22, 16, 2, C.essenceDark);
    p.rect(10, 22, 12, 1, C.essence);
    if (tier >= 2) {
      p.rect(7, 8, 1, 14, C.woodDark);
      p.rect(24, 8, 1, 14, C.woodDark);
      p.roof(4, 27, 9, 6, [C.roof, C.roofDark]);
      p.rect(8, 12, 16, 1, C.woodDark);
      p.rect(15, 13, 1, 5, C.rope);
      p.box(13, 17, 5, 4, WOOD);
    } else {
      p.rect(9, 12, 1, 10, C.woodDark);
      p.rect(22, 12, 1, 10, C.woodDark);
      p.rect(9, 12, 14, 1, C.woodDark);
      p.rect(15, 13, 1, 5, C.rope);
      p.box(13, 17, 5, 4, WOOD);
    }
    if (tier >= 3) {
      for (let j = 0; j < 7; j++) p.rect(15 - Math.floor(j / 3), 1 + j, 2 + Math.floor(j / 3) * 2, 1, j % 2 ? C.essence : '#bff4ff');
    }
  },
  waystone(p, tier) {
    if (tier >= 2) {
      p.box(4, 8, 5, GROUND - 8, STONE);
      p.box(23, 8, 5, GROUND - 8, STONE);
      p.box(4, 5, 24, 5, STONE);
      for (let y = 10; y < GROUND; y++) p.rect(9, y, 14, 1, y % 3 === 0 ? C.rune : C.runeDark);
      p.disc(16, 20, 4, C.rune);
      p.disc(16, 20, 2, '#ffffff');
      return;
    }
    p.box(11, 8, 10, GROUND - 8, STONE);
    p.rect(12, 8, 8, 2, C.stoneLight);
    p.rect(15, 13, 2, 8, C.rune);
    p.rect(13, 16, 6, 2, C.rune);
    p.rect(15, 23, 2, 2, C.rune);
  },
};

const cache = new Map();

export function tierForLevel(level) {
  if (level <= 0) return 0;
  if (level <= 2) return 1;
  if (level <= 4) return 2;
  return 3;
}

/** Sprite for a building at a given level (0 = construction plot). */
export function buildingSprite(id, level) {
  const tier = tierForLevel(level);
  const key = `${id}:${tier}`;
  let c = cache.get(key);
  if (!c) {
    const p = new Painter();
    if (tier === 0) DRAW.plot(p);
    else (DRAW[id] ?? DRAW.plot)(p, tier);
    p.outline();
    c = p.toCanvas();
    cache.set(key, c);
  }
  return c;
}
