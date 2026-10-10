// Every resource a player can carry. The base ones, and the three
// materials of the far lands: Prismite (Prism Barrens), Lumen Spores
// (Mireglass Fen) and Aetherglass (Skyreach). Shared by single player, the
// server and the UI (one list, so a new material is never forgotten).

export const BASE_RESOURCES = ['gold', 'scrap', 'essence', 'wood', 'stone', 'shards'];
export const FAR_RESOURCES = ['prismite', 'spores', 'aether'];
export const ALL_RESOURCES = [...BASE_RESOURCES, ...FAR_RESOURCES];

export const FAR_RESOURCE_INFO = {
  prismite: { name: 'Prismite', sv: 'Prismit', color: '#7ae8ff', biome: 'prism' },
  spores: { name: 'Lumen Spores', sv: 'Lumensporer', color: '#9affc8', biome: 'fen' },
  aether: { name: 'Aetherglass', sv: 'Eterglas', color: '#d8ecff', biome: 'skyreach' },
};

/** Pickups that simply add to a resource (the pickup's kind is the resource). */
export const MATERIAL_PICKUPS = new Set(['essence', 'scrap', 'wood', 'stone', 'gold', ...FAR_RESOURCES]);
