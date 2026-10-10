// Player movement, shared by the server (authoritative) and the client
// (prediction). Both run exactly this code with exactly these inputs, so
// the client's guess of where you are matches the server almost always and
// corrections are rare and tiny.
//
// Only operations that give bit-identical results in every JavaScript
// engine are used (+, *, /, Math.sqrt, comparisons) — no Math.hypot/exp.

import { T, WIND } from '../game/world.js';

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

// --- The ground underfoot -----------------------------------------------------------------

const NO_EFFECT = Object.freeze({ speed: 1, wx: 0, wy: 0 });
const BOG_FOOT = Object.freeze({ speed: 0.65, wx: 0, wy: 0 });
const BOG_HORSE = Object.freeze({ speed: 0.85, wx: 0, wy: 0 });
const WIND_PUSH = 3.4; // tiles per second along a current
const WIND_EFFECT = new Map([...WIND].map(([id, [dx, dy]]) => [id, Object.freeze({ speed: 1, wx: dx * WIND_PUSH, wy: dy * WIND_PUSH })]));

/**
 * How the ground under (x, y) changes walking: { speed (multiplier), wx, wy
 * (a push, tiles/s) }. The fen's bog slows you; Skyreach's wind currents
 * carry you along. Boats and flyers don't care.
 */
export function groundEffect(world, x, y, mode) {
  if (mode !== 'player' && mode !== 'horse') return NO_EFFECT;
  const g = world.groundAt?.(Math.floor(x), Math.floor(y));
  if (g === T.BOG) return mode === 'horse' ? BOG_HORSE : BOG_FOOT;
  return WIND_EFFECT.get(g) ?? NO_EFFECT;
}

// --- A horse's leap over the clouds ---------------------------------------------------------

export const LEAP_MIN = 1.2;
export const LEAP_MAX = 3.6; // the widest gap a horse clears (tiles, foot to foot)
export const LEAP_TIME = 0.45; // seconds in the air (how long it is drawn)

/** True when all that keeps a horse from standing at (x, y) is the sea of clouds. */
function onlyClouds(world, x, y, r) {
  const x0 = Math.floor(x - r);
  const x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r);
  const y1 = Math.floor(y + r);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (world.blockedFor(tx, ty, 'horse') && world.blockAt(tx, ty) !== T.SKY) return false;
    }
  }
  return true;
}

/**
 * On horseback, running into the sea of clouds: if there is free, solid
 * ground within LEAP_MAX straight ahead, and nothing but open sky in
 * between (no walls, no water), the horse leaps across. Returns true and
 * moves `s` to where it lands; `s.leap` = { x0, y0, t } for the drawing.
 */
export function tryLeap(world, s, dx, dy, r) {
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.25) return false;
  const len = Math.sqrt(len2);
  const nx = dx / len;
  const ny = dy / len;
  const edge = r + 0.3;
  if (world.blockAt(Math.floor(s.x + nx * edge), Math.floor(s.y + ny * edge)) !== T.SKY) return false;
  for (let d = LEAP_MIN; d <= LEAP_MAX; d += 0.2) {
    const lx = s.x + nx * d;
    const ly = s.y + ny * d;
    if (!world.isFree(lx, ly, r, 'horse')) {
      // Still (partly) over the clouds? Then keep looking further out; a wall or water ends it.
      if (!onlyClouds(world, lx, ly, r)) return false;
      continue;
    }
    s.leap = { x0: s.x, y0: s.y, t: 0 };
    s.x = lx;
    s.y = ly;
    return true;
  }
  return false;
}

// --- Gale Step: a quick dash ----------------------------------------------------------------

export const DASH_DIST = 3.2; // tiles
export const DASH_TIME = 0.22; // seconds you are out of reach (and drawn as a streak)
const DASH_STEPS = 8;
const DIAG = 0.7071067811865476;
// The eight ways to dash standing still (by the aim byte), exact in every engine.
const COMPASS = [[1, 0], [DIAG, DIAG], [0, 1], [-DIAG, DIAG], [-1, 0], [-DIAG, -DIAG], [0, -1], [DIAG, -DIAG]];

/**
 * Gale Step: dashes up to DASH_DIST the way the frame walks (or, standing
 * still, the way it aims), in small steps so walls, water and the edge of
 * the clouds stop you as they would walking. Returns true when it moved;
 * `s.dash` = { x0, y0 } for the drawing.
 */
export function dash(world, s, frame, r = PLAYER_RADIUS, mode = 'player') {
  let { x: ux, y: uy } = inputDirection(frame.mx, frame.my);
  const len2 = ux * ux + uy * uy;
  if (len2 < 0.04) {
    [ux, uy] = COMPASS[((frame.aim ?? 0) + 16 >> 5) & 7];
  } else {
    const len = Math.sqrt(len2);
    ux /= len;
    uy /= len;
  }
  const x0 = s.x;
  const y0 = s.y;
  const step = DASH_DIST / DASH_STEPS;
  for (let i = 0; i < DASH_STEPS; i++) slideMove(world, s, ux * step, uy * step, r, mode);
  if (s.x === x0 && s.y === y0) return false;
  s.kx = 0;
  s.ky = 0;
  s.dash = { x0, y0 };
  return true;
}

/**
 * Advances a mover by one tick. `s` is { x, y, kx, ky } and is updated in
 * place; `speed` is the walking speed (tiles/s) and `sprintMult` applies
 * while the sprint button is held. Returns true when it moved.
 */
export function stepMove(world, s, frame, speed, sprintMult, r = PLAYER_RADIUS, mode = 'player') {
  const dir = inputDirection(frame.mx, frame.my);
  const sprinting = (frame.buttons & 2) !== 0;
  const ground = groundEffect(world, s.x, s.y, mode);
  const v = speed * (sprinting ? sprintMult : 1) * ground.speed;
  const vx = dir.x * v + s.kx + ground.wx;
  const vy = dir.y * v + s.ky + ground.wy;
  s.kx *= KNOCK_DAMP;
  s.ky *= KNOCK_DAMP;
  if (s.kx * s.kx + s.ky * s.ky < 1e-6) {
    s.kx = 0;
    s.ky = 0;
  }
  const x0 = s.x;
  const y0 = s.y;
  slideMove(world, s, vx * TICK_DT, vy * TICK_DT, r, mode);
  // A horse that ran into the clouds leaps the gap if it can.
  if (mode === 'horse' && (dir.x || dir.y)) {
    const moved = (s.x - x0) * (s.x - x0) + (s.y - y0) * (s.y - y0);
    if (moved < v * TICK_DT * v * TICK_DT * 0.25) tryLeap(world, s, dir.x, dir.y, r);
  }
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
