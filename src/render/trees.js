// Trees, rocks and the other standing things, drawn as sprites of their own
// (not into the ground), so they sort with everyone by depth: walk behind a
// tree and its crown hides you, walk in front and you hide its trunk.
//
// Every tree is one of many: a form (a round tree, a broad old oak, a
// forked one, a young one, a low bushy one, a windswept or a swampy one), a
// size and a shade of green, picked by its tile and its biome, so no two
// neighbours look alike while all of them belong together. Pines, palms,
// cacti and boulders vary the same way. Only the look: what a tile is, and
// where it blocks, stays exactly as before.

import { createRng, hashInts } from '../core/rng.js';
import { createCanvas, ctx2d } from './canvas.js';
import { T } from '../game/world.js';
import { tileCanvas, UPRIGHT } from './tiles-art.js';

export { UPRIGHT };

/** Trees whose crowns sway when someone walks through. */
export const SWAYS = new Set([T.TREE, T.PINE, T.PALM]);

const O = '#141a16'; // outline

function disc(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  const rr = r * r + r * 0.8;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(Math.max(0, rr - y * y)));
    ctx.fillRect(cx - w, cy + y, w * 2 + 1, 1);
  }
}

/** An upright ellipse of pixels (boulders). */
function oval(ctx, cx, cy, rx, ry, color) {
  ctx.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / ((ry + 0.5) * (ry + 0.5)))));
    if (w >= 0) ctx.fillRect(cx - w, cy + y, w * 2 + 1, 1);
  }
}

// --- Colours --------------------------------------------------------------------------------
// Soft, natural greens close to the grass: each tree a little different, all
// of them one family. [outline, deep shade, shade, mid, light, warm highlight].

const LEAVES = {
  lush: [
    ['#1b2e1f', '#213f27', '#2b5530', '#386c37', '#4c8740', '#79a855'],
    ['#1a2d20', '#1f3d2a', '#295334', '#356a3d', '#478446', '#72a65c'],
    ['#1e2e1c', '#283f24', '#34562d', '#456e36', '#5b8a40', '#88ad5a'],
  ],
  deep: [
    ['#14241a', '#183320', '#21452a', '#2c5a33', '#3c733d', '#5f934c'],
    ['#14231c', '#173226', '#1f4430', '#2a593a', '#397247', '#5a9160'],
    ['#172619', '#1c3620', '#264a29', '#335f33', '#44773d', '#679854'],
  ],
  sage: [
    ['#1e2a1e', '#2a3c28', '#384f33', '#4a6640', '#5f7f4c', '#87a566'],
    ['#1d291f', '#283a2b', '#344d38', '#446446', '#587e55', '#83a376'],
  ],
  fen: [
    ['#13231f', '#183129', '#204337', '#2c5a48', '#3d725a', '#679a7c'],
    ['#15241d', '#1b3326', '#244532', '#305b41', '#427352', '#6b9a6e'],
  ],
  sky: [
    ['#1c2e22', '#25412d', '#305a39', '#3f7547', '#559056', '#8cc078'],
    ['#1b2d24', '#233f30', '#2e583d', '#3c724c', '#518d5c', '#86bd84'],
  ],
};

/** Bark: [outline, shade, base, light]. */
const BARK = {
  brown: ['#1e1610', '#3c2817', '#5a3d26', '#7a5636'],
  dark: ['#18120c', '#2a2219', '#43362a', '#5e4c3a'],
  grey: ['#1c1a17', '#3f3b35', '#5e5a52', '#7c776c'],
};

// --- Broadleaf trees ------------------------------------------------------------------------
// A crown is a heap of leaf clusters. Each pixel belongs to the cluster in
// front (the lower one, nearer to you) and is lit by how it faces the light
// (from the upper left), darker deep down in the crown and where one
// cluster lies over another; little dabs of leaves break up the tones. The
// trunk flares into roots at the foot and forks into branches that you see
// between the lowest clusters.

/** A pixel painter: colours by index, written to the canvas in one go. */
function painter(w, h) {
  const px = new Array(w * h).fill(null);
  return {
    w, h, px,
    set(x, y, c) {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = c;
    },
    get(x, y) {
      return x >= 0 && y >= 0 && x < w && y < h ? px[y * w + x] : null;
    },
    canvas() {
      const c = createCanvas(w, h);
      const ctx = ctx2d(c);
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < px.length; i++) {
        if (!px[i]) continue;
        const n = parseInt(px[i].slice(1), 16);
        img.data[i * 4] = n >> 16;
        img.data[i * 4 + 1] = (n >> 8) & 255;
        img.data[i * 4 + 2] = n & 255;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
  };
}

/** A line of bark (a branch or a root), w pixels thick. */
function limb(pt, x0, y0, x1, y1, w, bark) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    for (let k = 0; k < w; k++) pt.set(x + k, y, k === 0 ? bark[3] : k === w - 1 ? bark[1] : bark[2]);
  }
}

