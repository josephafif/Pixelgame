// Clan bases in multiplayer: every building of the single-player camp
// (Hearth, Forge, Vault, Library, Training Grounds, Essence Well, Waystone
// and Pal Den) can be built once in each clan's base, then upgraded with the
// same costs and bonuses as in single player. Fristaden, the shared town,
// keeps only a simple forge (common to rare weapons) and its traders.
//
// A building stands on the map as a structure ('b_forge' …); its level
// belongs to the clan, so taking a building down and putting it up somewhere
// else keeps every upgrade. Shared by the server (which decides) and the
// client (which shows the same options and prices).

import { COST_KEYS } from '../game/base.js';

export const BASE_BUILDINGS = ['hearth', 'forge', 'vault', 'library', 'training', 'well', 'waystone', 'den', 'lodge', 'garden'];

/** Fristaden's buildings: a forge that makes common to rare weapons, and the town fire. */
export const TOWN_LEVELS = { hearth: 1, forge: 1 };

export const BUILDING_SV = {
  hearth: 'Härd', forge: 'Smedja', vault: 'Förråd', library: 'Bibliotek',
  training: 'Träningsplats', well: 'Essensbrunn', waystone: 'Vägsten', den: 'Djurhus', lodge: 'Arbetarstuga',
  garden: 'Läketrädgård',
};

const DESC_SV = {
  hearth: 'Basens hjärta. Vila här för full hälsa. Varje uppgradering ger mer hälsa åt hela klanen.',
  forge: 'Smid vapen, hackor och båtar. Uppgraderingar ger billigare och starkare vapen och bättre katalysatorer (episka och legendariska).',
  vault: 'Ditt förråd för vapen. Varje nivå ger fler förrådsplatser och en större väska.',
  library: 'Varje nivå gör forskning billigare.',
  training: 'Varje nivå ger hela klanen mer anfall och försvar.',
  well: 'Fylls med essens av sig själv. Gå dit och hämta.',
  waystone: 'Res hem till basen från var som helst (nivå 2: och tillbaka igen).',
  den: 'Kläck pal-ägg. Varje nivå låter dina pals växa två nivåer till.',
  lodge: 'Anställ arbetare som hugger träd och bryter sten ute i vildmarken och bär hem allt till klanvalvet. Varje nivå ger plats för en till.',
  garden: 'Läkeörter i lumenljus. Utanför strid läker hela klanen långsamt (mer för varje nivå), från nivå 2 gör träskens gyttja er inte sjuka, och här brygger ni Lumentonikum av lumensporer.',
};

/** Upkeep rates per day from the server's weekly rules. */
export function upkeepRates(rules) {
  const perDay = (m) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, v / 7]));
  return {
    perStructure: perDay(rules.upkeepPerStructure),
    perBuildingLevel: perDay(rules.upkeepPerBuildingLevel),
    perWorker: perDay(rules.upkeepPerWorker),
  };
}

export function baseStructId(id) {
  return `b_${id}`;
}

/** 'b_forge' → 'forge' (null for walls, turrets and the rest). */
export function buildingOfStruct(stId) {
  return typeof stId === 'string' && stId.startsWith('b_') ? stId.slice(2) : null;
}

/** Structure definitions for the clan buildings (the build menu lists them). */
export function baseStructDefs(data) {
  return (data.base?.buildings ?? []).filter((b) => BASE_BUILDINGS.includes(b.id)).map((b) => {
    const first = b.levels[0] ?? {};
    const cost = {};
    for (const k of COST_KEYS) if (first[k]) cost[k] = first[k];
    return {
      id: baseStructId(b.id),
      building: b.id,
      name: BUILDING_SV[b.id] ?? b.name,
      kind: 'building',
      hp: 5000,
      cost,
      mpLevel: Math.max(1, first.playerLevel ?? 1),
      blueprint: b.blueprint ?? null,
      desc: DESC_SV[b.id] ?? b.desc,
    };
  });
}

/**
 * Building levels that count for a clan: { forge: 3, … } for each building
 * that stands in its base right now. `base` is the clan's { buildings:
 * { id: level } } and `placed` the set (or object) of buildings standing.
 */
export function clanLevels(base, placed) {
  const out = {};
  const has = (id) => (placed instanceof Set ? placed.has(id) : Boolean(placed?.[id]));
  for (const id of BASE_BUILDINGS) if (has(id)) out[id] = Math.max(1, base?.buildings?.[id] ?? 1);
  return out;
}

/** The levels your character uses at a forge: the town's (1) or your clan's. */
export function forgeLevels(levels, atTown) {
  return atTown ? { ...levels, forge: TOWN_LEVELS.forge } : levels;
}
