// A multiplayer character seen through the single-player save's shape, so
// the same forge/inventory rules (and UI) work in both modes. The server
// builds it to validate requests; the client builds the same thing to show
// the same options and prices.
//
// `levels` are the camp building levels that count for the character right
// now: their clan's base (src/net/mpbase.js), with Fristaden's forge level
// when they stand at the town forge.

import { baseBonuses } from '../game/base.js';

export const MP_RESOURCE_KEYS = ['essence', 'scrap', 'wood', 'stone', 'gold', 'shards'];

export function emptyPals() {
  return { eggs: [], owned: [], active: null, mode: 'fight', nextId: 1 };
}

/** A character's pals in single player's save shape (the shared pal rules work on it). */
export function mpPalSave(data, ch, levels = {}) {
  ch.extra ??= {};
  ch.extra.pals ??= emptyPals();
  return { pals: ch.extra.pals, resources: ch.resources, base: { buildings: { ...levels, den: levels.den ?? 0 } } };
}

/** Bag and storage sizes in multiplayer: they grow with your clan's Vault, as in single player. */
export function mpInventorySizes(data, levels = {}) {
  const b = baseBonuses(data, { base: { buildings: levels } });
  return { bagSize: data.base.baseBag + b.bag, storageSize: data.base.baseStorage + b.storage };
}

/**
 * ch: { level, xp, resources, pickaxe, extra: { codex, bosses, crafts } },
 * inv: { bag, storage, equipped, secondary, activeSlot, favorites }.
 */
export function mpVirtualSave(data, worldSeed, ch, inv, levels = {}) {
  const extra = ch.extra ?? {};
  const sizes = mpInventorySizes(data, levels);
  return {
    worldSeed,
    player: { level: ch.level, xp: ch.xp, bonusLuck: 0, kills: ch.kills ?? 0, deaths: ch.deaths ?? 0 },
    resources: ch.resources,
    components: extra.components ?? {},
    codex: { weapons: {}, modifiers: extra.codex?.modifiers ?? [], effects: [], abilities: extra.codex?.abilities ?? [] },
    base: { buildings: { hearth: 0, ...levels }, structures: [], wellAt: Date.now(), recall: null },
    bosses: { defeated: extra.bosses ?? {} },
    counters: { craft: extra.crafts ?? 0, drop: 0 },
    tools: { pickaxe: ch.pickaxe ?? 0, boat: extra.boat ?? 0 },
    inventory: {
      bag: inv?.bag ?? [],
      storage: inv?.storage ?? [],
      equipped: inv?.equipped ?? null,
      secondary: inv?.secondary ?? null,
      activeSlot: inv?.activeSlot ?? 'main',
      favorites: inv?.favorites ?? [],
      unseen: inv?.unseen ?? [],
      bagSize: sizes.bagSize,
      storageSize: sizes.storageSize,
    },
    flags: {},
    world: { explored: [], pins: [], chests: [], shrines: [], altars: [], found: [], harvested: {} },
    markets: {},
    pals: extra.pals ?? emptyPals(),
  };
}

/** Records a weapon's modifiers/abilities in the character's codex (forge runes). */
export function learnFromWeapon(extra, dna) {
  extra.codex ??= { modifiers: [], abilities: [] };
  let changed = false;
  for (const m of dna.modifiers ?? []) {
    if (!extra.codex.modifiers.includes(m.id)) {
      extra.codex.modifiers.push(m.id);
      changed = true;
    }
  }
  if (dna.ability && !extra.codex.abilities.includes(dna.ability.id)) {
    extra.codex.abilities.push(dna.ability.id);
    changed = true;
  }
  return changed;
}