/** The trunk from the foot (mx, foot) up to `top`, with roots and its bark lit from the left. */
function drawTrunk(pt, mx, foot, top, w, bark, lean = 0) {
  for (let y = top; y <= foot; y++) {
    const k = (foot - y) / Math.max(1, foot - top);
    const x = Math.round(mx + lean * k * k * (foot - top) * 0.25);
    const ww = w + (y > foot - 3 ? 2 : 0) - (k > 0.7 ? 1 : 0);
    const x0 = x - (ww >> 1);
    for (let i = -1; i <= ww; i++) {
      const edge = i === -1 || i === ww;
      pt.set(x0 + i, y, edge ? bark[0] : i === 0 ? bark[3] : i >= ww - 1 ? bark[1] : bark[2]);
    }
    // A knot or a crack now and then.
    if (ww > 3 && (y * 7 + x) % 9 === 0) pt.set(x0 + (ww >> 1), y, bark[1]);
  }
  // Roots spreading into the ground.
  const x0 = mx - (w >> 1);
  for (const [dx, len] of [[-2, 3], [w + 1, 3]]) {
    const dir = dx < 0 ? -1 : 1;
    for (let i = 0; i < len; i++) {
      pt.set(x0 + dx + dir * i, foot - 1 + (i > 0 ? 1 : 0), bark[i === 0 ? 2 : 1]);
      pt.set(x0 + dx + dir * i, foot + (i > 0 ? 1 : 0) - 1 + 1, bark[0]);
    }
  }
}

/** Paints a crown of clusters [x, y, r] over whatever is there. */
function drawCrown(pt, clusters, pal, rng, { droop = 0 } = {}) {
  const [o, deep, dark, mid, light, hi] = pal;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [, y, r] of clusters) {
    top = Math.min(top, y - r);
    bottom = Math.max(bottom, y + r);
  }
  const span = Math.max(1, bottom - top);
  const inside = new Uint8Array(pt.w * pt.h);
  const tones = [deep, dark, mid, light, hi];
  for (let y = 0; y < pt.h; y++) {
    for (let x = 0; x < pt.w; x++) {
      // The cluster in front: the one this pixel is deepest in, the lower ones winning.
      let best = -1;
      let bh = 0;
      let behind = false;
      for (let i = 0; i < clusters.length; i++) {
        const [cx, cy, r] = clusters[i];
        const dx = x - cx;
        const dy = (y - cy) * 1.12;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const hh = 1 - d2 / (r * r);
        if (best >= 0) behind = true;
        if (best < 0 || hh + cy * 0.035 > bh + clusters[best][1] * 0.035) {
          best = i;
          bh = hh;
        }
      }
      if (best < 0) continue;
      inside[y * pt.w + x] = 1;
      const [cx, cy, r] = clusters[best];
      const nx = (x - cx) / r;
      const ny = (y - cy) / r;
      // Light from the upper left; deeper in the crown (lower down) is darker.
      let lam = -(nx * 0.62 + ny * 0.78) * 0.9 + 0.32 - ((y - top) / span) * 0.62;
      // Where a cluster lies over another, a thin shade at its rim.
      if (behind && bh < 0.2) lam -= 0.55;
      // Leaves: little dabs (2 × 1) of a lighter or darker tone.
      const leaf = hashInts(Math.floor(x / 2), y, 0x1eaf + clusters.length);
      lam += ((leaf % 100) / 100 - 0.5) * 0.3;
      const t = lam < -0.62 ? 0 : lam < -0.2 ? 1 : lam < 0.2 ? 2 : lam < 0.58 ? 3 : 4;
      pt.set(x, y, tones[t]);
    }
  }
  // Hanging fringe (the fen's trees): short strands below the crown.
  if (droop) {
    for (let x = 0; x < pt.w; x++) {
      let low = -1;
      for (let y = pt.h - 1; y >= 0; y--) {
        if (inside[y * pt.w + x]) {
          low = y;
          break;
        }
      }
      if (low < 0 || hashInts(x, 3, 0xd00) % 3) continue;
      const len = 2 + (hashInts(x, 7, 0xd01) % droop);
      for (let i = 1; i <= len; i++) {
        pt.set(x, low + i, i === len ? deep : dark);
        inside[(low + i) * pt.w + x] = pt.get(x, low + i) ? 1 : 0;
      }
    }
  }
  // The outline: dark below and right, a softer one above and left.
  const edge = [];
  for (let y = 0; y < pt.h; y++) {
    for (let x = 0; x < pt.w; x++) {
      if (inside[y * pt.w + x]) continue;
      const n = (xx, yy) => xx >= 0 && yy >= 0 && xx < pt.w && yy < pt.h && inside[yy * pt.w + xx];
      if (n(x, y - 1) || n(x - 1, y)) edge.push([x, y, o]);
      else if (n(x, y + 1) || n(x + 1, y)) edge.push([x, y, deep]);
    }
  }
  for (const [x, y, c] of edge) pt.set(x, y, c);
  // A few warm sparkles on the sunny side.
  for (let i = 0; i < clusters.length; i++) {
    const [cx, cy, r] = clusters[i];
    if (r < 4) continue;
    const x = cx - Math.round(r * 0.45) + rng.int(-1, 1);
    const y = cy - Math.round(r * 0.5) + rng.int(-1, 1);
    if (pt.get(x, y) === light || pt.get(x, y) === hi) {
      pt.set(x, y, hi);
      pt.set(x + 1, y, hi);
    }
  }
  return inside;
}

