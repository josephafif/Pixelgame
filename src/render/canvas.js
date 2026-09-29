// Canvas helpers shared by all procedural art.

export function createCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

export function ctx2d(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * Builds a sprite from a character map. '.' is transparent; every other
 * character is looked up in `palette`. Rows of the wrong length are padded
 * or cut so a typo only costs a pixel, never a crash.
 */
export function spriteFromMap(map, palette) {
  const h = map.length;
  const w = Math.max(...map.map((r) => r.length));
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  for (let y = 0; y < h; y++) {
    const row = map[y].padEnd(w, '.');
    for (let x = 0; x < w; x++) {
      const color = palette[row[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

export function flipped(canvas) {
  const out = createCanvas(canvas.width, canvas.height);
  const ctx = ctx2d(out);
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/** Tinted copy (multiplies towards `color` by `amount`, keeps alpha). */
export function tinted(canvas, color, amount = 0.6) {
  const out = createCanvas(canvas.width, canvas.height);
  const ctx = ctx2d(out);
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = amount;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);
  return out;
}

/** Solid white silhouette, used for hit flashes. */
export function silhouette(canvas, color = '#ffffff') {
  return tinted(canvas, color, 1);
}

export function scaled(canvas, factor) {
  const out = createCanvas(canvas.width * factor, canvas.height * factor);
  const ctx = ctx2d(out);
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}
