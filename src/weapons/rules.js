// Combination rules. Every modifier and effect has to pass these checks
// before the generator may add it to a weapon. The rules prevent
// combinations that are:
//   - technically impossible  (homing on a sword, split on a boomerang)
//   - contradictory           (Burning + Freezing, Fire + Ice)
//   - unreadable on a phone   (too many elements / visual effect layers)
//   - too heavy for mobile    (too many projectile/particle producing hooks)
//   - above the rarity tier   (Execute on a common dagger)

import { PROJECTILE_PATTERNS } from '../data/capabilities.js';

/** Creates the mutable state the generator threads through its steps. */
export function createRuleState(data, { archetype, rarity, element }) {
  const tags = new Set(archetype.tags);
  const pattern = archetype.attack.pattern;
  if (PROJECTILE_PATTERNS.has(pattern)) {
    tags.add('projectile');
    // Only the weapon's own attack fires "primary" projectiles; effects like
    // Flame Arc add extra ones, which Ricochet does not apply to.
    tags.add('projectile-attack');
  }
  if (pattern === 'boomerang') tags.add('returning');
  if (pattern === 'wisp' || archetype.attack.homing) tags.add('homing');
  tags.add(archetype.class);
  return {
    data,
    archetype,
    rarity,
    rarityIdx: data.rarityIndex.get(rarity.id),
    element,
    // Elements that visibly colour the weapon (limited for readability).
    elements: new Set(element === 'physical' ? [] : [element]),
    // Every element the weapon touches, incl. status procs (for opposition).
    affinities: new Set(element === 'physical' ? [] : [element]),
    tags,
    ids: new Set(),
    excluded: new Set(),
    perf: 0,
    vfx: 0,
  };
}

export function opposes(data, a, b) {
  if (!a || !b || a === b) return false;
  const ea = data.byId.elements.get(a);
  const eb = data.byId.elements.get(b);
  return Boolean(ea?.opposes?.includes(b) || eb?.opposes?.includes(a));
}

/**
 * Returns null when `item` may be added, otherwise a short reason.
 * @param {object} item modifier or effect definition
 * @param {'modifier'|'effect'} kind
 */
export function incompatibility(item, state, kind) {
  const { data } = state;
  if (state.ids.has(item.id)) return 'duplicate';
  if (state.excluded.has(item.id)) return 'excluded';
  for (const x of item.excludes ?? []) if (state.ids.has(x)) return `excludes:${x}`;
  if (item.minRarity && data.rarityIndex.get(item.minRarity) > state.rarityIdx) return 'rarity';
  if (item.classes && !item.classes.includes(state.archetype.class)) return 'class';
  for (const t of item.requires ?? []) if (!state.tags.has(t)) return `requires:${t}`;
  for (const t of item.excludesTags ?? []) if (state.tags.has(t)) return `excludesTag:${t}`;

  const el = item.element ?? item.statusElement ?? null;
  if (el) {
    if (opposes(data, state.element, el)) return 'opposed';
    for (const other of state.affinities) if (opposes(data, other, el)) return 'opposed';
    if (kind === 'effect' && item.element && item.element !== state.element) return 'element';
    const isNewElement = item.kind === 'element' && !state.elements.has(el);
    if (isNewElement && state.elements.size >= data.balance.maxElements) return 'readability';
  }
  if (state.perf + (item.perf ?? 0) > state.rarity.perfBudget) return 'performance';
  if (state.vfx + (item.vfx ?? 0) > state.rarity.vfxBudget) return 'readability';
  return null;
}

/** Records that `item` was added. */
export function addToState(item, state) {
  state.ids.add(item.id);
  for (const x of item.excludes ?? []) state.excluded.add(x);
  for (const t of item.tags ?? []) state.tags.add(t);
  if (item.kind === 'element' && item.element) {
    state.elements.add(item.element);
    // A physical weapon that gains an element becomes a weapon of that element.
    if (state.element === 'physical') state.element = item.element;
  }
  const el = item.element ?? item.statusElement;
  if (el) state.affinities.add(el);
  state.perf += item.perf ?? 0;
  state.vfx += item.vfx ?? 0;
}

/**
 * Validates a finished weapon DNA against the rules (used by tests and on
 * import, so hand-edited save files can't smuggle in impossible weapons).
 * @returns {string[]} problems
 */
export function auditWeapon(data, dna) {
  const problems = [];
  const archetype = data.byId.archetypes.get(dna.archetype);
  const rarity = data.byId.rarities.get(dna.rarity);
  if (!archetype) return [`unknown archetype ${dna.archetype}`];
  if (!rarity) return [`unknown rarity ${dna.rarity}`];
  const state = createRuleState(data, { archetype, rarity, element: dna.element });
  for (const m of dna.modifiers) {
    const def = data.byId.modifiers.get(m.id);
    if (!def) { problems.push(`unknown modifier ${m.id}`); continue; }
    const why = incompatibility(def, state, 'modifier');
    if (why) problems.push(`modifier ${m.id}: ${why}`);
    addToState(def, state);
  }
  for (const e of dna.effects) {
    const def = data.byId.effects.get(e.id);
    if (!def) { problems.push(`unknown effect ${e.id}`); continue; }
    const why = incompatibility(def, state, 'effect');
    if (why) problems.push(`effect ${e.id}: ${why}`);
    addToState(def, state);
  }
  const [minMods, maxMods] = rarity.modifiers;
  if (dna.modifiers.length < minMods || dna.modifiers.length > maxMods) {
    problems.push(`modifier count ${dna.modifiers.length} outside ${minMods}-${maxMods} for ${rarity.id}`);
  }
  if (dna.power.used > dna.power.budget + 1e-9) {
    problems.push(`power ${dna.power.used} exceeds budget ${dna.power.budget}`);
  }
  return problems;
}