/** Clusters around an ellipse (rx × ry at cx, cy): a lumpy rim and a full middle. */
function heap(rng, cx, cy, rx, ry, n, rMin, rMax) {
  const out = [[cx, cy, Math.round(Math.min(rx, ry) * 0.85)]];
  const a0 = rng.next() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + (rng.next() - 0.5) * 0.5;
    const d = 0.55 + rng.next() * 0.25;
    out.push([Math.round(cx + Math.cos(a) * rx * d), Math.round(cy + Math.sin(a) * ry * d), rng.int(rMin, rMax)]);
  }
  // A few inside, so the middle has its own lumps.
  for (let i = 0; i < Math.ceil(n / 3); i++) {
    out.push([Math.round(cx + (rng.next() - 0.5) * rx), Math.round(cy + (rng.next() - 0.5) * ry), rng.int(rMin, rMax)]);
  }
  return out;
}

/**
 * A broadleaf tree: its form, its size (0 small, 1 medium, 2 big) and its
 * leaves. Returns the canvas; its foot is at the bottom middle.
 */
function broadleaf(form, s, pal, rng) {
  const R = [7, 9, 11][s];
  const W = Math.round(R * 2.9 + 8) | 1;
  // (The crown sits low on a short, sturdy trunk: no lollipops.)
  const H = Math.round(R * 2.05 + 14 + s);
  const pt = painter(W, H);
  const mx = W >> 1;
  const foot = H - 2;
  let bark = BARK.brown;
  let clusters;
  let trunkTop;
  let trunkW = [4, 5, 6][s];
  let lean = 0;
  let droop = 0;
  let branches = [];
  switch (form) {
    case 'twin': {
      // Two crowns from one forked trunk.
      const cy = Math.round(R * 1.15) + 2;
      const left = heap(rng, mx - Math.round(R * 0.62), cy + 1, R * 0.8, R * 0.72, 5, Math.max(3, R - 5), R - 3);
      const right = heap(rng, mx + Math.round(R * 0.62), cy - 1, R * 0.8, R * 0.72, 5, Math.max(3, R - 5), R - 3);
      clusters = [...left, ...right];
      trunkTop = cy + 2;
      branches = [[mx, trunkTop + 3, mx - Math.round(R * 0.55), cy + 1], [mx, trunkTop + 3, mx + Math.round(R * 0.55), cy - 1]];
      break;
    }
    case 'young': {
      // A young tree: a slim trunk and a light, open crown.
      const cy = Math.round(R * 1.05) + 2;
      clusters = heap(rng, mx, cy, R * 0.8, R * 0.75, 4, Math.max(3, R - 5), R - 3);
      trunkTop = cy;
      trunkW = 3;
      branches = [[mx, cy + 3, mx - 3, cy], [mx, cy + 2, mx + 3, cy - 1]];
      break;
    }
    case 'bushy': {
      // Low and wide, its crown close to the ground.
      const cy = H - Math.round(R * 0.95) - 6;
      clusters = heap(rng, mx, cy, R * 1.3, R * 0.75, 8, Math.max(3, R - 4), R - 2);
      trunkTop = cy + 2;
      trunkW = Math.max(3, trunkW - 1);
      break;
    }
    case 'windswept': {
      // Bent by the wind (Skyreach): the crown pushed to one side.
      const cy = Math.round(R * 1.15) + 2;
      clusters = heap(rng, mx + 3, cy, R * 1.05, R * 0.7, 6, Math.max(3, R - 5), R - 2);
      trunkTop = cy + 1;
      lean = 1.4;
      bark = BARK.grey;
      branches = [[mx + 2, cy + 3, mx + 7, cy]];
      break;
    }
    case 'swamp': {
      // The fen: a broad, dark crown with a hanging fringe, on a mossy trunk.
      const cy = Math.round(R * 1.1) + 2;
      clusters = heap(rng, mx, cy, R * 1.15, R * 0.75, 7, Math.max(3, R - 4), R - 2);
      trunkTop = cy + 1;
      bark = BARK.dark;
      droop = 3 + s;
      break;
    }
    case 'oak': {
      // A big old oak: broad and full, a thick trunk with branches spreading.
      const cy = Math.round(R * 1.1) + 2;
      clusters = heap(rng, mx, cy, R * 1.25, R * 0.9, 9, Math.max(3, R - 4), R - 1);
      trunkTop = cy + 1;
      trunkW += 1;
      branches = [[mx - 1, cy + 4, mx - R + 2, cy + 1], [mx + 1, cy + 4, mx + R - 2, cy]];
      break;
    }
    default: {
      // A round tree, lumpy at the rim.
      const cy = Math.round(R * 1.1) + 2;
      clusters = heap(rng, mx, cy, R, R * 0.88, 7, Math.max(3, R - 4), R - 2);
      trunkTop = cy + 1;
      branches = [[mx, cy + 4, mx - Math.round(R * 0.6), cy + 1], [mx, cy + 4, mx + Math.round(R * 0.5), cy]];
    }
  }
  drawTrunk(pt, mx, foot, trunkTop, trunkW, bark, lean);
  for (const [x0, y0, x1, y1] of branches) limb(pt, x0, y0, x1, y1, 2, bark);
  const inside = drawCrown(pt, clusters, pal, rng, { droop });
  // Branches show between the lowest clusters; the crown shades the top of the trunk.
  for (const [x0, y0, x1, y1] of branches) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i += 1) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n);
      const y = Math.round(y0 + ((y1 - y0) * i) / n);
      if (!inside[y * pt.w + x] || pt.get(x, y + 2) && inside[(y + 2) * pt.w + x]) continue;
      if (hashInts(x, y, 0xb4a) % 3 === 0) continue;
      pt.set(x, y, bark[1]);
    }
  }
  // Moss on the roots (in the forest and the fen).
  if (pal === LEAVES.deep[0] || pal === LEAVES.deep[1] || form === 'swamp') {
    pt.set(mx - (trunkW >> 1) - 1, foot - 1, pal[3]);
    pt.set(mx + (trunkW >> 1) + 1, foot - 2, pal[4]);
  }
  return pt.canvas();
}

