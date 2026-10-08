// HD pixel art. The game is drawn into a buffer at twice its art resolution,
// and every small sprite that is drawn again and again gets a smoothed copy
// at twice its size (Scale2x, also called EPX): diagonal edges get their
// in-between steps, but every colour stays exactly one of the art's own, so
// it still looks like pixel art, only finer. No art is redrawn by hand.

const cache = new WeakMap();
const MAX_PIXELS = 160 * 160; // bigger canvases (world chunks) are drawn as they are
const MIN_USES = 3; // canvases drawn only once or twice (temporary ones) are left alone
const PER_FRAME = 24; // conversions per frame, so a screenful of new sprites never stutters

let budget = PER_FRAME;

/** Call once per frame. */
export function hdFrame() {
  budget = PER_FRAME;
}

function isCanvas(img) {
  return img && typeof img.getContext === 'function' && img.width > 1 && img.height > 1;
}

function newCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

/**
 * Scale2x of RGBA pixels: `src` w×h → a new 2w×2h array. Fully transparent
 * pixels count as one colour whatever their RGB, so outlines stay clean.
 */
export function scale2xPixels(src, w, h) {
  const inp = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const px = new Uint32Array(w * h);
  // Little-endian RGBA in a Uint32: alpha is the top byte.
  for (let i = 0; i < px.length; i++) px[i] = inp[i] >>> 24 === 0 ? 0 : inp[i];
  const out = new Uint32Array(w * 2 * h * 2);
  const W2 = w * 2;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = (y > 0 ? y - 1 : y) * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const p = px[row + x];
      const a = px[up + x];
      const d = px[down + x];
      const c = px[row + (x > 0 ? x - 1 : x)];
      const b = px[row + (x < w - 1 ? x + 1 : x)];
      let e0 = p;
      let e1 = p;
      let e2 = p;
      let e3 = p;
      if (a !== d && c !== b) {
        if (c === a) e0 = a;
        if (a === b) e1 = b;
        if (c === d) e2 = c;
        if (d === b) e3 = d;
      }
      const o = y * 2 * W2 + x * 2;
      out[o] = e0;
      out[o + 1] = e1;
      out[o + W2] = e2;
      out[o + W2 + 1] = e3;
    }
  }
  return new Uint8ClampedArray(out.buffer);
}

/** Scale3x (AdvMAME3x) of RGBA pixels: `src` w×h → a new 3w×3h array. */
export function scale3xPixels(src, w, h) {
  const inp = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const px = new Uint32Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = inp[i] >>> 24 === 0 ? 0 : inp[i];
  const out = new Uint32Array(w * 3 * h * 3);
  const W3 = w * 3;
  const at = (x, y) => px[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const A = at(x - 1, y - 1);
      const B = at(x, y - 1);
      const C = at(x + 1, y - 1);
      const D = at(x - 1, y);
      const E = px[y * w + x];
      const F = at(x + 1, y);
      const G = at(x - 1, y + 1);
      const H = at(x, y + 1);
      const I = at(x + 1, y + 1);
      let e0 = E; let e1 = E; let e2 = E;
      let e3 = E; let e5 = E;
      let e6 = E; let e7 = E; let e8 = E;
      if (B !== H && D !== F) {
        e0 = D === B ? D : E;
        e1 = (D === B && E !== C) || (B === F && E !== A) ? B : E;
        e2 = B === F ? F : E;
        e3 = (D === B && E !== G) || (D === H && E !== A) ? D : E;
        e5 = (B === F && E !== I) || (H === F && E !== C) ? F : E;
        e6 = D === H ? D : E;
        e7 = (D === H && E !== I) || (H === F && E !== G) ? H : E;
        e8 = H === F ? F : E;
      }
      const o = y * 3 * W3 + x * 3;
      out[o] = e0; out[o + 1] = e1; out[o + 2] = e2;
      out[o + W3] = e3; out[o + W3 + 1] = E; out[o + W3 + 2] = e5;
      out[o + 2 * W3] = e6; out[o + 2 * W3 + 1] = e7; out[o + 2 * W3 + 2] = e8;
    }
  }
  return new Uint8ClampedArray(out.buffer);
}

/** A smoothed copy of a canvas at `factor` (2 or 3) times its size. */
export function scaleNx(canvas, factor = 2) {
  const w = canvas.width;
  const h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = newCanvas(w * factor, h * factor);
  const pixels = factor === 3 ? scale3xPixels(data, w, h) : scale2xPixels(data, w, h);
  out.getContext('2d').putImageData(new ImageData(pixels, w * factor, h * factor), 0, 0);
  return out;
}

/** A 2× smoothed copy of a canvas. */
export function scale2x(canvas) {
  return scaleNx(canvas, 2);
}

function hdOf(img, factor) {
  if (!isCanvas(img)) return null;
  let e = cache.get(img);
  if (!e) {
    e = { uses: 0, hd: null, factor: 0, w: img.width, h: img.height };
    cache.set(img, e);
  }
  if (e.hd && e.factor === factor && e.w === img.width && e.h === img.height) return e.hd;
  if (e.w !== img.width || e.h !== img.height) {
    // Resized: it isn't a fixed sprite after all.
    e.hd = null;
    e.uses = -1e9;
    return null;
  }
  e.uses++;
  if (e.uses < MIN_USES || budget <= 0 || img.width * img.height > MAX_PIXELS) return null;
  budget--;
  try {
    e.hd = scaleNx(img, factor);
    e.factor = factor;
  } catch {
    e.uses = -1e9; // unreadable (tainted): never try again
    return null;
  }
  return e.hd;
}

/**
 * Makes `ctx` draw sprites from their smoothed copies at `factor` (2 or 3)
 * times their size. All drawing code keeps working in art pixels: the copy
 * is drawn at the original size, so under a `factor`× transform each of its
 * pixels lands on one buffer pixel.
 */
export function installHd(ctx, factor = 2) {
  ctx.hdFactor = factor;
  if (Object.hasOwn(ctx, 'drawImage')) return;
  const native = Object.getPrototypeOf(ctx).drawImage;
  ctx.drawImage = function drawImage(img, ...a) {
    const k = this.hdFactor;
    const hd = hdOf(img, k);
    if (!hd) return native.call(this, img, ...a);
    if (a.length === 2) return native.call(this, hd, a[0], a[1], img.width, img.height);
    if (a.length === 4) return native.call(this, hd, a[0], a[1], a[2], a[3]);
    if (a.length === 8) return native.call(this, hd, a[0] * k, a[1] * k, a[2] * k, a[3] * k, a[4], a[5], a[6], a[7]);
    return native.call(this, img, ...a);
  };
}

/** Back to plain drawing (classic pixels). */
export function uninstallHd(ctx) {
  if (Object.hasOwn(ctx, 'drawImage')) delete ctx.drawImage;
}
