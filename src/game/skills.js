// Skills: things you can do with any weapon in hand (or none). A researched
// component's `unlocks.skills` teaches one — Gale Step comes from Skyreach's
// Gale Feather (or the Aether Roc's plume). The Wind Beacon in your camp
// (your clan's, in multiplayer) makes you quicker and recharges it sooner.
// Shared by single player and the server.

import { DASH_DIST } from '../net/movement.js';

export const GALE_STEP = Object.freeze({ id: 'gale_step', name: 'Gale Step', cooldown: 4, distance: DASH_DIST });

const NO_BEACON = Object.freeze({ moveSpeedPct: 0, dashCooldownPct: 0 });

/** The skills the researched components teach: Set of skill ids. */
export function knownSkills(data, components) {
  const out = new Set();
  for (const [id, entry] of Object.entries(components ?? {})) {
    if (!entry?.researched) continue;
    for (const s of data.byId.components.get(id)?.unlocks?.skills ?? []) out.add(s);
  }
  return out;
}

export function hasSkill(data, components, id) {
  return knownSkills(data, components).has(id);
}

/** The best beacon standing in the camp: { moveSpeedPct, dashCooldownPct }. */
export function beaconOf(data, save) {
  // Multiplayer: the clan's (the server puts it in the stat save).
  if (save.base?.beacon) return save.base.beacon;
  let best = NO_BEACON;
  for (const st of save.base?.structures ?? []) {
    const b = data.building?.structures?.find((s) => s.id === st.id)?.beacon;
    if (b && (b.moveSpeedPct ?? 0) >= best.moveSpeedPct) best = { moveSpeedPct: b.moveSpeedPct ?? 0, dashCooldownPct: b.dashCooldownPct ?? 0 };
  }
  return best;
}

/** Gale Step's cooldown (seconds) with the beacon's help. */
export function dashCooldown(beacon) {
  return GALE_STEP.cooldown * (1 - Math.min(75, beacon?.dashCooldownPct ?? 0) / 100);
}

export { NO_BEACON };
