// The Prism Warden's laser fields: parallel beams across the arena, a gap
// between each pair; they glow for a moment, then fire. In the second phase
// a second field crosses the first. Shared by single player and the server
// (same lines, same timing), so a fight plays the same in both.

const LEN = 13; // half the length of a beam
const GAP = 2.6; // between beams (room to stand)
export const LASER_WIDTH = 0.42; // half the width of a beam
export const LASER_COLORS = ['#7ae8ff', '#c09aff', '#ffd27a'];

/** The beams of one field around (tx, ty): [{ x, y, x2, y2, delay }]. */
export function laserField(tx, ty, phase, rng = Math.random) {
  const out = [];
  const sets = phase === 2 ? 2 : 1;
  const a0 = rng() * Math.PI;
  for (let s = 0; s < sets; s++) {
    const a = a0 + s * (Math.PI / 2);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // Beams side by side across the target, shifted so it has to move.
    const shift = (rng() - 0.5) * GAP;
    const n = phase === 2 ? 4 : 5;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * GAP + shift;
      const cx = tx - dy * off;
      const cy = ty + dx * off;
      out.push({ x: cx - dx * LEN, y: cy - dy * LEN, x2: cx + dx * LEN, y2: cy + dy * LEN, delay: 1.0 + s * 0.7, color: LASER_COLORS[i % 3] });
    }
  }
  return out;
}

/**
 * The Aether Roc's wind waves: fronts that sweep out from it towards
 * (tx, ty), one after another, each with the same calm gap to stand in.
 * [{ x, y, x2, y2, delay, dx, dy }] — (dx, dy) the way the wind throws you.
 */
export function windWave(bx, by, br, tx, ty, rng = Math.random) {
  const ax = tx - bx;
  const ay = ty - by;
  const d = Math.sqrt(ax * ax + ay * ay) || 1;
  const dx = ax / d;
  const dy = ay / d;
  const px = -dy;
  const py = dx;
  const gap = (rng() - 0.5) * 5; // where the calm lane is, across the front
  const half = 7;
  const out = [];
  for (let k = 0; k < 6; k++) {
    const dist = br + 1 + k * 1.6;
    const cx = bx + dx * dist;
    const cy = by + dy * dist;
    for (const [a, b] of [[-half, gap - 1.3], [gap + 1.3, half]]) {
      if (b - a < 0.5) continue;
      out.push({ x: cx + px * a, y: cy + py * a, x2: cx + px * b, y2: cy + py * b, delay: 0.6 + k * 0.18, dx, dy });
    }
  }
  return out;
}
