// Melee charge, as in Minecraft: you can swing a blade, a hammer or a whip
// as often as you like, but a blow only lands with full force once the
// weapon has wound up again (its attack speed). A quick second swing hits
// softly; holding the button swings only at full charge. Only a fully wound
// blow crits, knocks back and sets off the weapon's on-attack effects.
// Shared by single player (combat.js), the server and the multiplayer client.

/** From this charge on, a blow counts as full (crits, knockback, effects). */
export const FULL_AT = 0.9;

/** The shortest time between two swings (seconds): spamming is never better than waiting. */
export function swingGap(full) {
  return Math.max(0.2, full * 0.35);
}

/** How wound up the weapon is (0 … 1), `since` seconds after the last swing. */
export function chargeOf(since, full) {
  if (!(full > 0)) return 1;
  return since >= full ? 1 : since <= 0 ? 0 : since / full;
}

/** The share of a blow's damage at a charge: 10 % at once, all of it fully wound up. */
export function chargeMult(f) {
  return 0.1 + 0.9 * f * f;
}

/**
 * Whether a swing may start: a fresh press as soon as the short gap is over,
 * a held button only once the weapon is fully wound up again.
 */
export function maySwing(since, full, fresh) {
  return since >= (fresh ? swingGap(full) : full);
}
