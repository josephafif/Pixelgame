// Turns a weapon's visual DNA into pixel art. Each archetype template draws
// into a 16×32 grid (tip up, grip at the bottom); an automatic outline pass
// keeps every weapon readable on small screens, and elemental weapons get
// a glowing outline instead of a dark one.

import { createCanvas, ctx2d } from './canvas.js';
import { shadeHex } from '../weapons/visuals.js';
import { dnaKey } from '../weapons/dna.js';

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
    // Held across the aim: limbs up and down, string towards the archer.
    return { gripY: 16, gripX: 9 - c, hold: 'across' };
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
    // A flintlock seen from the side, muzzle up: barrel, lock, a grip
    // swept back and a trigger guard.
    const b = v.dims.barrel;
    const top = 20 - b;
    g.rect(7, top + 1, 2, b, pal.blade[1]);
    g.rect(7, top + 1, 1, b, pal.blade[0]);
    g.rect(6, top, 4, 1, pal.accent); // muzzle ring
    g.set(8, top - 1, pal.blade[2]); // front sight
    if (b >= 11) g.rect(7, top + Math.floor(b / 2), 2, 1, pal.accent); // barrel band
    g.rect(6, 20, 4, 4, pal.blade[1]); // the lock
    g.rect(6, 20, 1, 4, pal.blade[0]);
    g.rect(9, 20, 1, 4, pal.blade[2]);
    g.set(10, 20, pal.accent); // hammer
    g.set(10, 19, pal.accent);
    const grip = v.dims.grip;
    for (let i = 0; i < grip; i++) {
      const x = 7 + Math.floor((i + 1) / 2);
      g.set(x, 24 + i, pal.handle[0]);
      g.set(x + 1, 24 + i, pal.handle[1]);
    }
    g.set(7 + Math.floor(grip / 2), 24 + grip, pal.accent); // butt cap
    g.set(6, 24, pal.accent); // trigger guard
    g.set(6, 25, pal.accent);
    g.set(7, 26, pal.accent);
    g.set(7, 24, pal.blade[2]); // trigger
    if (v.choices.drum) {
      g.rect(5, 21, 1, 2, pal.blade[2]);
      g.rect(10, 21, 1, 2, pal.blade[2]);
      g.set(8, 21, pal.accent);
      g.set(7, 22, pal.accent);
    }
    if (pal.gem) g.set(8, 22, pal.gem);
    return { gripY: 26 };
  },
  cannon(g, v, pal) {
    // A hand cannon, muzzle up: a flared mouth, a barrel that swells to a
    // round breech, a knob behind it and a short wooden grip.
    const len = v.dims.barrel;
    const bore = v.dims.bore;
    const top = 25 - len;
    const shade = (x, l, r) => (x === l ? pal.blade[0] : x === r ? pal.blade[2] : x === l + 1 ? shadeHex(pal.blade[1], 0.18) : pal.blade[1]);
    for (let i = 0; i < len; i++) {
      const y = top + i;
      // Flared at the mouth, a little wider towards the breech.
      const half = i < 2 ? bore + 1 : bore - (i < len * 0.4 ? 1 : 0);
      const l = 8 - half;
      const r = 7 + half;
      for (let x = l; x <= r; x++) g.set(x, y, shade(x, l, r));
    }
    // Trunnions: the pegs on its sides that say "cannon".
    const ty = top + Math.floor(len * 0.6);
    g.rect(8 - bore - 1, ty, 1, 2, pal.blade[2]);
    g.rect(8 + bore, ty, 1, 2, pal.blade[2]);
    g.set(8 - bore - 1, ty, pal.accent);
    g.set(8 + bore, ty, pal.accent);
    g.rect(8 - bore + 1, top, bore * 2 - 2, 1, '#161622'); // the bore
    g.rect(8 - bore, top + 1, bore * 2, 1, shadeHex(pal.blade[2], -0.2));
    const breech = top + len;
    g.disc(8, breech, bore - 1, pal.blade[1]);
    g.set(7, breech - 1, pal.blade[0]);
    g.set(9, breech + 1, pal.blade[2]);
    g.rect(7, breech + bore - 1, 2, 1, pal.accent); // the knob
    if (v.choices.bands) {
      for (const y of [top + 2, top + Math.floor(len * 0.55)]) {
        const half = bore + (y === top + 2 ? 1 : 0);
        g.rect(8 - half, y, half * 2, 1, pal.accent);
        g.set(8 - half, y, shadeHex(pal.accent, 0.4));
      }
    }
    for (let y = breech + bore; y <= 30; y++) {
      g.set(7, y, pal.handle[0]);
      g.set(8, y, pal.handle[1]);
    }
    if (pal.gem) g.set(8, breech, pal.gem);
    return { gripY: 28 };
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
    const r = Math.ceil(v.dims.head / 2);
    // (A long staff stops short enough that its head stays on the sprite.)
    const top = handle(g, pal, Math.min(v.dims.length, 29 - 2 * r), 1);
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
    // A glass globe on a claw setting: a lit side, a dark side, a swirl of
    // light inside, and (rings) motes circling it.
    const r = Math.floor(v.dims.size / 2);
    const cy = 14;
    const core = pal.gem ?? pal.glow ?? pal.blade[1];
    g.disc(8, cy, r, pal.blade[2]);
    g.disc(8, cy, r - 1, core);
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d > (r - 1) * (r - 1)) continue;
        if (x + y < -r * 0.6) g.set(8 + x, cy + y, shadeHex(core, 0.35));
        else if (x + y > r * 0.9) g.set(8 + x, cy + y, shadeHex(core, -0.3));
      }
    }
    // The swirl inside.
    for (let k = 0; k < r + 2; k++) {
      const a = k * 0.9 + (v.variant % 6);
      const rr = (k / (r + 2)) * (r - 1.5);
      g.set(8 + Math.cos(a) * rr, cy + Math.sin(a) * rr, shadeHex(core, 0.6));
    }
    g.set(8 - Math.ceil(r / 2), cy - Math.ceil(r / 2), '#ffffff');
    g.set(9 - Math.ceil(r / 2), cy - Math.ceil(r / 2), shadeHex(core, 0.7));
    // The claw setting and its stem.
    const base = cy + r;
    g.set(8 - r + 1, base - 1, pal.accent);
    g.set(8 + r - 1, base - 1, pal.accent);
    g.rect(8 - r + 2, base, r * 2 - 3, 1, pal.accent);
    g.rect(7, base + 1, 2, 1, shadeHex(pal.accent, -0.25));
    for (let y = base + 2; y <= 28; y++) g.set(8, y, y % 2 ? pal.handle[0] : pal.handle[1]);
    g.rect(7, 29, 3, 1, pal.accent);
    if (v.choices.rings) {
      const glow = pal.glow ?? pal.accent;
      for (const [dx, dy] of [[r + 2, -1], [-r - 2, 2], [2, -r - 2], [-3, r + 1]]) g.set(8 + dx, cy + dy, glow);
    }
    return { gripY: Math.min(28, base + 4) };
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
    // A braided lash in waves up from the handle, thick at the grip and
    // thin at the tip, with a cracker on the end (and barbs on the bends).
    const H = v.dims.handle;
    const top = handle(g, pal, H + 1);
    g.rect(7, top - 1, 2, 1, pal.accent); // the knot where the lash starts
    const waves = v.dims.coils;
    const end = 2;
    const length = top - 2 - end;
    let last = null;
    for (let i = 0; i <= length; i++) {
      const t = i / length;
      const y = top - 2 - i;
      const x = 8 + Math.round(Math.sin(t * Math.PI * waves) * (1 + 2 * t));
      const braid = i % 2 ? pal.blade[1] : pal.blade[2];
      g.set(x, y, braid);
      if (t < 0.45) g.set(x + 1, y, pal.blade[2]);
      // Keep the line unbroken where it swings sideways.
      if (last !== null && Math.abs(x - last) > 1) g.set((x + last) / 2, y, braid);
      if (v.choices.barbed && i > 2 && Math.abs(Math.cos(t * Math.PI * waves)) < 0.2) g.set(x - 1, y, pal.blade[0]);
      last = x;
    }
    g.set(last, end - 1, pal.accent); // the cracker
    g.set(last + 1, end - 2, pal.accent);
    if (pal.gem) g.set(8, 30 - Math.floor(H / 2), pal.gem);
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

