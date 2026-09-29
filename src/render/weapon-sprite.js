// Turns a weapon's visual DNA into pixel art. Each archetype template draws
// into a 16×32 grid (tip up, grip at the bottom); an automatic outline pass
// keeps every weapon readable on small screens, and elemental weapons get
// a glowing outline instead of a dark one.

import { createCanvas, ctx2d } from './canvas.js';
import { shadeHex } from '../weapons/visuals.js';

export const GRID_W = 16;
export const GRID_H = 32;

class Grid {
  constructor() {
    this.px = Array.from({ length: GRID_H }, () => new Array(GRID_W).fill(null));
  }
  set(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H && c) this.px[y][x] = c;
  }
  get(x, y) {
    return x >= 0 && x < GRID_W && y >= 0 && y < GRID_H ? this.px[y][x] : null;
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  disc(cx, cy, r, c) {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) this.set(cx + x, cy + y, c);
    }
  }
  ring(cx, cy, r, c) {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d <= r * r + r * 0.6 && d >= (r - 1) * (r - 1) - 0.5) this.set(cx + x, cy + y, c);
      }
    }
  }
}

/** Handle from the bottom up; returns the y of the topmost handle pixel. */
function handle(g, pal, length, width = 2) {
  const left = 8 - Math.ceil(width / 2);
  for (let i = 0; i < length; i++) {
    const y = 30 - i;
    for (let x = 0; x < width; x++) g.set(left + x, y, i % 2 ? pal.handle[1] : pal.handle[0]);
  }
  g.set(7, 30, pal.accent);
  g.set(8, 30, pal.accent);
  return 30 - length + 1;
}

