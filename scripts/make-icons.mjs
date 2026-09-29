#!/usr/bin/env node
// Generates the app icons (PNG in many sizes, maskable variants, Apple touch
// icon, favicon and an SVG) from one pixel-art design. No dependencies: a
// tiny PNG encoder built on node:zlib.
//
//   node scripts/make-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const G = 24; // design grid
const BG = [22, 22, 34, 255];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const C = {
  outline: hex('#0b0b14'),
  bladeLight: hex('#fff7e0'),
  blade: hex('#ffc860'),
  bladeDark: hex('#e0782a'),
  guard: hex('#9a5cff'),
  guardLight: hex('#cdb2ff'),
  handle: hex('#7a4a2a'),
  handleDark: hex('#4a2a18'),
  gem: hex('#7ae0ff'),
  glow: [255, 170, 60],
};

function design() {
  const px = Array.from({ length: G }, () => new Array(G).fill(null));
  const set = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < G && y < G) px[y][x] = c;
  };
  // Blade: diagonal from bottom-left to top-right.
  for (let i = 0; i < 13; i++) {
    const x = 8 + i;
    const y = 15 - i;
    set(x, y, C.blade);
    set(x - 1, y, C.bladeLight);
    set(x, y + 1, C.bladeDark);
  }
  set(20, 2, C.bladeLight);
  set(21, 2, C.bladeLight);
  // Guard (perpendicular to the blade).
  for (let k = -3; k <= 3; k++) set(7 + k, 16 + k, Math.abs(k) === 3 ? C.guardLight : C.guard);
  set(7, 16, C.gem);
  // Handle and pommel.
  for (let i = 1; i <= 4; i++) {
    set(7 - i, 16 + i, i % 2 ? C.handle : C.handleDark);
    set(6 - i, 16 + i, i % 2 ? C.handleDark : C.handle);
  }
  set(2, 21, C.guard);
  set(1, 21, C.guardLight);
  set(2, 22, C.guardLight);
  // Outline pass.
  const marks = [];
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      if (px[y][x]) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => px[y + dy]?.[x + dx] && px[y + dy][x + dx] !== C.outline);
      if (n) marks.push([x, y]);
    }
  }
  for (const [x, y] of marks) px[y][x] = C.outline;
  return px;
}

const art = design();

/** Renders the icon into an RGBA buffer. `inset` = fraction of padding. */
function render(size, { inset = 0.12, rounded = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const r = rounded ? size * 0.18 : 0;
  const artSize = size * (1 - inset * 2);
  const cell = artSize / G;
  const off = size * inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded-square background (full bleed when not rounded, for maskable).
      const cx = Math.max(r - x, 0, x - (size - 1 - r));
      const cy = Math.max(r - y, 0, y - (size - 1 - r));
      if (rounded && cx * cx + cy * cy > r * r) continue;
      // Warm glow behind the sword.
      const dx = (x - size * 0.55) / size;
      const dy = (y - size * 0.45) / size;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.4);
      buf[i] = Math.round(BG[0] + (C.glow[0] - BG[0]) * glow * 0.45);
      buf[i + 1] = Math.round(BG[1] + (C.glow[1] - BG[1]) * glow * 0.3);
      buf[i + 2] = Math.round(BG[2] + (C.glow[2] - BG[2]) * glow * 0.15);
      buf[i + 3] = 255;
      const gx = Math.floor((x - off) / cell);
      const gy = Math.floor((y - off) / cell);
      const c = art[gy]?.[gx];
      if (c) {
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
      }
    }
  }
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(name, size, opts) {
  writeFileSync(join(outDir, name), encodePng(size, render(size, opts)));
  console.log(`icons/${name}`);
}

for (const size of [72, 96, 128, 144, 192, 256, 384, 512]) writePng(`icon-${size}.png`, size);
// Maskable: full-bleed background, art kept inside the 80% safe zone.
for (const size of [192, 512]) writePng(`maskable-${size}.png`, size, { inset: 0.2, rounded: false });
writePng('apple-touch-icon.png', 180, { inset: 0.14, rounded: false });
writePng('favicon-32.png', 32, { inset: 0.02 });

// Crisp vector favicon built from the same grid (horizontal runs merged).
const rects = [];
for (let y = 0; y < G; y++) {
  let x = 0;
  while (x < G) {
    const c = art[y][x];
    if (!c) {
      x++;
      continue;
    }
    let w = 1;
    while (x + w < G && art[y][x + w] === c) w++;
    rects.push(`<rect x="${x + 2}" y="${y + 2}" width="${w}" height="1" fill="rgb(${c[0]},${c[1]},${c[2]})"/>`);
    x += w;
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" shape-rendering="crispEdges"><rect width="28" height="28" rx="5" fill="rgb(${BG[0]},${BG[1]},${BG[2]})"/>${rects.join('')}</svg>\n`;
writeFileSync(join(outDir, 'icon.svg'), svg);
console.log('icons/icon.svg');