/**
 * What a weapon gains as it grows in its tree (visual.evo.tier): a polished
 * glint on its edges (Tempered), an engraving down its middle (Masterwork)
 * and glowing runes (Awakening). The aura and halo are outlines (below).
 */
function evoDetails(g, v, pal) {
  const tier = v.evo?.tier ?? 0;
  if (!tier) return;
  const glint = shadeHex(pal.blade[0], 0.4);
  const rune = pal.glow ?? pal.gem ?? pal.accent;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const c = g.get(x, y);
      if (!c) continue;
      if (c === pal.blade[0] && (x + y) % 3 === 0) g.set(x, y, glint);
      else if (tier >= 3 && c === pal.blade[1] && (x === 8 || x === 7) && y % 3 === 1) {
        g.set(x, y, tier >= 5 && y % 2 ? rune : shadeHex(pal.accent, 0.15));
      }
    }
  }
}

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

/** Loose pixels just outside the outline: every `every`-th spot, so the shape still reads. */
function motePass(g, color, every, seed) {
  const marks = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (g.get(x, y)) continue;
      if (!(g.get(x - 1, y) || g.get(x + 1, y) || g.get(x, y - 1) || g.get(x, y + 1))) continue;
      if ((x * 7 + y * 3 + seed) % every === 0) marks.push([x, y]);
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
 * @returns {{ canvas: HTMLCanvasElement, pivotX: number, pivotY: number, hold: string }}
 * The sprite points up; pivot is the grip, used for in-hand rotation.
 * `hold` is 'along' (tip points where you aim) or 'across' (bows: the
 * weapon's length lies across the aim and its belly faces forward).
 */
export function weaponSprite(dna) {
  // (An evolved weapon keeps its id: its step in the tree is part of the key.)
  const key = dnaKey(dna);
  let s = spriteCache.get(key);
  if (s) return s;
  const v = dna.visual;
  const g = new Grid();
  const draw = TEMPLATES[v.template] ?? TEMPLATES.blade;
  const { gripY, gripX = 8, hold = 'along' } = draw(g, v, v.palette);
  evoDetails(g, v, v.palette);
  outlinePass(g, v.glow && v.palette.glow ? v.palette.glow : v.palette.outline);
  if (v.glow && v.palette.glow) outlinePass(g, shadeHex(v.palette.glow, -0.5));
  // An infused weapon wears a faint aura, an awakened one a brighter halo:
  // loose motes around the outline, never a solid block.
  const tier = v.evo?.tier ?? 0;
  const aura = v.palette.glow ?? v.palette.gem ?? v.palette.accent;
  if (tier >= 4 && aura) motePass(g, shadeHex(aura, tier >= 5 ? 0.25 : -0.15), tier >= 5 ? 2 : 3, v.variant ?? 0);
  s = { canvas: gridToCanvas(g), pivotX: gripX, pivotY: gripY, hold };
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