const TEMPLATES = {
  blade(g, v, pal) {
    const { length: L, width: W, guard: G, handle: H } = v.dims;
    const top = handle(g, pal, H + 1);
    const guardY = top - 1;
    const gl = 8 - Math.ceil(G / 2);
    g.rect(gl, guardY, G, 1, pal.accent);
    if (G >= 7) g.rect(gl + 1, guardY - 1, G - 2, 1, shadeHex(pal.accent, -0.2));
    const bladeBottom = guardY - (G >= 7 ? 2 : 1);
    const left = 8 - Math.ceil(W / 2);
    const tipRows = v.choices.tip === 'round' ? 1 : Math.ceil(W / 2);
    for (let i = 0; i < L; i++) {
      const y = bladeBottom - i;
      let l = left;
      let r = left + W - 1;
      const fromTip = L - 1 - i;
      if (fromTip < tipRows) {
        if (v.choices.tip === 'clip') r -= tipRows - fromTip;
        else if (v.choices.tip === 'curved') { l += tipRows - fromTip; r += 1; }
        else { l += Math.ceil((tipRows - fromTip) / 2); r -= Math.floor((tipRows - fromTip) / 2); }
      }
      if (v.choices.tip === 'curved' && i > L * 0.6) { l += 1; r += 1; }
      if (v.edge === 'serrated' && i % 3 === 1 && fromTip >= tipRows) r -= 1;
      if (v.edge === 'jagged' && i % 4 === 2) { l -= 1; }
      for (let x = l; x <= r; x++) {
        const shade = x === l ? pal.blade[0] : x === r ? pal.blade[2] : pal.blade[1];
        g.set(x, y, shade);
      }
      if (v.edge === 'crystal' && (i + v.variant) % 5 === 0) g.set(r + 1, y, pal.blade[0]);
      if (v.choices.fuller && W >= 3 && i > 0 && i < L * 0.65) {
        g.set(left + Math.floor(W / 2), y, v.runes && i % 3 === 0 ? pal.glow ?? pal.accent : pal.blade[2]);
      }
    }
    if (pal.gem) g.set(8, guardY, pal.gem);
    return { gripY: 30 - H / 2 };
  },
  axe(g, v, pal) {
    const top = handle(g, pal, v.dims.handle);
    const S = v.dims.head;
    const drawHead = (dir) => {
      for (let j = 0; j < 2 * S - 1; j++) {
        const span = S - Math.floor(Math.abs(j - (S - 1)) / 2);
        for (let k = 0; k < span; k++) {
          const x = dir > 0 ? 9 + k : 6 - k;
          const edge = k === span - 1;
          g.set(x, top + j, edge ? pal.blade[0] : k === 0 ? pal.blade[2] : pal.blade[1]);
        }
      }
    };
    drawHead(1);
    if (v.choices.double) drawHead(-1);
    g.set(7, top - 1, pal.blade[1]);
    g.set(8, top - 1, pal.blade[1]);
    if (pal.gem) g.set(8, top + S - 1, pal.gem);
    return { gripY: 26 };
  },
  hammer(g, v, pal) {
    const top = handle(g, pal, v.dims.handle);
    const { headW: W, headH: Hh } = v.dims;
    const left = 8 - Math.ceil(W / 2);
    for (let j = 0; j < Hh; j++) {
      for (let i = 0; i < W; i++) {
        g.set(left + i, top - Hh + j, j === 0 ? pal.blade[0] : j === Hh - 1 ? pal.blade[2] : pal.blade[1]);
      }
    }
    if (v.choices.spike) g.rect(7, top - Hh - 2, 2, 2, pal.blade[0]);
    if (pal.gem) g.set(8, top - Math.ceil(Hh / 2), pal.gem);
    return { gripY: 26 };
  },
  mace(g, v, pal) {
    const top = handle(g, pal, v.dims.handle);
    const r = Math.ceil(v.dims.head / 2);
    const cy = top - r;
    g.disc(8, cy, r, pal.blade[1]);
    g.set(7, cy - 1, pal.blade[0]);
    g.set(9, cy + 1, pal.blade[2]);
    if (v.choices.spikes) {
      for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1], [1, -1], [-1, -1]]) {
        g.set(8 + dx * (r + 1), cy + dy * (r + 1), pal.blade[0]);
      }
    }
    if (pal.gem) g.set(8, cy, pal.gem);
    return { gripY: 27 };
  },
  polearm(g, v, pal) {
    const top = handle(g, pal, v.dims.handle, 1);
    const tl = v.dims.tipLength;
    for (let i = 0; i < tl; i++) {
      const half = i < tl - 2 ? 1 : 0;
      for (let x = 8 - half; x <= 8 + half; x++) g.set(x, top - 1 - i, x < 8 ? pal.blade[0] : x > 8 ? pal.blade[2] : pal.blade[1]);
    }
    g.rect(6, top, 5, 1, pal.accent);
    if (v.choices.tassel) {
      g.set(6, top + 1, pal.glow ?? pal.accent);
      g.set(6, top + 2, pal.glow ?? pal.accent);
      g.set(5, top + 3, pal.glow ?? pal.accent);
    }
    return { gripY: 24 };
  },
  scythe(g, v, pal) {
    const top = handle(g, pal, v.dims.handle, 1);
    const b = v.dims.blade;
    for (let i = 0; i < b; i++) {
      const x = 8 - i;
      const y = top + Math.floor((i * i) / (b * 1.6));
      g.set(x, y, pal.blade[0]);
      g.set(x, y + 1, pal.blade[1]);
      if (i < b - 2) g.set(x, y + 2, pal.blade[2]);
    }
    if (v.choices.hook) g.set(8 - b, top + Math.floor((b * b) / (b * 1.6)) + 2, pal.blade[0]);
    g.rect(8, top - 1, 1, 2, pal.accent);
    return { gripY: 24 };
  },
  bow(g, v, pal) {
    const h = v.dims.height;
    const c = v.dims.curve;
    const y0 = 16 - Math.floor(h / 2);
    for (let i = 0; i <= h; i++) {
      const t = (i - h / 2) / (h / 2);
      const x = 9 - Math.round(c * (1 - t * t));
      g.set(x, y0 + i, i % 5 === 0 ? pal.handle[1] : pal.blade[1]);
      g.set(x + 1, y0 + i, pal.blade[2]);
    }
    if (v.choices.recurve) {
      g.set(10, y0 - 1, pal.blade[1]);
      g.set(10, y0 + h + 1, pal.blade[1]);
    }
    for (let i = 0; i <= h; i++) g.set(10, y0 + i, '#e8e8e8');
    g.rect(9 - c, 15, 2, 3, pal.handle[0]);
    if (pal.gem) g.set(9 - c, 16, pal.gem);
    return { gripY: 16 };
  },
  crossbow(g, v, pal) {
    const s = v.dims.stock;
    const top = 31 - s;
    g.rect(7, top, 2, s - 1, pal.handle[0]);
    g.rect(8, top, 1, s - 1, pal.handle[1]);
    const a = v.dims.arms;
    const ay = top + 3;
    const left = 8 - Math.ceil(a / 2);
    for (let i = 0; i < a; i++) {
      const bend = Math.abs(i - a / 2) > a / 3 ? 1 : 0;
      g.set(left + i, ay + bend, pal.blade[1]);
    }
    for (let i = 0; i < 5; i++) {
      g.set(left + Math.floor(i / 2), ay + 1 + i, '#e8e8e8');
      g.set(left + a - 1 - Math.floor(i / 2), ay + 1 + i, '#e8e8e8');
    }
    g.rect(7, top - 3, 2, 3, pal.blade[0]);
    if (v.choices.scope) g.rect(9, top + 6, 2, 3, pal.accent);
    return { gripY: 26 };
  },
  gun(g, v, pal) {
    const b = v.dims.barrel;
    const top = 22 - b;
    g.rect(7, top, 2, b, pal.blade[1]);
    g.rect(7, top, 1, b, pal.blade[0]);
    g.rect(6, 22, 4, 3, pal.blade[2]);
    const grip = v.dims.grip;
    g.rect(7, 25, 3, grip, pal.handle[0]);
    g.rect(9, 25, 1, grip, pal.handle[1]);
    if (v.choices.drum) g.disc(7, 20, 2, pal.accent);
    if (pal.gem) g.set(8, top + 1, pal.gem);
    return { gripY: 27 };
  },
  cannon(g, v, pal) {
    const len = v.dims.barrel;
    const bore = v.dims.bore;
    const top = 28 - len;
    g.rect(8 - bore, top, bore * 2, len, pal.blade[1]);
    g.rect(8 - bore, top, 1, len, pal.blade[0]);
    g.rect(8 + bore - 1, top, 1, len, pal.blade[2]);
    g.rect(8 - bore + 1, top, bore * 2 - 2, 1, '#161622');
    if (v.choices.bands) {
      g.rect(8 - bore, top + 2, bore * 2, 1, pal.accent);
      g.rect(8 - bore, top + len - 3, bore * 2, 1, pal.accent);
    }
    g.rect(6, 28, 4, 3, pal.handle[0]);
    return { gripY: 27 };
  },
  wand(g, v, pal) {
    const len = v.dims.length;
    const top = 31 - len;
    for (let i = 0; i < len; i++) g.set(8, 30 - i, i % 3 ? pal.handle[0] : pal.handle[1]);
    const gem = pal.gem ?? pal.glow ?? pal.accent;
    g.disc(8, top - v.dims.gem, v.dims.gem - 1, gem);
    g.set(8, top - v.dims.gem - 1, shadeHex(gem, 0.5));
    if (v.choices.star) {
      const cy = top - v.dims.gem;
      for (const [dx, dy] of [[0, -3], [3, 0], [-3, 0]]) g.set(8 + dx, cy + dy, pal.blade[0]);
    }
    return { gripY: 27 };
  },
  staff(g, v, pal) {
    const top = handle(g, pal, v.dims.length, 1);
    const r = Math.ceil(v.dims.head / 2);
    const orb = pal.gem ?? pal.glow ?? pal.accent;
    if (v.choices.headType === 'crook') {
      for (let i = 0; i < 5; i++) g.set(8 + (i < 3 ? i : 2), top - 1 - (i < 3 ? 0 : i - 2), pal.handle[0]);
      g.set(10, top + 1, pal.handle[0]);
      g.disc(9, top - 3, 1, orb);
    } else if (v.choices.headType === 'crystal') {
      for (let i = 0; i < r * 2 + 2; i++) {
        const half = i < r + 1 ? Math.floor(i / 2) : Math.floor((r * 2 + 2 - i) / 2);
        for (let x = -half; x <= half; x++) g.set(8 + x, top - 1 - i, x < 0 ? shadeHex(orb, 0.4) : orb);
      }
    } else {
      g.ring(8, top - r - 1, r + 1, pal.blade[1]);
      g.disc(8, top - r - 1, r - 1, orb);
      g.set(7, top - r - 2, shadeHex(orb, 0.6));
    }
    return { gripY: 22 };
  },
  orb(g, v, pal) {
    const r = Math.floor(v.dims.size / 2);
    const core = pal.gem ?? pal.glow ?? pal.blade[1];
    g.disc(8, 16, r, pal.blade[1]);
    g.disc(8, 16, r - 2, core);
    g.set(8 - Math.floor(r / 2), 16 - Math.floor(r / 2), '#ffffff');
    if (v.choices.rings) {
      for (let x = -r - 2; x <= r + 2; x++) g.set(8 + x, 16 + Math.round(x / 3), pal.accent);
    }
    return { gripY: 16 };
  },
  boomerang(g, v, pal) {
    const arm = v.dims.arm;
    const w = v.dims.width;
    for (let i = 0; i < arm; i++) {
      for (let k = 0; k < w; k++) {
        g.set(8 - i + k, 22 - i, k === 0 ? pal.blade[0] : pal.blade[1]);
        g.set(8 + i - k, 22 - i, k === 0 ? pal.blade[2] : pal.blade[1]);
      }
    }
    if (v.choices.hooked) {
      g.set(8 - arm, 22 - arm + 1, pal.blade[0]);
      g.set(8 + arm, 22 - arm + 1, pal.blade[2]);
    }
    if (pal.gem) g.set(8, 21, pal.gem);
    return { gripY: 20 };
  },
  chakram(g, v, pal) {
    const r = Math.floor(v.dims.size / 2);
    g.ring(8, 16, r, pal.blade[1]);
    g.ring(8, 16, r - 1, pal.blade[0]);
    if (v.choices.spikes) {
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) g.set(8 + dx * (r + 1), 16 + dy * (r + 1), pal.blade[0]);
    }
    g.rect(7, 15, 2, 2, pal.handle[0]);
    return { gripY: 16 };
  },
  whip(g, v, pal) {
    handle(g, pal, v.dims.handle);
    const coils = v.dims.coils;
    for (let i = 0; i < coils; i++) g.ring(8 + (i % 2 ? 1 : -1), 22 - v.dims.handle - i * 4, 2, i % 2 ? pal.blade[1] : pal.blade[2]);
    if (v.choices.barbed) g.set(9, 22 - v.dims.handle - coils * 4, pal.blade[0]);
    return { gripY: 28 };
  },
  knives(g, v, pal) {
    const len = v.dims.length;
    for (const [dx, dy] of [[-4, 3], [0, 0], [4, 3]]) {
      const x = 8 + dx;
      const base = 26 + dy;
      g.rect(x, base, 1, 3, pal.handle[0]);
      for (let i = 0; i < len; i++) {
        const cx = v.choices.curved && i > len / 2 ? x + 1 : x;
        g.set(cx, base - 1 - i, i === len - 1 ? pal.blade[0] : pal.blade[1]);
        if (i < len - 2) g.set(cx + 1, base - 1 - i, pal.blade[2]);
      }
    }
    return { gripY: 27 };
  },
  lantern(g, v, pal) {
    const chain = v.dims.chain;
    for (let i = 0; i < chain; i++) g.set(8, 4 + i, i % 2 ? pal.blade[2] : pal.blade[1]);
    g.ring(8, 3, 1, pal.blade[1]);
    const s = v.dims.size;
    const top = 4 + chain;
    const left = 8 - Math.ceil(s / 2);
    g.rect(left, top, s, 1, pal.blade[2]);
    g.rect(left, top + s, s, 1, pal.blade[2]);
    for (let j = 1; j < s; j++) {
      g.set(left, top + j, pal.blade[1]);
      g.set(left + s - 1, top + j, pal.blade[1]);
    }
    const flame = pal.glow ?? pal.gem ?? '#ffd060';
    g.disc(8, top + Math.floor(s / 2), Math.max(1, Math.floor(s / 2) - 2), flame);
    g.set(8, top + Math.floor(s / 2) - 1, '#ffffff');
    if (v.choices.horns) {
      g.set(left - 1, top - 1, pal.blade[0]);
      g.set(left + s, top - 1, pal.blade[0]);
    }
    return { gripY: 4 };
  },
  fan(g, v, pal) {
    const ribs = v.dims.ribs;
    const size = v.dims.size;
    const px = 8;
    const py = 26;
    for (let r = 2; r <= size; r++) {
      for (let a = 0; a <= r * 2; a++) {
        const t = a / (r * 2);
        const dx = Math.round((t * 2 - 1) * r * 0.9);
        const dy = -Math.round(Math.sqrt(Math.max(0, r * r - dx * dx)));
        g.set(px + dx, py + dy, r === size ? pal.blade[0] : pal.blade[1]);
      }
    }
    for (let i = 0; i < ribs; i++) {
      const t = i / (ribs - 1);
      const dx = (t * 2 - 1) * 0.9;
      for (let k = 1; k <= size; k++) {
        const x = px + dx * k;
        const y = py - Math.sqrt(Math.max(0, 1 - dx * dx)) * k;
        g.set(x, y, pal.handle[0]);
      }
    }
    g.rect(7, 26, 2, 4, pal.handle[1]);
    if (v.choices.tassel) {
      g.set(8, 30, pal.glow ?? pal.accent);
      g.set(8, 31, pal.glow ?? pal.accent);
    }
    return { gripY: 27 };
  },
};

