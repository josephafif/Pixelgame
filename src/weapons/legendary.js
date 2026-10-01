// Legendary signature powers. Every legendary weapon's ability is raised to
// one of these spectacular powers (data → legendaryAbilities), chosen from
// the weapon's seed and element, and as strong as the weapon rolled its
// ability. It is a layer on top of the Weapon DNA: the DNA itself never
// changes, so legendaries you already own get their power too.

import { hashInts } from '../core/rng.js';

const lerp = ([lo, hi], t) => lo + (hi - lo) * t;
const round1 = (v) => Math.round(v * 10) / 10;

/** How high (0–1) a weapon rolled its base ability. */
function abilityRoll(data, ab) {
  const tpl = data.byId.abilities.get(ab.id);
  for (const key of ['damage', 'radius', 'duration']) {
    const range = tpl?.[key];
    if (range && range[1] > range[0]) return Math.max(0, Math.min(1, (ab[key] - range[0]) / (range[1] - range[0])));
  }
  return 0.5;
}

/** The signature power template for a legendary weapon (or null). */
export function signatureTemplate(data, dna) {
  const list = data.legendaryAbilities ?? [];
  if (dna?.rarity !== 'legendary' || !dna.ability || !list.length) return null;
  const own = list.filter((a) => a.affinity.includes(dna.element));
  const pool = own.length ? own : list;
  return pool[hashInts(dna.seed >>> 0, 0x1e6e9d) % pool.length];
}

/** A legendary weapon's signature power, in the same shape as a DNA ability. */
export function signatureFor(data, dna) {
  const tpl = signatureTemplate(data, dna);
  if (!tpl) return null;
  const ab = dna.ability;
  const p = abilityRoll(data, ab);
  const range = (key, digits = 1) => (tpl[key] ? (digits ? round1(lerp(tpl[key], p)) : Math.round(lerp(tpl[key], p))) : 0);
  const swift = ab.twist === 'swift' ? 0.75 : 1;
  return {
    id: tpl.id,
    action: tpl.do,
    name: tpl.name,
    desc: tpl.desc,
    infuse: ab.infuse,
    twist: ab.twist === 'twin' ? null : ab.twist,
    twistDesc: ab.twist === 'twin' ? null : ab.twistDesc,
    damage: range('damage', 0),
    radius: range('radius'),
    duration: range('duration'),
    // Better rolls recharge faster.
    cooldown: round1(lerp(tpl.cooldown, 1 - p) * swift),
    count: range('count', 0),
    color: tpl.color,
    legendary: true,
  };
}

/** The ability a weapon actually casts: its signature power if legendary. */
export function effectiveAbility(data, dna) {
  return signatureFor(data, dna) ?? dna?.ability ?? null;
}
