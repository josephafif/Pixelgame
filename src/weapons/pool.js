// The generation pool: which archetypes, materials, effects, abilities and
// modifiers the generator may use. Starts with the base pool and grows as
// the player researches weapon components (cores, materials, blueprints,
// boss cores).

const KINDS = ['archetypes', 'materials', 'effects', 'abilities', 'modifiers'];

/**
 * @param {object} data indexed game data
 * @param {Iterable<string>} unlockedComponents researched component ids
 */
export function buildPool(data, unlockedComponents = []) {
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
    archetypes: available('archetypes'),
    materials: available('materials'),
    effects: available('effects'),
    abilities: available('abilities'),
    modifiers: available('modifiers'),
    elements: data.elements,
  };
}

/** Which component would unlock a gated id (for UI hints). */
export function unlockSourceFor(data, kind, id) {
  return data.components.find((c) => c.unlocks?.[kind]?.includes(id) || (kind === 'materials' && c.material === id)) ?? null;
}
