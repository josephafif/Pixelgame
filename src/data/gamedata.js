// Loads, validates and indexes the static game data (data/v1/gamedata.json).
// Pure module: runs in the page, in the weapon Web Worker and in Node tests.

import {
  SUPPORTED_SCHEMA, ATTACK_PATTERNS, SPRITE_TEMPLATES, HOOK_TRIGGERS, HOOK_ACTIONS,
  ABILITY_ACTIONS, WEAPON_STATS, PLAYER_STATS,
} from './capabilities.js';

export const GAMEDATA_URL = 'data/v1/gamedata.json';

const LIST_KEYS = [
  'rarities', 'elements', 'materials', 'archetypes', 'modifiers', 'drawbacks', 'effects',
  'abilities', 'abilityTwists', 'themes', 'components', 'catalysts', 'biomes', 'enemies', 'bosses',
];

function hooksSupported(hooks) {
  return (hooks ?? []).every((h) => HOOK_TRIGGERS.has(h.on) && HOOK_ACTIONS.has(h.do));
}

/**
 * Drops entries this client cannot execute and reports problems.
 * @returns {{ data: object, errors: string[], skipped: string[] }}
 */
export function sanitizeGameData(raw) {
  const errors = [];
  const skipped = [];
  if (!raw || typeof raw !== 'object') {
    return { data: null, errors: ['Game data is not an object'], skipped };
  }
  if (raw.schemaVersion !== SUPPORTED_SCHEMA) {
    errors.push(`Unsupported game data schema ${raw.schemaVersion} (client supports ${SUPPORTED_SCHEMA})`);
    return { data: null, errors, skipped };
  }
  for (const key of LIST_KEYS) {
    if (!Array.isArray(raw[key])) errors.push(`Missing list "${key}"`);
  }
  if (errors.length) return { data: null, errors, skipped };

  const keep = (list, label, ok) => list.filter((item) => {
    if (ok(item)) return true;
    skipped.push(`${label}:${item.id}`);
    return false;
  });

  const data = { ...raw };
  data.archetypes = keep(raw.archetypes, 'archetype', (a) =>
    ATTACK_PATTERNS.has(a.attack?.pattern) && SPRITE_TEMPLATES.has(a.sprite?.template));
  data.modifiers = keep(raw.modifiers, 'modifier', (m) =>
    hooksSupported(m.hooks)
    && (!m.stat || WEAPON_STATS.has(m.stat))
    && (!m.playerStat || PLAYER_STATS.has(m.playerStat)));
  data.drawbacks = keep(raw.drawbacks, 'drawback', (d) =>
    hooksSupported(d.hooks) && (!d.playerStat || PLAYER_STATS.has(d.playerStat)));
  data.effects = keep(raw.effects, 'effect', (e) => hooksSupported(e.hooks));
  data.abilities = keep(raw.abilities, 'ability', (a) => ABILITY_ACTIONS.has(a.do));
  return { data, errors, skipped };
}

