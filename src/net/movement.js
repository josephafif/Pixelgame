// Player movement, shared by the server (authoritative) and the client
// (prediction). Both run exactly this code with exactly these inputs, so
// the client's guess of where you are matches the server almost always and
// corrections are rare and tiny.
//
// Only operations that give bit-identical results in every JavaScript
// engine are used (+, *, /, Math.sqrt, comparisons) — no Math.hypot/exp.

export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
export const PLAYER_RADIUS = 0.32;
// exp(-10 / 30): how much knockback is left after one tick.
const KNOCK_DAMP = 0.7165313105737893;

/** Joystick/keyboard axis (-1..1) → the int8 sent on the wire. */
export function quantizeAxis(v) {
  const n = Math.round(Math.max(-1, Math.min(1, v)) * 127);
  return n === 0 ? 0 : n; // never -0
}

/** The direction an input frame asks for (length ≤ 1). */
export function inputDirection(mx, my) {
  let x = mx / 127;
  let y = my / 127;
  const len2 = x * x + y * y;
  if (len2 > 1) {
    const len = Math.sqrt(len2);
    x /= len;
    y /= len;
  }
  return { x, y };
}

/**
 * Advances a mover by one tick. `s` is { x, y, kx, ky } and is updated in
 * place; `speed` is the walking speed (tiles/s) and `sprintMult` applies
 * while the sprint button is held. Returns true when it moved.
 */
export function stepMove(world, s, frame, speed, sprintMult, r = PLAYER_RADIUS, mode = 'player') {
  const dir = inputDirection(frame.mx, frame.my);
  const sprinting = (frame.buttons & 2) !== 0;
  const v = speed * (sprinting ? sprintMult : 1);
  const vx = dir.x * v + s.kx;
  const vy = dir.y * v + s.ky;
  s.kx *= KNOCK_DAMP;
  s.ky *= KNOCK_DAMP;
  if (s.kx * s.kx + s.ky * s.ky < 1e-6) {
    s.kx = 0;
    s.ky = 0;
  }
  const x0 = s.x;
  const y0 = s.y;
  slideMove(world, s, vx * TICK_DT, vy * TICK_DT, r, mode);
  return s.x !== x0 || s.y !== y0;
}

/**
 * Moves `s` by (dx, dy), one axis at a time so you slide along walls. When
 * you walk straight into the edge of a tree, a rock or a wall's corner,
 * you slip around it instead of stopping dead.
 */
export function slideMove(world, s, dx, dy, r, mode = 'player') {
  const nx = s.x + dx;
  if (world.isFree(nx, s.y, r, mode)) s.x = nx;
  else if (dx !== 0 && (dy < 0 ? -dy : dy) < (dx < 0 ? -dx : dx) * 0.5) slip(world, s, dx, 0, r, mode);
  const ny = s.y + dy;
  if (world.isFree(s.x, ny, r, mode)) s.y = ny;
  else if (dy !== 0 && (dx < 0 ? -dx : dx) < (dy < 0 ? -dy : dy) * 0.5) slip(world, s, 0, dy, r, mode);
}

// How far to the side an opening may be for you to slip towards it (tiles).
const SLIP_MAX = 0.45;

/**
 * Blocked going (dx, dy) along one axis: if there is an opening just to
 * the side (the round edge of a trunk, a wall's corner), step sideways
 * towards the nearest one. A straight wall has none, so you stop there.
 */
function slip(world, s, dx, dy, r, mode) {
  const step = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
  const inc = step > 0.05 ? step : 0.05;
  let best = 0;
  let bestK = SLIP_MAX + 1;
  for (const sgn of [1, -1]) {
    for (let k = inc; k <= SLIP_MAX; k += inc) {
      const ox = dx === 0 ? sgn * k : 0;
      const oy = dy === 0 ? sgn * k : 0;
      if (world.isFree(s.x + ox + dx, s.y + oy + dy, r, mode)) {
        if (k < bestK) {
          bestK = k;
          best = sgn;
        }
        break;
      }
    }
  }
  if (!best) return false;
  const ox = dx === 0 ? best * step : 0;
  const oy = dy === 0 ? best * step : 0;
  if (!world.isFree(s.x + ox, s.y + oy, r, mode)) return false;
  s.x += ox;
  s.y += oy;
  return true;
}
