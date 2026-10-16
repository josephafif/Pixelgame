// The generation pool: which archetypes, materials, effects, abilities and
// modifiers the generator may use. Starts with the base pool and grows as
// the player researches weapon components (cores, materials, blueprints,
// boss cores).

const KINDS = ['archetypes', 'materials', 'effects', 'abilities', 'modifiers'];

/**
 * @param {object} data indexed game data
 * @param {Iterable<string>} unlockedComponents researched component ids
 * @param {{ base?: 1|string|null }} opts base: only the base weapons of the
 *   evolution trees (evolved types are reached by evolving, never found),
 *   or (an archetype id) only that one
 */
export function buildPool(data, unlockedComponents = [], { base = null } = {}) {
  const unlocked = [...new Set(unlockedComponents)].filter((id) => data.byId.components.has(id)).sort();
  const allowed = Object.fromEntries(KINDS.map((k) => [k, new Set()]));
  for (const id of unlocked) {
    const c = data.byId.components.get(id);
    for (const [kind, list] of Object.entries(c.unlocks ?? {})) {
      for (const x of list) allowed[kind]?.add(x);
    }
    if (c.material) allowed.materials.add(c.material);
  }
  const available = (kind) => data[kind].filter((item) => !data.gated[kind].has(item.id) || allowed[kind].has(item.id));
  return {
    unlocked,
    archetypes: baseArchetypes(available('archetypes'), base),
    materials: available('materials'),
    effects: available('effects'),
    abilities: available('abilities'),
    modifiers: available('modifiers'),
    elements: data.elements,
  };
}

function baseArchetypes(list, base) {
  if (!base) return list;
  const bases = list.filter((a) => !a.evolved);
  const one = typeof base === 'string' ? bases.filter((a) => a.id === base) : [];
  return one.length ? one : bases;
}

/** Which component would unlock a gated id (for UI hints). */
export function unlockSourceFor(data, kind, id) {
  return data.components.find((c) => c.unlocks?.[kind]?.includes(id) || (kind === 'materials' && c.material === id)) ?? null;
}
