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
  const nx = s.x + vx * TICK_DT;
  if (world.isFree(nx, s.y, r, mode)) s.x = nx;
  const ny = s.y + vy * TICK_DT;
  if (world.isFree(s.x, ny, r, mode)) s.y = ny;
  return s.x !== x0 || s.y !== y0;
}
