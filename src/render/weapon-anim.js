// Weapon animation poses. Every attack has three phases:
//   wind-up (anticipation) → strike (fast, eased) → follow-through/recover
// Swings alternate direction on each attack for a combo feel, slams raise
// the weapon overhead first, thrusts pull back before lunging, and ranged
// weapons kick back with recoil. The damage lands at `impact` (see
// IMPACT_AT), so what you see and what hits line up.
//
// Pure functions: easy to test and shared by the renderer and combat.

const TAU = Math.PI * 2;

export const MELEE_PATTERNS = new Set(['swing', 'thrust', 'slam', 'lash']);

/** Fraction of the animation at which the hit happens. */
export const IMPACT_AT = { swing: 0.3, lash: 0.28, thrust: 0.34, slam: 0.5 };

export function impactDelay(pattern, dur) {
  return (IMPACT_AT[pattern] ?? 0) * dur;
}

/** Animation length for an attack, derived from attack speed. */
export function attackDuration(pattern, attackSpeed) {
  const base = pattern === 'slam' ? 1.05 : MELEE_PATTERNS.has(pattern) ? 0.85 : 0.6;
  return Math.max(0.14, Math.min(pattern === 'slam' ? 0.48 : 0.36, base / attackSpeed));
}

const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInQuad = (t) => t * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const mix = (a, b, t) => a + (b - a) * t;
const phase = (k, a, b) => Math.min(1, Math.max(0, (k - a) / (b - a)));

/** Resting "guard" angle: melee weapons are held raised, ranged ones aimed. */
export function restAngle(pattern, facing, side) {
  return MELEE_PATTERNS.has(pattern) ? facing - side * 0.95 : facing;
}

/**
 * @param {string} pattern attack pattern
 * @param {object|null} anim { t, dur, angle, dir }
 * @param {number} facing current facing angle
 * @param {object} opts { arc (radians), time, moving, walkT, guard (±1: side
 *   the weapon rests on between attacks) }
 * @returns {{ angle: number, reach: number, lift: number, lunge: number,
 *   trail: number[], flash: number, striking: boolean }}
 */
export function weaponPose(pattern, anim, facing, { arc = 2, time = 0, moving = false, walkT = 0, guard = 1 } = {}) {
  const side = anim?.dir ?? guard;
  const melee = MELEE_PATTERNS.has(pattern);
  const idleSway = moving ? Math.sin(walkT * Math.PI) * 0.12 : Math.sin(time * 2.6) * 0.05;
  const pose = { angle: restAngle(pattern, facing, guard) + idleSway, reach: melee ? 2 : 3, lift: 0, lunge: 0, trail: [], flash: 0, striking: false };
  if (!anim) return pose;

  const k = Math.min(1, anim.t / anim.dur);
  const a = anim.angle;
  const rest = restAngle(pattern, a, side);
  switch (pattern) {
    case 'swing':
    case 'lash': {
      const half = arc / 2;
      const start = a - side * (half + (pattern === 'lash' ? 0.2 : 0.45));
      const from = a - side * half;
      const to = a + side * half;
      const impact = IMPACT_AT[pattern];
      if (k < impact) {
        pose.angle = mix(rest, start, easeOutCubic(phase(k, 0, impact)));
      } else if (k < 0.62) {
        const s = easeOutCubic(phase(k, impact, 0.62));
        pose.angle = mix(from, to, s);
        pose.striking = true;
        for (let i = 1; i <= 4; i++) pose.trail.push(mix(from, to, Math.max(0, s - i * 0.13)));
        pose.lunge = Math.sin(s * Math.PI) * 2;
      } else {
        pose.angle = mix(to, restAngle(pattern, a, -side), easeInOut(phase(k, 0.62, 1)));
      }
      pose.reach = pattern === 'lash' ? 3 : 2 + (pose.striking ? 2 : 0);
      break;
    }
    case 'thrust': {
      pose.angle = a;
      const impact = IMPACT_AT.thrust;
      if (k < impact) {
        pose.reach = mix(2, -2, easeOutCubic(phase(k, 0, impact)));
      } else if (k < 0.6) {
        const s = easeOutCubic(phase(k, impact, 0.6));
        pose.reach = mix(-2, 13, s);
        pose.lunge = s * 3;
        pose.striking = true;
        for (let i = 1; i <= 3; i++) pose.trail.push(a);
      } else {
        pose.reach = mix(13, 2, easeInOut(phase(k, 0.6, 1)));
        pose.lunge = (1 - phase(k, 0.6, 1)) * 3;
      }
      break;
    }
    case 'slam': {
      const overhead = a - side * 2.5;
      const smash = a + side * 0.35;
      const impact = IMPACT_AT.slam;
      if (k < impact) {
        const s = easeOutCubic(phase(k, 0, impact));
        pose.angle = mix(rest, overhead, s);
        pose.lift = -3 * s;
      } else if (k < 0.62) {
        const s = easeInQuad(phase(k, impact, 0.62));
        pose.angle = mix(overhead, smash, Math.min(1, s * 1.6));
        pose.lift = -3 + 5 * s;
        pose.reach = 4;
        pose.striking = true;
        for (let i = 1; i <= 3; i++) pose.trail.push(mix(overhead, smash, Math.max(0, s * 1.6 - i * 0.25)));
      } else {
        const s = easeInOut(phase(k, 0.62, 1));
        pose.angle = mix(smash, rest, s);
        pose.lift = 2 * (1 - s);
      }
      break;
    }
    default: {
      // Ranged: recoil kick up and back, then settle; muzzle flash at the start.
      const heavy = pattern === 'lob';
      const kick = Math.max(0, 1 - k / 0.55);
      pose.angle = a - side * (heavy ? 0.45 : 0.22) * Math.sin(Math.min(1, k / 0.35) * Math.PI) * kick;
      pose.reach = 3 - (heavy ? 5 : 3) * Math.sin(Math.min(1, k / 0.3) * Math.PI / 2) * kick;
      pose.flash = k < 0.18 ? 1 - k / 0.18 : 0;
      pose.striking = k < 0.2;
    }
  }
  pose.angle = ((pose.angle % TAU) + TAU) % TAU;
  return pose;
}