// --- Pines, palms, cacti --------------------------------------------------------------------

/** Needle greens: [outline, deep, shade, mid, light, warm tip]. */
const NEEDLES = [
  ['#11221a', '#16301f', '#1f4229', '#2a5734', '#3a6e40', '#5c8c52'],
  ['#10211c', '#152f25', '#1d412f', '#28563b', '#376d49', '#5a8a62'],
];

/**
 * A pine of size s: tiers of drooping, jagged boughs, lit from the left,
 * darker inside and below; snow lies on the tops of the boughs in the
 * snow. Narrow ones are spruces.
 */
function pine(s, snowy, narrow, rng) {
  const tiers = [3, 4, 5][s];
  const half = [9, 11, 13][s] - (narrow ? 3 : 0);
  const H = 12 + tiers * 7;
  const W = half * 2 + 6;
  const pt = painter(W, H);
  const mx = W >> 1;
  const pal = NEEDLES[rng.int(0, NEEDLES.length - 1)];
  const [o, deep, dark, mid, light, tip] = pal;
  // The trunk, showing below the lowest boughs.
  for (let y = H - 9; y < H - 1; y++) {
    pt.set(mx - 2, y, '#1e1610');
    pt.set(mx - 1, y, '#7a5636');
    pt.set(mx, y, '#5a3d26');
    pt.set(mx + 1, y, '#3c2817');
    pt.set(mx + 2, y, '#1e1610');
  }
  pt.set(mx - 3, H - 1, '#1e1610');
  pt.set(mx + 3, H - 1, '#1e1610');
  pt.set(mx - 2, H - 1, '#3c2817');
  pt.set(mx + 2, H - 1, '#3c2817');
  const inside = new Uint8Array(W * H);
  // Boughs from the top down; each lower one wider, its rim jagged and drooping at the tips.
  for (let t = 0; t < tiers; t++) {
    const top = 2 + t * 7;
    const w = Math.round(((t + 1) / tiers) * half) + 1;
    for (let row = 0; row < 9; row++) {
      const k = row / 8;
      let ww = Math.min(w, 1 + Math.floor(row * w / 7));
      const y = top + row;
      for (let x = -ww; x <= ww; x++) {
        // Jagged rim: needles poke out and in.
        const edge = ww - Math.abs(x);
        if (edge === 0 && hashInts(x, y, 0x9e1) % 3 === 0) continue;
        if (row === 8 && Math.abs(x) < ww - 2 && hashInts(x, t, 0x9e2) % 2) continue;
        const side = x / Math.max(1, ww);
        let lam = -side * 0.7 + 0.25 - k * 0.55 + (edge < 2 ? 0.15 : 0);
        lam += ((hashInts(x, y, 0x9e3) % 100) / 100 - 0.5) * 0.25;
        const c = lam < -0.55 ? deep : lam < -0.15 ? dark : lam < 0.2 ? mid : lam < 0.5 ? light : tip;
        pt.set(mx + x, y, c);
        inside[y * W + mx + x] = 1;
      }
      // Drooping tips at the ends of the lowest rows.
      if (row === 8) {
        pt.set(mx - ww - 1, y + 1, dark);
        pt.set(mx + ww + 1, y + 1, deep);
        inside[(y + 1) * W + mx - ww - 1] = 1;
        inside[(y + 1) * W + mx + ww + 1] = 1;
      }
    }
    if (snowy) {
      // Snow resting on the bough: soft lumps on its upper side.
      for (let x = -w + 1; x <= w - 2; x++) {
        if (hashInts(x, t, 0x5a0) % 4 === 0) continue;
        const row = Math.max(0, Math.round((Math.abs(x) * 7) / Math.max(1, w)) - 1);
        const y = top + row;
        pt.set(mx + x, y, x < 0 ? '#f4f8fc' : '#d8e2ee');
        if (hashInts(x, t, 0x5a1) % 3 === 0) pt.set(mx + x, y + 1, '#c4d2e2');
      }
    }
  }
  // Outline.
  const edge = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inside[y * W + x]) continue;
      const n = (xx, yy) => xx >= 0 && yy >= 0 && xx < W && yy < H && inside[yy * W + xx];
      if (n(x, y - 1) || n(x - 1, y) || n(x + 1, y) || n(x, y + 1)) edge.push([x, y]);
    }
  }
  for (const [x, y] of edge) if (!pt.get(x, y) || y < H - 9) pt.set(x, y, o);
  return pt.canvas();
}