function outlinePass(g, color) {
  const marks = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (g.get(x, y)) continue;
      if (g.get(x - 1, y) || g.get(x + 1, y) || g.get(x, y - 1) || g.get(x, y + 1)) marks.push([x, y]);
    }
  }
  for (const [x, y] of marks) g.set(x, y, color);
}

function gridToCanvas(g) {
  const canvas = createCanvas(GRID_W, GRID_H);
  const ctx = ctx2d(canvas);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const c = g.px[y][x];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

const spriteCache = new Map();

/**
 * @returns {{ canvas: HTMLCanvasElement, pivotX: number, pivotY: number }}
 * The sprite points up; pivot is the grip, used for in-hand rotation.
 */
export function weaponSprite(dna) {
  const key = dna.id;
  let s = spriteCache.get(key);
  if (s) return s;
  const v = dna.visual;
  const g = new Grid();
  const draw = TEMPLATES[v.template] ?? TEMPLATES.blade;
  const { gripY } = draw(g, v, v.palette);
  outlinePass(g, v.glow && v.palette.glow ? v.palette.glow : v.palette.outline);
  if (v.glow && v.palette.glow) outlinePass(g, shadeHex(v.palette.glow, -0.5));
  s = { canvas: gridToCanvas(g), pivotX: 8, pivotY: gripY };
  spriteCache.set(key, s);
  if (spriteCache.size > 300) spriteCache.delete(spriteCache.keys().next().value);
  return s;
}

/** Square icon (weapon drawn diagonally) for inventory and discovery UI. */
export function weaponIcon(dna, size = 32) {
  const { canvas } = weaponSprite(dna);
  const out = createCanvas(size, size);
  const ctx = ctx2d(out);
  const diagonal = !['orb', 'chakram', 'lantern', 'fan', 'knives', 'boomerang'].includes(dna.visual.template);
  ctx.translate(size / 2, size / 2);
  if (diagonal) ctx.rotate(Math.PI / 4);
  ctx.drawImage(canvas, -GRID_W / 2, -GRID_H / 2);
  return out;
}
