// A multiplayer character seen through the single-player save's shape, so
// the same forge/inventory rules (and UI) work in both modes. The server
// builds it to validate requests; the client builds the same thing to show
// the same options and prices.

/** Building levels in Fristaden (the town everyone shares). */
export const FRISTAD_LEVELS = { hearth: 3, forge: 5, vault: 3, library: 2, training: 2, well: 1, den: 1, waystone: 2 };

export const MP_RESOURCE_KEYS = ['essence', 'scrap', 'wood', 'stone', 'gold', 'shards'];

/**
 * Fristaden's Pal Den as your character can use it: one level for every Den
 * upgrade your level has reached (the last two also need a boss beaten),
 * just as you would build it up in single player. Each level lets pals grow
 * two levels.
 */
export function mpDenLevel(data, ch) {
  const den = data.base?.buildings?.find((b) => b.id === 'den');
  if (!den) return 0;
  const bossBeaten = Object.keys(ch.extra?.bosses ?? {}).length > 0;
  let level = 0;
  for (const l of den.levels) {
    if ((l.playerLevel ?? 0) > (ch.level ?? 1) || (l.boss && !bossBeaten)) break;
    level++;
  }
  return level;
}

export function emptyPals() {
  return { eggs: [], owned: [], active: null, mode: 'fight', nextId: 1 };
}

/** A character's pals in single player's save shape (the shared pal rules work on it). */
export function mpPalSave(data, ch) {
  ch.extra ??= {};
  ch.extra.pals ??= emptyPals();
  return { pals: ch.extra.pals, resources: ch.resources, base: { buildings: { ...FRISTAD_LEVELS, den: mpDenLevel(data, ch) } } };
}

/** Bag and storage sizes in multiplayer. */
export function mpInventorySizes(data) {
  return { bagSize: data.base.baseBag, storageSize: data.base.baseStorage };
}

/**
 * ch: { level, xp, resources, pickaxe, extra: { codex, bosses, crafts } },
 * inv: { bag, storage, equipped, secondary, activeSlot, favorites }.
 */
export function mpVirtualSave(data, worldSeed, ch, inv) {
  const extra = ch.extra ?? {};
  const sizes = mpInventorySizes(data);
  return {
    worldSeed,
    player: { level: ch.level, xp: ch.xp, bonusLuck: 0, kills: ch.kills ?? 0, deaths: ch.deaths ?? 0 },
    resources: ch.resources,
    components: {},
    codex: { weapons: {}, modifiers: extra.codex?.modifiers ?? [], effects: [], abilities: extra.codex?.abilities ?? [] },
    base: { buildings: { ...FRISTAD_LEVELS, den: mpDenLevel(data, ch) }, structures: [], wellAt: Date.now(), recall: null },
    bosses: { defeated: extra.bosses ?? {} },
    counters: { craft: extra.crafts ?? 0, drop: 0 },
    tools: { pickaxe: ch.pickaxe ?? 0, boat: 0 },
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