/** A palm of size s leaning one way (dir ±1). */
function palm(s, dir, rng) {
  const H = [28, 34, 40][s];
  const W = 34;
  const c = createCanvas(W, H);
  const ctx = ctx2d(c);
  const len = H - 10;
  const lean = 3 + s + rng.int(0, 2);
  const pts = [];
  for (let y = H - 1; y >= H - 1 - len; y--) pts.push([17 + Math.round(((H - 1 - y) / len) ** 1.6 * lean * dir), y]);
  for (const [x, y] of pts) {
    ctx.fillStyle = O;
    ctx.fillRect(x - 2, y, 5, 1);
  }
  for (const [x, y] of pts) {
    ctx.fillStyle = y % 3 === 0 ? '#6e4a28' : '#9a6a3a';
    ctx.fillRect(x - 1, y, 3, 1);
    ctx.fillStyle = '#b8864e';
    ctx.fillRect(x - 1, y, 1, 1);
  }
  const [tx, ty] = pts[pts.length - 1];
  const frond = (fd, flen, droop, color) => {
    for (let i = 0; i <= flen; i++) {
      const x = tx + fd * i;
      const y = ty + Math.round((i / flen) ** 2 * droop) - (i < 3 ? 1 : 0);
      ctx.fillStyle = O;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
    for (let i = 0; i <= flen; i++) {
      const x = tx + fd * i;
      const y = ty + Math.round((i / flen) ** 2 * droop) - (i < 3 ? 1 : 0);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
      if (i > 1 && i < flen) ctx.fillRect(x, y + 1, 1, 1);
    }
  };
  const fl = 9 + s * 2;
  frond(-1, fl, 7, '#2f8a3c');
  frond(1, fl, 7, '#2f8a3c');
  frond(-1, fl - 3, 2, '#4fb04f');
  frond(1, fl - 3, 2, '#4fb04f');
  ctx.fillStyle = '#5cc05a';
  for (const [dx, dy] of [[-4, -4], [4, -4], [-2, -5], [2, -5], [0, -5]]) ctx.fillRect(tx + dx, ty + dy, 1, 1);
  if (rng.chance(0.6)) {
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(tx - 2, ty + 1, 2, 2);
    ctx.fillRect(tx + 1, ty + 1, 2, 2);
  }
  return c;
}

/** A cactus: a saguaro with arms, a tall column or a squat barrel. */
function cactus(form, rng) {
  const c = createCanvas(18, 26);
  const ctx = ctx2d(c);
  const g = ['#2f6a2c', '#4a9a3c', '#6ab84e'];
  const col = (x, top, bottom, w) => {
    ctx.fillStyle = O;
    ctx.fillRect(x - 1, top - 1, w + 2, bottom - top + 2);
    ctx.fillStyle = g[1];
    ctx.fillRect(x, top, w, bottom - top);
    ctx.fillStyle = g[2];
    ctx.fillRect(x, top, 1, bottom - top);
    ctx.fillStyle = g[0];
    ctx.fillRect(x + w - 1, top + 1, 1, bottom - top - 1);
  };
  if (form === 'barrel') {
    disc(ctx, 9, 20, 6, O);
    disc(ctx, 9, 20, 5, g[1]);
    disc(ctx, 8, 19, 3, g[2]);
    ctx.fillStyle = '#ff7ab0';
    ctx.fillRect(8, 14, 3, 2);
  } else {
    const top = form === 'column' ? 2 : 5;
    col(7, top, 25, 4);
    if (form === 'saguaro') {
      const ly = rng.int(11, 15);
      const ry = rng.int(8, 12);
      col(3, ly - 6, ly, 3);
      col(3, ly - 1, ly + 2, 5);
      col(12, ry - 5, ry, 3);
      col(10, ry - 1, ry + 2, 5);
    }
  }
  ctx.fillStyle = '#e8e4c8';
  for (let i = 0; i < 6; i++) ctx.fillRect(rng.int(4, 13), rng.int(4, 23), 1, 1);
  return c;
}

/** A boulder of size s (mossy on green ground); some are flat slabs. */
function boulder(s, flat, mossy, rng) {
  const W = [18, 24, 30][s];
  const Hh = [15, 20, 25][s] - (flat ? 4 : 0);
  const c = createCanvas(W, Hh);
  const ctx = ctx2d(c);
  const [d, m, l, h] = ['#4e4e5a', '#6a6a76', '#84848f', '#a8a8b4'];
  const cx = W >> 1;
  const r = (W >> 1) - 2;
  const ry = Math.max(4, Math.floor(r * (flat ? 0.55 : 0.85)));
  const cy = Hh - ry - 2;
  oval(ctx, cx, cy, r + 1, ry + 1, O);
  oval(ctx, cx, cy, r, ry, d);
  oval(ctx, cx - 1, cy - 1, r - 1, ry - 1, m);
  oval(ctx, cx - 2, cy - Math.ceil(ry / 2), Math.max(1, r - 4), Math.max(1, Math.floor(ry / 2)), l);
  ctx.fillStyle = h;
  ctx.fillRect(cx - Math.floor(r / 2), cy - ry + 2, 3, 1);
  ctx.fillStyle = d;
  for (let i = 0; i < 2 + s; i++) {
    const x = cx + rng.int(-r + 3, r - 4);
    const y = cy + rng.int(-1, ry - 2);
    ctx.fillRect(x, y, 2, 1);
    ctx.fillRect(x + 1, y + 1, 1, 1);
  }
  ctx.clearRect(0, Hh - 1, W, 1);
  ctx.fillStyle = O;
  ctx.fillRect(cx - r + 2, Hh - 2, r * 2 - 3, 1);
  if (mossy) {
    ctx.fillStyle = '#4f8a44';
    ctx.fillRect(cx - Math.floor(r / 2), cy - ry + 1, Math.max(3, r - 2), 1);
    ctx.fillStyle = '#6aa852';
    ctx.fillRect(cx - Math.floor(r / 2) + 1, cy - ry + 1, 2, 1);
  }
  return c;
}

// --- Undergrowth: bushes, ferns, grass, moss and the like on the ground ------------------------
// Small and low, drawn with the ground (you walk over them), so a forest
// floor is never bare between the trunks.

const decorCache = new Map();

/** A little bush (berries now and then). */
function bush(v, pal, snowy) {
  const pt = painter(13, 10);
  const rng = createRng(0xb05 + v * 31);
  const clusters = [[6, 6, 3], [3 + rng.int(0, 1), 7, 2], [9 - rng.int(0, 1), 7, 2], [6 + rng.int(-1, 1), 4, 2]];
  drawCrown(pt, clusters, pal, rng);
  if (snowy) {
    for (const [x, y] of [[4, 2], [5, 2], [6, 1], [7, 2], [8, 3], [3, 4]]) pt.set(x, y, '#eef4fa');
  } else if (v % 4 === 0) {
    for (const [x, y] of [[4, 5], [8, 6], [6, 7]]) pt.set(x, y, '#b8303a');
  }
  return pt.canvas();
}

/** A fern: arching fronds from one root. */
function fern(v, pal) {
  const pt = painter(13, 9);
  const [, deep, dark, mid, light] = pal;
  const fronds = [[-5, -3], [-3, -6], [0, -7], [3, -6], [5, -3], [-6, 0], [6, 0]];
  for (const [i, [dx, dy]] of fronds.entries()) {
    if ((v + i) % 5 === 4) continue;
    const n = Math.max(Math.abs(dx), Math.abs(dy));
    for (let k = 1; k <= n; k++) {
      const x = 6 + Math.round((dx * k) / n);
      const y = 8 + Math.round((dy * k) / n) + (k > n * 0.6 ? 1 : 0);
      pt.set(x, y, k < n * 0.5 ? dark : dx < 0 ? light : mid);
      if (k % 2 === 0) pt.set(x + (dx < 0 ? -1 : dx > 0 ? 1 : 0), y - 1, deep);
    }
  }
  return pt.canvas();
}

/** A clump of tall grass. */
function grass(v, colors) {
  const pt = painter(9, 8);
  const [d, m, l] = colors;
  for (let i = 0; i < 6; i++) {
    const x = 1 + ((i * 5 + v * 3) % 7);
    const h = 3 + ((i * 7 + v) % 5);
    const lean = ((i + v) % 3) - 1;
    for (let k = 0; k < h; k++) pt.set(x + (k > h * 0.6 ? lean : 0), 7 - k, k === h - 1 ? l : k < 2 ? d : m);
  }
  return pt.canvas();
}

/** Two little mushrooms. */
function mushrooms(v) {
  const pt = painter(8, 6);
  const cap = v % 2 ? ['#8a2a24', '#c0442e', '#f0d8c8'] : ['#6a4a2a', '#9a7040', '#e8d8b8'];
  for (const [x, y, big] of [[2, 3, 1], [5, 4, 0]]) {
    pt.set(x, y + 1, '#e8e0cc');
    pt.set(x, y + 2, '#c8bca4');
    pt.set(x - 1, y, cap[0]);
    pt.set(x, y, cap[1]);
    pt.set(x + 1, y, cap[0]);
    if (big) {
      pt.set(x, y - 1, cap[1]);
      pt.set(x - 1, y - 1, cap[0]);
      pt.set(x + 1, y - 1, cap[0]);
      pt.set(x, y, cap[2]);
    }
  }
  return pt.canvas();
}

/** A patch of moss. */
function moss(v, pal) {
  const pt = painter(10, 5);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 10; x++) {
      const dx = (x - 4.5) / 5;
      const dy = (y - 2) / 2.5;
      if (dx * dx + dy * dy > 1 || hashInts(x, y, 0x3055 + v) % 4 === 0) continue;
      pt.set(x, y, (x + y + v) % 3 ? pal[3] : pal[4]);
    }
  }
  return pt.canvas();
}