/** Checks cross references. Returns a list of human readable problems. */
export function validateReferences(data) {
  const problems = [];
  const ids = {};
  for (const key of LIST_KEYS) {
    ids[key] = new Set();
    for (const item of data[key]) {
      if (!item.id) problems.push(`${key}: entry without id`);
      else if (ids[key].has(item.id)) problems.push(`${key}: duplicate id ${item.id}`);
      else ids[key].add(item.id);
    }
  }
  const need = (set, id, where) => {
    if (!ids[set].has(id)) problems.push(`${where} references unknown ${set} "${id}"`);
  };
  for (const e of data.elements) for (const o of e.opposes ?? []) need('elements', o, `element ${e.id}`);
  for (const a of data.archetypes) {
    if (!a.kinds?.length) problems.push(`archetype ${a.id} has no material kinds`);
    const hasMaterial = data.materials.some((m) => m.kinds.some((k) => a.kinds.includes(k)));
    if (!hasMaterial) problems.push(`archetype ${a.id} has no compatible material`);
  }
  for (const m of data.modifiers) {
    if (m.element) need('elements', m.element, `modifier ${m.id}`);
    for (const x of m.excludes ?? []) need('modifiers', x, `modifier ${m.id}`);
    if (m.minRarity) need('rarities', m.minRarity, `modifier ${m.id}`);
    if (!Array.isArray(m.range) || m.range[0] > m.range[1]) problems.push(`modifier ${m.id} has a bad range`);
  }
  for (const e of data.effects) {
    if (e.element) need('elements', e.element, `effect ${e.id}`);
    if (e.minRarity) need('rarities', e.minRarity, `effect ${e.id}`);
  }
  for (const t of data.themes) {
    for (const el of t.elements ?? []) need('elements', el, `theme ${t.id}`);
    if (t.drawback) need('drawbacks', t.drawback, `theme ${t.id}`);
  }
  for (const c of data.components) {
    if (c.element) need('elements', c.element, `component ${c.id}`);
    if (c.material) need('materials', c.material, `component ${c.id}`);
    if (c.boss) need('bosses', c.boss, `component ${c.id}`);
    const u = c.unlocks ?? {};
    for (const id of u.archetypes ?? []) need('archetypes', id, `component ${c.id}`);
    for (const id of u.materials ?? []) need('materials', id, `component ${c.id}`);
    for (const id of u.effects ?? []) need('effects', id, `component ${c.id}`);
    for (const id of u.abilities ?? []) need('abilities', id, `component ${c.id}`);
    for (const id of u.modifiers ?? []) need('modifiers', id, `component ${c.id}`);
  }
  for (const b of data.biomes) {
    for (const id of b.enemies) need('enemies', id, `biome ${b.id}`);
    for (const id of b.elements) need('elements', id, `biome ${b.id}`);
    for (const id of b.components) need('components', id, `biome ${b.id}`);
    if (b.boss) need('bosses', b.boss, `biome ${b.id}`);
  }
  for (const b of data.bosses) {
    need('biomes', b.biome, `boss ${b.id}`);
    need('components', b.drop.component, `boss ${b.id}`);
    need('rarities', b.drop.minRarity, `boss ${b.id}`);
    need('themes', b.drop.theme, `boss ${b.id}`);
  }
  return problems;
}

/**
 * Builds lookup maps on top of sanitized data.
 * The returned object is what every other module receives as `data`.
 */
export function indexGameData(data) {
  const byId = {};
  for (const key of LIST_KEYS) {
    byId[key] = new Map(data[key].map((item) => [item.id, item]));
  }
  const rarityIndex = new Map(data.rarities.map((r, i) => [r.id, i]));

  // Anything that a component unlocks is gated: it is not in the base pool.
  const gated = { archetypes: new Set(), materials: new Set(), effects: new Set(), abilities: new Set(), modifiers: new Set() };
  for (const c of data.components) {
    for (const [kind, list] of Object.entries(c.unlocks ?? {})) {
      for (const id of list) gated[kind]?.add(id);
    }
    // Component materials are gated too (the component *is* the material source).
    if (c.material) gated.materials.add(c.material);
  }
  return { ...data, byId, rarityIndex, gated };
}

/** Sanitizes + validates + indexes. Throws if the data is unusable. */
export function prepareGameData(raw) {
  const { data, errors, skipped } = sanitizeGameData(raw);
  if (!data) throw new Error(errors.join('; '));
  const problems = validateReferences(data);
  if (problems.length) throw new Error(`Game data has broken references: ${problems.slice(0, 5).join('; ')}`);
  const indexed = indexGameData(data);
  indexed.skipped = skipped;
  return indexed;
}

/** Browser loader. Goes through the Service Worker (stale-while-revalidate). */
export async function loadGameData(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(GAMEDATA_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load game data (${res.status})`);
  const raw = await res.json();
  return { raw, data: prepareGameData(raw) };
}
