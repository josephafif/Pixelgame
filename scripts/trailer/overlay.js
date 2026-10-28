// The trailer's titles, drawn on a canvas over the game (director.js calls
// these every frame): letterbox bars, the big titles, place and power
// labels, boss cards, the logo and the end card, fades and flashes. All in
// the game's own pixel font, Pixelify Sans.

const FONT = '"Pixelify Sans", monospace';
const GOLD = ['#fff6c8', '#ffd24a', '#e08a1a'];
const INK = '#120f1c';

export const ease = {
  out: (t) => 1 - (1 - t) ** 3,
  in: (t) => t * t * t,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2,
};
export const clamp01 = (t) => Math.max(0, Math.min(1, t));

/** 0 → 1 over [a, b] (eased), for fading things in and out. */
export function ramp(t, a, b, fn = ease.out) {
  return fn(clamp01((t - a) / (b - a)));
}

/** In over `inT`, held, out over `outT` before `dur`. */
export function envelope(t, dur, inT = 0.35, outT = 0.35) {
  return Math.min(ramp(t, 0, inT), 1 - ramp(t, dur - outT, dur, ease.in));
}

export class Overlay {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'trailer-ov';
    document.body.append(this.canvas);
    this.resize();
  }

  resize() {
    this.W = this.canvas.width = innerWidth;
    this.H = this.canvas.height = innerHeight;
    this.ctx = this.canvas.getContext('2d');
    this.u = this.H / 1080; // one "design pixel" (the trailer is laid out at 1080p)
  }

  clear() {
    this.ctx.clearRect(0, 0, this.W, this.H);
  }

  font(px, weight = 700) {
    return `${weight} ${Math.round(px * this.u)}px ${FONT}`;
  }

  /** Text with a hard outline and a drop shadow; `fill` may be a gradient spec. */
  text(str, x, y, { px = 64, weight = 700, fill = '#ffffff', align = 'center', alpha = 1, outline = 8, shadow = 6, spacing = 0, glow = null } = {}) {
    const c = this.ctx;
    const u = this.u;
    c.save();
    c.globalAlpha = alpha;
    c.font = this.font(px, weight);
    c.textAlign = align;
    c.textBaseline = 'alphabetic';
    c.letterSpacing = `${Math.round(spacing * u)}px`;
    c.lineJoin = 'round';
    if (shadow) {
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fillText(str, x + shadow * u, y + shadow * u);
    }
    if (outline) {
      c.strokeStyle = INK;
      c.lineWidth = outline * u;
      c.strokeText(str, x, y);
    }
    if (glow) {
      c.shadowColor = glow;
      c.shadowBlur = 28 * u;
    }
    if (Array.isArray(fill)) {
      const g = c.createLinearGradient(0, y - px * u * 0.8, 0, y + px * u * 0.1);
      fill.forEach((col, i) => g.addColorStop(i / (fill.length - 1), col));
      c.fillStyle = g;
    } else {
      c.fillStyle = fill;
    }
    c.fillText(str, x, y);
    c.restore();
    return c.measureText(str).width;
  }

  measure(str, px, weight = 700, spacing = 0) {
    const c = this.ctx;
    c.save();
    c.font = this.font(px, weight);
    c.letterSpacing = `${Math.round(spacing * this.u)}px`;
    const w = c.measureText(str).width;
    c.restore();
    return w;
  }

  /** Cinematic black bars (0 = none, 1 = full). */
  letterbox(k = 1) {
    if (k <= 0) return;
    const c = this.ctx;
    const h = Math.round(92 * this.u * k);
    c.fillStyle = '#000';
    c.fillRect(0, 0, this.W, h);
    c.fillRect(0, this.H - h, this.W, h);
  }

  fill(color, alpha) {
    if (alpha <= 0) return;
    const c = this.ctx;
    c.save();
    c.globalAlpha = Math.min(1, alpha);
    c.fillStyle = color;
    c.fillRect(0, 0, this.W, this.H);
    c.restore();
  }

  /** A soft darkening towards the bottom (under titles). */
  shade(alpha = 0.6, from = 0.55) {
    if (alpha <= 0) return;
    const c = this.ctx;
    const g = c.createLinearGradient(0, this.H * from, 0, this.H);
    g.addColorStop(0, 'rgba(8,6,16,0)');
    g.addColorStop(1, `rgba(8,6,16,${alpha})`);
    c.fillStyle = g;
    c.fillRect(0, this.H * from, this.W, this.H * (1 - from));
  }

  vignette(alpha = 0.5) {
    const c = this.ctx;
    const g = c.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.35, this.W / 2, this.H / 2, this.H * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${alpha})`);
    c.fillStyle = g;
    c.fillRect(0, 0, this.W, this.H);
  }

  /** The big title: rises in letter by letter, a gold rule under it, the line below. */
  title(text, sub, t, dur) {
    const u = this.u;
    const k = envelope(t, dur, 0.45, 0.4);
    if (k <= 0) return;
    const cx = this.W / 2;
    const y = this.H - 205 * u;
    this.shade(0.75 * k, 0.5);
    const upper = text.toUpperCase();
    const px = 78;
    const spacing = 6 + 10 * (1 - ramp(t, 0, 0.9));
    const w = this.measure(upper, px, 700, spacing);
    // Letters arrive one after another.
    let x = cx - w / 2;
    for (let i = 0; i < upper.length; i++) {
      const ch = upper[i];
      const cw = this.measure(ch, px, 700, spacing);
      const a = Math.min(ramp(t, i * 0.025, i * 0.025 + 0.3), 1 - ramp(t, dur - 0.4, dur, ease.in));
      const dy = (1 - ramp(t, i * 0.025, i * 0.025 + 0.4, ease.back)) * 36 * u;
      if (a > 0) this.text(ch, x, y + dy, { px, fill: GOLD, align: 'left', alpha: a, spacing, outline: 10, shadow: 7 });
      x += cw;
    }
    // The rule, growing from the middle.
    const rw = (w * 0.5 + 60 * u) * ramp(t, 0.15, 0.75);
    const c = this.ctx;
    c.save();
    c.globalAlpha = k;
    const g = c.createLinearGradient(cx - rw, 0, cx + rw, 0);
    g.addColorStop(0, 'rgba(255,210,74,0)');
    g.addColorStop(0.5, 'rgba(255,224,120,1)');
    g.addColorStop(1, 'rgba(255,210,74,0)');
    c.fillStyle = g;
    c.fillRect(cx - rw, y + 22 * u, rw * 2, 4 * u);
    c.restore();
    if (sub) this.text(sub, cx, y + 74 * u, { px: 36, weight: 500, fill: '#f2ecff', alpha: Math.min(k, ramp(t, 0.35, 0.8)), outline: 7, shadow: 4 });
  }

  /** A place (or power, or boss) name in the upper left. */
  label(text, kind, t, dur) {
    const u = this.u;
    const k = envelope(t, dur, 0.3, 0.25);
    if (k <= 0) return;
    const slide = (1 - ramp(t, 0, 0.45)) * -60 * u;
    const x = 96 * u + slide;
    const y = 92 * u + (kind === 'place' || !kind ? 98 : 124) * u;
    const c = this.ctx;
    if (kind === 'boss') {
      // A boss card: a red banner with the name in gold, "BOSS" above.
      const name = text.toUpperCase();
      const w = this.measure(name, 64, 700, 3) + 70 * u;
      c.save();
      c.globalAlpha = k * 0.85;
      const g = c.createLinearGradient(x - 30 * u, 0, x + w + 120 * u, 0);
      g.addColorStop(0, 'rgba(120,14,24,0.95)');
      g.addColorStop(0.7, 'rgba(70,8,16,0.75)');
      g.addColorStop(1, 'rgba(70,8,16,0)');
      c.fillStyle = g;
      c.fillRect(x - 30 * u, y - 84 * u, w + 150 * u, 112 * u);
      c.fillStyle = '#ffd24a';
      c.fillRect(x - 30 * u, y - 84 * u, 6 * u, 112 * u);
      c.restore();
      this.text('BOSS', x, y - 52 * u, { px: 28, fill: '#ff8a7a', align: 'left', alpha: k, outline: 5, shadow: 3, spacing: 8 });
      this.text(name, x, y + 4 * u, { px: 64, fill: GOLD, align: 'left', alpha: k, outline: 9, shadow: 6, spacing: 3 });
      return;
    }
    const power = kind === 'power';
    const head = power ? 'LEGENDARY POWER' : null;
    const name = text.toUpperCase();
    // A diamond marker and the name.
    c.save();
    c.globalAlpha = k;
    c.translate(x + 14 * u, y - 18 * u);
    c.rotate(Math.PI / 4);
    c.fillStyle = INK;
    c.fillRect(-14 * u, -14 * u, 28 * u, 28 * u);
    c.fillStyle = power ? '#ffd24a' : '#8fe3ff';
    c.fillRect(-9 * u, -9 * u, 18 * u, 18 * u);
    c.restore();
    if (head) this.text(head, x + 46 * u, y - 52 * u, { px: 26, fill: '#ffe9a0', align: 'left', alpha: k, outline: 5, shadow: 3, spacing: 6 });
    this.text(name, x + 46 * u, y, { px: power ? 58 : 46, fill: power ? GOLD : '#ffffff', align: 'left', alpha: k, outline: 8, shadow: 5, spacing: 3 });
  }

  /** PIXELGAME / INFINITE ARSENAL, with a sweep of light across it. */
  logo(t, { y = this.H * 0.44, scale = 1, alpha = 1, tagline = null } = {}) {
    const u = this.u;
    const c = this.ctx;
    const k = alpha * ramp(t, 0, 0.25);
    if (k <= 0) return;
    const pop = 1 + (1 - ramp(t, 0, 0.6, ease.back)) * 0.35;
    const px = 170 * scale * pop;
    const cx = this.W / 2;
    // A burst of light behind it.
    c.save();
    c.globalAlpha = k * 0.55 * (0.8 + 0.2 * Math.sin(t * 3));
    const gl = c.createRadialGradient(cx, y - 40 * u, 0, cx, y - 40 * u, 620 * u * scale);
    gl.addColorStop(0, 'rgba(255,214,110,0.75)');
    gl.addColorStop(0.35, 'rgba(255,140,40,0.25)');
    gl.addColorStop(1, 'rgba(255,140,40,0)');
    c.fillStyle = gl;
    c.fillRect(0, 0, this.W, this.H);
    c.restore();
    this.text('PIXELGAME', cx, y, { px, fill: GOLD, alpha: k, outline: 16 * scale, shadow: 12 * scale, spacing: 10 * scale });
    // The sweep: a bright band clipped to the letters.
    const sweep = ((t - 0.35) % 3.2) / 1.1;
    if (sweep > 0 && sweep < 1) {
      const w = this.measure('PIXELGAME', px, 700, 10 * scale);
      const bx = cx - w / 2 + (w + 400 * u) * sweep - 200 * u;
      // (The letters are filled again with a gradient that is clear but for the band.)
      const g = c.createLinearGradient(bx - 120 * u, 0, bx + 120 * u, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.save();
      c.globalAlpha = k * 0.9;
      c.font = this.font(px);
      c.letterSpacing = `${Math.round(10 * scale * u)}px`;
      c.textAlign = 'center';
      c.fillStyle = g;
      c.fillText('PIXELGAME', cx, y);
      c.restore();
    }
    const sk = alpha * ramp(t, 0.3, 0.8);
    const sy = y + 92 * u * scale;
    // INFINITE ARSENAL between two blades of light.
    const sub = 'INFINITE ARSENAL';
    const sw = this.measure(sub, 64 * scale, 700, 22 * scale);
    const lw = 160 * u * scale * ramp(t, 0.4, 1);
    c.save();
    c.globalAlpha = sk;
    c.fillStyle = '#ffd24a';
    c.fillRect(cx - sw / 2 - 40 * u - lw, sy - 26 * u * scale, lw, 5 * u);
    c.fillRect(cx + sw / 2 + 40 * u, sy - 26 * u * scale, lw, 5 * u);
    c.restore();
    this.text(sub, cx, sy, { px: 64 * scale, fill: '#ffffff', alpha: sk, outline: 10 * scale, shadow: 6, spacing: 22 * scale });
    if (tagline) this.text(tagline, cx, sy + 84 * u * scale, { px: 38 * scale, weight: 500, fill: '#f2ecff', alpha: alpha * ramp(t, 0.8, 1.3), outline: 7, shadow: 4 });
  }

  /** A line of story text, centred, fading in and out. */
  line(text, t, dur, { y = this.H * 0.5, px = 54 } = {}) {
    const k = envelope(t, dur, 0.6, 0.6);
    if (k <= 0) return;
    const rise = (1 - ramp(t, 0, 1.2)) * 18 * this.u;
    this.text(text, this.W / 2, y + rise, { px, weight: 500, fill: '#fff8e6', alpha: k, outline: 8, shadow: 5, spacing: 2 });
  }

  /** Pixel sprites (a canvas), drawn crisp at `scale`. */
  sprite(canvas, x, y, scale, { alpha = 1, rot = 0, glow = null } = {}) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = alpha;
    c.imageSmoothingEnabled = false;
    c.translate(x, y);
    c.rotate(rot);
    if (glow) {
      c.shadowColor = glow;
      c.shadowBlur = 40 * this.u;
    }
    c.drawImage(canvas, (-canvas.width * scale) / 2, (-canvas.height * scale) / 2, canvas.width * scale, canvas.height * scale);
    c.restore();
  }

  /** A pixel frame (like the game's slots) in a colour. */
  frame(x, y, w, h, color, { alpha = 1, fillAlpha = 0.85, glow = false } = {}) {
    const c = this.ctx;
    const u = this.u;
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = `rgba(14,12,24,${fillAlpha})`;
    c.fillRect(x, y, w, h);
    if (glow) {
      c.shadowColor = color;
      c.shadowBlur = 26 * u;
    }
    c.strokeStyle = color;
    c.lineWidth = 5 * u;
    c.strokeRect(x + 2.5 * u, y + 2.5 * u, w - 5 * u, h - 5 * u);
    c.shadowBlur = 0;
    c.strokeStyle = INK;
    c.lineWidth = 3 * u;
    c.strokeRect(x - 1.5 * u, y - 1.5 * u, w + 3 * u, h + 3 * u);
    c.restore();
  }
}