/** Reeds by the water's edge (the fen). */
function reeds(v) {
  const pt = painter(9, 12);
  for (let i = 0; i < 4; i++) {
    const x = 1 + ((i * 2 + v) % 7);
    const h = 6 + ((i * 3 + v) % 5);
    for (let k = 0; k < h; k++) pt.set(x, 11 - k, k < 3 ? '#2c5240' : '#5a8a5a');
    pt.set(x, 11 - h, '#6a4a2a');
    pt.set(x, 12 - h, '#7a5636');
  }
  return pt.canvas();
}

/** Pebbles. */
function pebbles(v, tone) {
  const pt = painter(8, 4);
  const [d, l] = tone;
  for (const [x, y] of [[1, 2], [4, 1], [6, 2]].slice(0, 2 + (v % 2))) {
    pt.set(x, y, l);
    pt.set(x + 1, y, d);
    pt.set(x, y + 1, d);
  }
  return pt.canvas();
}

const GRASS_TONES = {
  green: ['#2f6230', '#4c8a43', '#6aa852'],
  sage: ['#4c6a3e', '#6a8a58', '#8aa870'],
  fen: ['#1e4436', '#346454', '#5a9a7a'],
  sky: ['#4a8a40', '#6eb060', '#98d088'],
  dry: ['#8a7040', '#b09a60', '#d8c488'],
  snow: ['#5a6a4a', '#7a8a62', '#a8b48a'],
};

