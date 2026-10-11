// Day and night. A day lasts DAY_MINUTES real minutes: a long day, a red
// dusk, a dark night and a soft dawn. At night more monsters roam (by day
// fewer), and they shun the light of torches and fires (lights.js).
//
// Single player keeps its own clock in the save (it stands still while the
// game is paused); in multiplayer everyone shares the server's clock (the
// time of day follows from the server's time, so no messages are needed).

export const DAY_MINUTES = 24;
const DAY_MS = DAY_MINUTES * 60 * 1000;

/** A new game starts in the morning. */
export const START_HOUR = 8;

/** The clock (ms of game time) at a given hour. */
export function clockAt(hour) {
  return (hour / 24) * DAY_MS;
}

/** The hour of the day (0 … 24) at clock `ms`. */
export function hourAt(ms) {
  const d = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  return (d / DAY_MS) * 24;
}

function smooth(t) {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

/** How dark it is at an hour: 0 by day, 1 deep in the night (dusk 18–20:30, dawn 4:30–7). */
export function darknessAt(hour) {
  if (hour >= 7 && hour < 18) return 0;
  if (hour >= 18 && hour < 20.5) return smooth((hour - 18) / 2.5);
  if (hour >= 4.5 && hour < 7) return 1 - smooth((hour - 4.5) / 2.5);
  return 1;
}

/** The warm red of dusk and dawn (0 … 1): strongest as the sun goes down or comes up. */
export function glowAt(hour) {
  const near = (h) => Math.max(0, 1 - Math.abs(hour - h) / 1.4);
  return Math.max(near(18.8), near(5.8));
}

/** How many monsters roam compared with the day's: fewer by day, many more at night. */
export function spawnFactor(darkness) {
  return 0.65 + 0.95 * darkness;
}

/** 'day', 'dusk', 'night' or 'dawn'. */
export function phaseOf(hour) {
  if (hour >= 7 && hour < 18) return 'day';
  if (hour >= 18 && hour < 20.5) return 'dusk';
  if (hour >= 4.5 && hour < 7) return 'dawn';
  return 'night';
}
