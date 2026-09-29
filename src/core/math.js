// Small vector/geometry helpers used by the runtime (not by deterministic
// generation, so transcendental functions are fine here).

export const TAU = Math.PI * 2;

export function dist2(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function dist(ax, ay, bx, by) {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

export function angleTo(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

/** Smallest signed difference between two angles, in (-PI, PI]. */
export function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function normalize(x, y) {
  const len = Math.hypot(x, y);
  return len > 1e-6 ? { x: x / len, y: y / len, len } : { x: 0, y: 0, len: 0 };
}

export function approach(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  return Math.max(target, value - step);
}

export function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/** Point-to-segment distance squared. */
export function segmentDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist2(px, py, ax + vx * t, ay + vy * t);
}