/**
 * What grows on the ground of a tile, if anything: { canvas, ox, oy } (its
 * top-left in the tile), or null. `near` is how many trees stand close by
 * (a forest floor gets more), `wet` whether water is next to it.
 */
export function undergrowth(wx, wy, ground, near, wet) {
  const h = hashInts(wx, wy, 0xdec0);
  const r = (h % 1000) / 1000;
  const v = (h >>> 10) & 7;
  const ox = 1 + ((h >>> 14) % 5);
  const oy = 2 + ((h >>> 17) % 6);
  let kind = null;
  let key;
  let make;
  const green = ground === T.GRASS || ground === T.FLOWERS || ground === T.MOSS;
  if (green || ground === T.ROCKGRASS || ground === T.SKYGRASS) {
    const pal = ground === T.SKYGRASS ? LEAVES.sky[v % 2] : ground === T.ROCKGRASS ? LEAVES.sage[v % 2] : LEAVES.lush[v % 3];
    const tones = ground === T.SKYGRASS ? GRASS_TONES.sky : ground === T.ROCKGRASS ? GRASS_TONES.sage : GRASS_TONES.green;
    const chance = near ? 0.34 + Math.min(0.2, near * 0.04) : 0.07;
    if (r >= chance) return null;
    const pick = r / chance;
    if (near && pick < 0.2) kind = 'fern';
    else if (pick < 0.42) kind = 'grass';
    else if (pick < 0.62) kind = 'bush';
    else if (near && pick < 0.74) kind = 'moss';
    else if (near && pick < 0.8) kind = 'mushrooms';
    else if (ground === T.ROCKGRASS) kind = 'pebbles';
    else kind = 'grass';
    key = `${kind}:${ground}:${v}`;
    make = () => (kind === 'fern' ? fern(v, pal) : kind === 'bush' ? bush(v, pal, false) : kind === 'moss' ? moss(v, pal)
      : kind === 'mushrooms' ? mushrooms(v) : kind === 'pebbles' ? pebbles(v, ['#5e5e66', '#9a9aa4']) : grass(v, tones));
  } else if (ground === T.FENMOSS || ground === T.PEAT) {
    if (r >= (wet ? 0.4 : near ? 0.3 : 0.12)) return null;
    kind = wet && r < 0.25 ? 'reeds' : r < 0.1 ? 'fern' : 'grass';
    key = `${kind}:fen:${v}`;
    make = () => (kind === 'reeds' ? reeds(v) : kind === 'fern' ? fern(v, LEAVES.fen[v % 2]) : grass(v, GRASS_TONES.fen));
  } else if (ground === T.SNOW) {
    if (r >= (near ? 0.12 : 0.04)) return null;
    kind = r < 0.03 ? 'bush' : 'grass';
    key = `${kind}:snow:${v}`;
    make = () => (kind === 'bush' ? bush(v, LEAVES.deep[v % 3], true) : grass(v, GRASS_TONES.snow));
  } else if (ground === T.SAND || ground === T.SAND2) {
    if (r >= 0.035) return null;
    kind = r < 0.02 ? 'grass' : 'pebbles';
    key = `${kind}:sand:${v}`;
    make = () => (kind === 'grass' ? grass(v, GRASS_TONES.dry) : pebbles(v, ['#a08860', '#d8c08c']));
  } else {
    return null;
  }
  let c = decorCache.get(key);
  if (!c) decorCache.set(key, (c = make()));
  return { canvas: c, ox: Math.min(ox, 16 - c.width + 3), oy: Math.min(oy, 16 - c.height + 2) };
}

// --- Which one stands where -------------------------------------------------------------------

/** Forms of broadleaf trees by biome: [form, weight, leaves]. All in the same soft greens. */
const TREE_KINDS = {
  plains: [['round', 5, 'lush'], ['oak', 3, 'lush'], ['twin', 2, 'lush'], ['young', 2, 'lush'], ['bushy', 2, 'lush']],
  forest: [['oak', 5, 'deep'], ['round', 4, 'deep'], ['twin', 3, 'deep'], ['bushy', 1, 'deep'], ['young', 1, 'lush']],
  highlands: [['round', 3, 'sage'], ['windswept', 2, 'sage'], ['bushy', 2, 'sage'], ['young', 1, 'sage']],
  fen: [['swamp', 5, 'fen'], ['bushy', 1, 'fen']],
  skyreach: [['windswept', 4, 'sky'], ['round', 2, 'sky'], ['young', 1, 'sky']],
};

function pickWeighted(list, r) {
  let total = 0;
  for (const k of list) total += k[1];
  let x = r * total;
  for (const k of list) {
    if (x < k[1]) return k;
    x -= k[1];
  }
  return list[0];
}

const cache = new Map();

function cached(key, make) {
  let v = cache.get(key);
  if (!v) cache.set(key, (v = make()));
  return v;
}

function flipped(canvas) {
  const c = createCanvas(canvas.width, canvas.height);
  const ctx = ctx2d(c);
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

/** Places a sprite with its foot at the bottom middle of the tile (16 px wide). */
function stand(canvas, sink = 0) {
  return { canvas, ox: 8 - (canvas.width >> 1), oy: 16 - canvas.height + sink };
}

/**
 * The sprite for a standing tile: { canvas, ox, oy (its top-left from the
 * tile's top-left), shadow: [dx, dy, rx, ry] (on the ground, from the tile's
 * top-left), sway (it moves when walked through) }. The same tile always
 * gets the same one. `style` 'classic' keeps the original look.
 */
export function standingSprite(id, tx, ty, ground, biome, style = 'rich') {
  const h = hashInts(tx, ty, 0x7ee5);
  const r = (h % 1000) / 1000;
  const flip = (h >>> 10) & 1;
  const v = (h >>> 11) & 3;
  if (style === 'classic') {
    return cached(`c${id}:${v}`, () => ({ ...stand(tileCanvas(id, v, true)), shadow: null, sway: SWAYS.has(id) }));
  }
  const snowy = ground === T.SNOW || ground === T.ICE;
  const green = ground === T.GRASS || ground === T.MOSS || ground === T.FLOWERS;
  const size = r < 0.22 ? 0 : r < 0.8 ? 1 : 2;
  const rng = () => createRng(h);
  if (id === T.TREE) {
    const [form, , leaves] = pickWeighted(TREE_KINDS[biome] ?? TREE_KINDS.plains, ((h >>> 13) % 997) / 997);
    const pals = LEAVES[leaves] ?? LEAVES.lush;
    const pi = (h >>> 3) % pals.length;
    // (Saplings and bushy trees are never the biggest.)
    const sz = form === 'young' ? Math.min(size, 1) : size;
    const key = `t:${form}:${sz}:${leaves}:${pi}:${v}:${flip}`;
    return cached(key, () => {
      const c = broadleaf(form, sz, pals[pi], createRng(0x7e3 + v * 97 + sz * 13 + pi * 7 + form.length));
      const w = Math.round(c.width * 0.36);
      return { ...stand(flip ? flipped(c) : c, 1), shadow: [8, 14, w, [3, 4, 5][sz]], sway: true };
    });
  }
  if (id === T.PINE) {
    const narrow = (h >>> 9) % 3 === 0;
    return cached(`p:${size}:${snowy ? 1 : 0}:${narrow ? 1 : 0}:${v}:${flip}`, () => {
      const c = pine(size, snowy, narrow, createRng(0x9a1 + v * 53 + size));
      return { ...stand(flip ? flipped(c) : c), shadow: [8, 15, [6, 8, 10][size] - (narrow ? 2 : 0), 3], sway: true };
    });
  }
  if (id === T.PALM) {
    const dir = flip ? 1 : -1;
    return cached(`m:${size}:${dir}:${v}`, () => ({ ...stand(palm(size, dir, rng())), shadow: [8 + dir * 3, 14, 8, 3], sway: true }));
  }
  if (id === T.CACTUS) {
    const form = ['saguaro', 'saguaro', 'column', 'barrel'][v];
    return cached(`k:${form}:${flip}:${v}`, () => {
      const c = cactus(form, rng());
      return { ...stand(flip ? flipped(c) : c), shadow: [8, 15, form === 'barrel' ? 6 : 5, 2], sway: false };
    });
  }
  if (id === T.ROCK) {
    const flat = (h >>> 9) % 4 === 0;
    const rs = r < 0.3 ? 0 : r < 0.85 ? 1 : 2;
    return cached(`r:${rs}:${flat ? 1 : 0}:${green ? 1 : 0}:${v}:${flip}`, () => {
      const c = boulder(rs, flat, green, rng());
      return { ...stand(flip ? flipped(c) : c, 1), shadow: [8, 14, [6, 8, 11][rs], 3], sway: false };
    });
  }
  // Crystals, ore, ruins, plants and the like keep their own art.
  return cached(`o${id}:${v}`, () => ({ ...stand(tileCanvas(id, v, true)), shadow: [8, 14, 6, 2], sway: false }));
}

/** Clears the sprite cache (after a change of style). */
export function clearStanding() {
  cache.clear();
}
