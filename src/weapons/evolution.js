// Weapon Evolution (docs/WEAPON-EVOLUTION.md): you find a base weapon and
// grow it, step by step, into your own. Every family (data → evolution) has
// the same five steps — Tempered, Form (a branch: a new weapon type and way
// to fight), Masterwork, Infusion (an element, from a boss's core) and
// Awakening (a legendary power) — and each branch is the family's own.
//
// Everything here is pure and shared by single player and the server: the
// requirements (evolveBlockers), what a step does to the Weapon DNA
// (applyNode: DNA in, new DNA out) and tempering a weapon to your level.
// The weapon keeps its id; `dna.evo.rev` changes with every step (the
// sprite, icon and compiled weapon caches key on it).

import { makeModifier, makeEffect, makeAbility, changeArchetype, recomputeStats, newLook } from './workshop.js';
import { createRuleState, incompatibility, addToState } from './rules.js';
import { hashInts } from '../core/rng.js';

const COSTS = ['scrap', 'essence', 'wood', 'stone', 'prismite', 'spores', 'aether', 'shards'];

// --- The trees ---------------------------------------------------------------------

const index = new WeakMap();

/** Archetype → where it sits in the trees: { family, branch, tier } (base weapons tier 0). */
function archetypeIndex(data) {
  let idx = index.get(data);
  if (idx) return idx;
  idx = new Map();
  for (const fam of data.evolution?.families ?? []) {
    for (const form of fam.forms) {
      if (form.mastery?.archetype && !idx.has(form.mastery.archetype)) idx.set(form.mastery.archetype, { family: fam.id, branch: form.id, tier: 3 });
      if (form.archetype !== fam.base && !idx.has(form.archetype)) idx.set(form.archetype, { family: fam.id, branch: form.id, tier: 2 });
    }
    idx.set(fam.base, { family: fam.id, branch: null, tier: 0 });
  }
  index.set(data, idx);
  return idx;
}

export function familyDef(data, id) {
  return data.evolution?.families.find((f) => f.id === id) ?? null;
}

/** The family a weapon belongs to (its tree), or null. */
export function familyOf(data, dna) {
  return familyDef(data, dna?.evo?.family ?? archetypeIndex(data).get(dna?.archetype)?.family);
}

/**
 * A base weapon type of a family you have no weapon of yet (a boss's drop
 * leans towards it), or null when you have them all. `pick` (an integer)
 * chooses among them.
 */
export function missingBase(data, weapons, pick = 0) {
  const have = new Set(weapons.map((w) => familyOf(data, w)?.id).filter(Boolean));
  const missing = (data.evolution?.families ?? []).filter((f) => !have.has(f.id));
  return missing.length ? missing[Math.abs(pick) % missing.length].base : null;
}

/** The base weapons you can find (one per family). */
export function baseArchetypes(data) {
  return (data.evolution?.families ?? []).map((f) => f.base);
}

export function tierDef(data, tier) {
  return data.evolution.tiers.find((t) => t.tier === tier) ?? null;
}

export function levelCap(data, tier) {
  const caps = data.evolution.levelCaps;
  return caps[Math.min(tier, caps.length - 1)];
}

/**
 * The weapon's place in its tree: { family, tier, path, rev, mult }. A
 * weapon from before the trees gets one from its type: an evolved type
 * counts as that branch's form (and Masterwork for the cannon).
 */
export function evoOf(data, dna) {
  if (dna?.evo?.family) return dna.evo;
  const at = archetypeIndex(data).get(dna?.archetype);
  if (!at) return null;
  const path = [];
  if (at.tier >= 2) path.push('tempered', `form:${at.branch}`);
  if (at.tier >= 3) path.push(`mastery:${at.branch}`);
  return { family: at.family, tier: at.tier, path, rev: 0, mult: { damage: 1 } };
}

const branchOf = (evo) => evo?.path.find((n) => n.startsWith('form:'))?.slice(5) ?? null;
const infusionOf = (evo) => evo?.path.find((n) => n.startsWith('infuse:'))?.slice(7) ?? null;

/** The awakening powers open to a weapon of `element` (affinity first, then the fallbacks). */
export function awakeningsFor(data, element) {
  const ev = data.evolution;
  const byPower = new Map(ev.awakenings.map((a) => [a.power, a]));
  const powers = (data.legendaryAbilities ?? []).filter((p) => p.affinity.includes(element) && byPower.has(p.id)).map((p) => p.id);
  for (const f of ev.awakenFallback) if (powers.length < 2 && !powers.includes(f)) powers.push(f);
  return powers.slice(0, 3).map((id) => byPower.get(id));
}

/**
 * Every node of the weapon's tree: { id, tier, kind, branch, element, power,
 * name, desc, parent, requires: { components, bosses, forge, level, cost } }.
 * Awakenings depend on the infusion: until one is chosen they stay hidden.
 */
export function treeFor(data, dna) {
  const fam = familyOf(data, dna);
  if (!fam) return [];
  const evo = evoOf(data, dna);
  const T = (n) => tierDef(data, n);
  const nodes = [];
  const req = (tier, extra = {}) => ({
    forge: T(tier).forge, level: T(tier).level, bosses: T(tier).bosses ?? 0, cost: { ...T(tier).cost }, components: [], ...extra,
  });
  nodes.push({ id: 'tempered', tier: 1, kind: 'temper', name: T(1).name, desc: 'Honed and balanced at the forge: more damage, a higher level cap.', parent: null, requires: req(1) });
  for (const form of fam.forms) {
    const a = data.byId.archetypes.get(form.archetype);
    nodes.push({
      id: `form:${form.id}`, tier: 2, kind: 'form', branch: form.id, name: form.name, desc: form.desc,
      archetype: form.archetype, archetypeName: a?.name ?? form.archetype, parent: 'tempered',
      requires: req(2, { components: form.requires }),
    });
    const m = form.mastery;
    const ma = m.archetype ? data.byId.archetypes.get(m.archetype) : null;
    nodes.push({
      id: `mastery:${form.id}`, tier: 3, kind: 'mastery', branch: form.id, name: m.name, desc: m.desc,
      archetype: m.archetype ?? null, archetypeName: ma?.name ?? null, parent: `form:${form.id}`,
      requires: req(3, { components: m.requires }),
    });
  }
  for (const el of fam.infusions) {
    const inf = data.evolution.infusions.find((i) => i.element === el);
    if (!inf) continue;
    const elDef = data.byId.elements.get(el);
    nodes.push({
      id: `infuse:${el}`, tier: 4, kind: 'infusion', element: el, name: `${elDef?.name ?? el} Infusion`,
      desc: `Its element becomes ${elDef?.name ?? el}, ${data.byId.effects.get(inf.effect)?.name ?? inf.effect} awakens in it.`,
      parent: 'mastery:*', requires: req(4, { components: [inf.core] }),
    });
  }
  const infused = infusionOf(evo);
  if (infused) {
    for (const aw of awakeningsFor(data, infused)) {
      const p = data.legendaryAbilities.find((x) => x.id === aw.power);
      const cost = { ...T(5).cost, [aw.resource]: data.evolution.awakenAmount };
      nodes.push({
        id: `awaken:${aw.power}`, tier: 5, kind: 'awakening', power: aw.power, name: p?.name ?? aw.power, desc: p?.desc ?? '',
        parent: `infuse:${infused}`, requires: req(5, { components: [aw.core], cost }),
      });
    }
  } else {
    nodes.push({ id: 'awaken:?', tier: 5, kind: 'awakening', hidden: true, name: 'Awakening', desc: 'A legendary power, decided by the element you infuse it with.', parent: 'infuse:*', requires: req(5) });
  }
  return nodes;
}

/** A node of the weapon's tree by id. */
export function nodeOf(data, dna, id) {
  return treeFor(data, dna).find((n) => n.id === id) ?? null;
}

/**
 * Where a node stands for this weapon: 'owned', 'next' (the following step
 * on its path), 'closed' (another branch was chosen) or 'future'.
 */
export function nodeStatus(data, dna, node) {
  const evo = evoOf(data, dna);
  if (!evo || !node) return 'closed';
  if (evo.path.includes(node.id)) return 'owned';
  const chosenAt = (tier) => evo.path.find((id) => treeTier(id) === tier);
  // Another node of the same step already taken.
  if (chosenAt(node.tier)) return 'closed';
  // A Masterwork belongs to its form.
  const branch = branchOf(evo);
  if (node.kind === 'mastery' && branch && node.branch !== branch) return 'closed';
  if (node.tier === evo.tier + 1) return 'next';
  return 'future';
}

function treeTier(id) {
  if (id === 'tempered') return 1;
  if (id.startsWith('form:')) return 2;
  if (id.startsWith('mastery:')) return 3;
  if (id.startsWith('infuse:')) return 4;
  if (id.startsWith('awaken:')) return 5;
  return 0;
}

const foundComponent = (save, id) => (save.components?.[id]?.found ?? 0) > 0;
const bossesBeaten = (save) => Object.values(save.bosses?.defeated ?? {}).filter((n) => n > 0).length;

/**
 * What a step needs and whether you have it: [{ kind, id, label, ok, hint }].
 * ctx: { playerLevel, forgeLevel } (the server passes its own).
 */
export function requirementsOf(data, save, dna, node, ctx = {}) {
  if (!node) return [];
  const rows = [];
  const r = node.requires;
  const forge = ctx.forgeLevel ?? save.base?.buildings?.forge ?? 0;
  rows.push({ kind: 'forge', label: `Forge level ${r.forge}`, ok: forge >= r.forge });
  if (r.level > 1) rows.push({ kind: 'level', label: `Level ${r.level}`, ok: (ctx.playerLevel ?? save.player?.level ?? 1) >= r.level });
  if (r.bosses) rows.push({ kind: 'bosses', label: r.bosses === 1 ? 'Defeat a boss' : `Defeat ${r.bosses} bosses`, ok: bossesBeaten(save) >= r.bosses });
  for (const id of r.components) {
    const c = data.byId.components.get(id);
    rows.push({ kind: 'component', id, label: c?.name ?? id, ok: foundComponent(save, id), hint: sourceHint(data, id) });
  }
  return rows;
}

/** Where a component comes from, as a hint: a boss, or the lands it is found in. */
export function sourceHint(data, id) {
  const boss = data.bosses.find((b) => b.drop?.component === id);
  if (boss) {
    const biome = data.byId.biomes.get(boss.biome);
    return { boss: boss.id, bossName: boss.name, biome: boss.biome, biomeName: biome?.name ?? boss.biome };
  }
  const lands = data.biomes.filter((b) => b.components?.includes(id));
  return { biomes: lands.map((b) => b.id), biomeNames: lands.map((b) => b.name) };
}

/** What the step costs (resources), with what you lack: { cost, short }. */
export function costOf(data, save, node) {
  const cost = node?.requires.cost ?? {};
  const res = save.resources ?? {};
  const short = {};
  for (const k of COSTS) if ((cost[k] ?? 0) > (res[k] ?? 0)) short[k] = cost[k] - (res[k] ?? 0);
  return { cost, short };
}

/**
 * Why the weapon can't take this step now (empty = it can). Messages are
 * short and readable; the UI shows the requirement rows itself.
 */
export function evolveBlockers(data, save, dna, nodeId, ctx = {}) {
  const fam = familyOf(data, dna);
  if (!fam) return ['This weapon has no tree'];
  const node = nodeOf(data, dna, nodeId);
  if (!node || node.hidden) return ['Unknown step'];
  const status = nodeStatus(data, dna, node);
  if (status === 'owned') return ['Already done'];
  if (status === 'closed') return ['Another path was chosen'];
  if (status !== 'next') return ['Take the steps before it first'];
  const out = [];
  for (const row of requirementsOf(data, save, dna, node, ctx)) {
    if (row.ok) continue;
    if (row.kind === 'bosses') out.push(`${row.label} first`);
    else if (row.kind === 'level') out.push(`Needs level ${node.requires.level}`);
    else out.push(`Needs ${row.label}`);
  }
  const { short } = costOf(data, save, node);
  for (const [k, n] of Object.entries(short)) out.push(`Needs ${n} more ${k}`);
  return out;
}

// --- Changing the weapon --------------------------------------------------------------

function ruleState(data, dna) {
  const archetype = data.byId.archetypes.get(dna.archetype);
  const rarity = data.byId.rarities.get(dna.rarity);
  const state = createRuleState(data, { archetype, rarity, element: dna.element });
  for (const m of dna.modifiers) {
    const def = data.byId.modifiers.get(m.id);
    if (def) addToState(def, state);
  }
  for (const e of dna.effects) {
    const def = data.byId.effects.get(e.id);
    if (def) addToState(def, state);
  }
  return state;
}

/** Drops modifiers and effects the weapon can no longer carry (a new type or element). */
function prune(data, dna) {
  const archetype = data.byId.archetypes.get(dna.archetype);
  const rarity = data.byId.rarities.get(dna.rarity);
  const state = createRuleState(data, { archetype, rarity, element: dna.element });
  const mods = [];
  for (const m of dna.modifiers) {
    const def = data.byId.modifiers.get(m.id);
    if (!def || incompatibility(def, state, 'modifier')) continue;
    addToState(def, state);
    mods.push(m);
  }
  const effects = [];
  for (const e of dna.effects) {
    const def = data.byId.effects.get(e.id);
    if (!def || incompatibility(def, state, 'effect')) continue;
    addToState(def, state);
    effects.push(e);
  }
  return { ...dna, modifiers: mods, effects };
}

/** Adds a modifier (or raises one the weapon has); when full, the weakest stat modifier is raised instead. */
function addModifier(data, dna, id, v) {
  const def = data.byId.modifiers.get(id);
  if (!def) return dna;
  const have = dna.modifiers.find((m) => m.id === id);
  if (have) {
    if (have.v >= v) return dna;
    return { ...dna, modifiers: dna.modifiers.map((m) => (m.id === id ? makeModifier(data, id, v) : m)) };
  }
  const max = data.byId.rarities.get(dna.rarity).modifiers[1];
  const state = ruleState(data, dna);
  if (dna.modifiers.length < max && !incompatibility(def, state, 'modifier')) {
    return { ...dna, modifiers: [...dna.modifiers, makeModifier(data, id, v)] };
  }
  return empower(data, dna, 0.25, 1);
}

/**
 * Raises modifiers by a share of their range (`count`: only the weakest
 * few). Never beyond half again their range's top.
 */
function empower(data, dna, share, count = Infinity) {
  const order = dna.modifiers
    .map((m, i) => ({ m, i, def: data.byId.modifiers.get(m.id) }))
    .filter((x) => x.def && x.def.kind !== 'element')
    .sort((a, b) => (a.m.v - a.def.range[0]) / (a.def.range[1] - a.def.range[0] || 1) - (b.m.v - b.def.range[0]) / (b.def.range[1] - b.def.range[0] || 1))
    .slice(0, count);
  if (!order.length) return dna;
  const mods = dna.modifiers.slice();
  for (const { m, i, def } of order) {
    const [lo, hi] = def.range;
    const step = def.step ?? 1;
    const raised = Math.min(hi * 1.5, m.v + Math.max(step, (hi - lo) * share));
    const v = Math.round(raised / step) * step;
    if (v > m.v) mods[i] = makeModifier(data, m.id, Number(v.toFixed(2)));
  }
  return { ...dna, modifiers: mods };
}

/** Tops modifiers up to the rarity's minimum (from the family's list, then the usual ones). */
function fillModifiers(data, dna, fam) {
  const [min] = data.byId.rarities.get(dna.rarity).modifiers;
  let out = dna;
  const pool = [...(fam.fill ?? []), 'dmg', 'critc', 'aspd', 'critd', 'range', 'swift', 'guard', 'fortune'];
  for (const id of pool) {
    if (out.modifiers.length >= min) break;
    if (out.modifiers.some((m) => m.id === id)) continue;
    const def = data.byId.modifiers.get(id);
    if (!def || incompatibility(def, ruleState(data, out), 'modifier')) continue;
    const v = Math.round((def.range[0] + (def.range[1] - def.range[0]) * 0.6) / (def.step ?? 1)) * (def.step ?? 1);
    out = { ...out, modifiers: [...out.modifiers, makeModifier(data, id, v)] };
  }
  return out;
}

/** Adds an effect; at the rarity's limit the oldest effect makes way. */
function addEffect(data, dna, id) {
  if (dna.effects.some((e) => e.id === id)) return dna;
  const def = data.byId.effects.get(id);
  if (!def) return dna;
  const max = Math.max(1, data.byId.rarities.get(dna.rarity).effects?.[1] ?? 1);
  let effects = dna.effects.slice();
  while (effects.length >= max) effects.shift();
  const trial = { ...dna, effects };
  if (incompatibility(def, ruleState(data, trial), 'effect')) return dna;
  effects = [...effects, makeEffect(data, id)];
  return { ...dna, effects };
}

/** A new element for the weapon: what clashes with it goes. */
function infuse(data, dna, element) {
  const mods = dna.modifiers.filter((m) => {
    const def = data.byId.modifiers.get(m.id);
    if (!def) return false;
    if (def.kind === 'element') return def.element === element;
    return true;
  });
  return prune(data, { ...dna, element, modifiers: mods });
}

/**
 * The material a form is made of: its own, unless the weapon already has a
 * better one that suits the new type (a lucky find stays yours).
 */
function formMaterial(data, dna, archetypeId, wanted) {
  const a = data.byId.archetypes.get(archetypeId);
  const fits = (m) => Boolean(m && a && m.kinds.some((k) => a.kinds.includes(k)));
  const cur = data.byId.materials.get(dna.material);
  const want = wanted ? data.byId.materials.get(wanted) : null;
  if (fits(cur) && (!fits(want) || (cur.tier ?? 0) > (want.tier ?? 0))) return cur.id;
  return fits(want) ? want.id : null;
}

/** The same weapon in another material: its rolled base stats follow the material's. */
function changeMaterial(data, dna, materialId) {
  const from = data.byId.materials.get(dna.material);
  const to = data.byId.materials.get(materialId);
  if (!from || !to || from === to) return dna;
  const r = (k) => (to.stats[k] ?? 1) / (from.stats[k] || 1);
  const b = dna.base;
  const base = {
    ...b,
    damage: Math.max(1, Math.round(b.damage * r('damage'))),
    attackSpeed: Math.round(b.attackSpeed * r('attackSpeed') * 100) / 100,
    range: Math.round(b.range * r('range') * 10) / 10,
    critChance: Math.max(0, Math.round(b.critChance + (to.stats.crit ?? 0) - (from.stats.crit ?? 0))),
  };
  return recomputeStats(data, { ...dna, material: to.id, base });
}

function raiseRarity(data, dna, rarity) {
  const cur = data.rarityIndex.get(dna.rarity) ?? 0;
  const want = data.rarityIndex.get(rarity) ?? 0;
  return want > cur ? { ...dna, rarity } : dna;
}

/** Level multiplier of base damage (the generator's growth). */
function levelMult(data, lvl) {
  return 1 + data.balance.levelDamageGrowth * (lvl - 1);
}

/** The weapon at another level: its base damage follows (tempering). */
export function atLevel(data, dna, lvl) {
  const from = dna.ctx?.lvl ?? 1;
  const to = Math.max(1, Math.min(99, Math.floor(lvl)));
  if (to === from) return dna;
  const base = { ...dna.base, damage: Math.max(1, Math.round(dna.base.damage * levelMult(data, to) / levelMult(data, from))) };
  return recomputeStats(data, { ...dna, base, ctx: { ...dna.ctx, lvl: to } });
}

/** What tempering to `toLevel` costs: { essence, scrap }. */
export function temperCost(data, fromLevel, toLevel) {
  const t = data.evolution.temper;
  let essence = 0;
  let scrap = 0;
  for (let l = fromLevel + 1; l <= toLevel; l++) {
    essence += t.essence + t.essencePerLevel * l;
    scrap += t.scrap + t.scrapPerLevel * l;
  }
  return { essence: Math.ceil(essence), scrap: Math.ceil(scrap) };
}

/** Tempering this weapon: the level it can reach now and the price ({ to, cost } or null). */
export function temperInfo(data, dna, playerLevel) {
  const evo = evoOf(data, dna);
  if (!evo) return null;
  const cur = dna.ctx?.lvl ?? 1;
  const cap = levelCap(data, evo.tier);
  const to = Math.min(cap, Math.floor(playerLevel));
  return { from: cur, to, cap, cost: to > cur ? temperCost(data, cur, to) : null };
}

/** The weapon tempered to `toLevel` (call temperInfo/the costs first). */
export function temper(data, dna, toLevel) {
  const evo = evoOf(data, dna);
  const out = atLevel(data, dna, toLevel);
  return { ...out, evo: { ...evo, path: evo.path.slice(), rev: (evo.rev ?? 0) + 1 } };
}

const ELEMENT_WORDS = {
  fire: 'of Embers', ice: 'of Frost', lightning: 'of Storms', void: 'of the Void', bleed: 'of Blood', poison: 'of Thorns',
  earth: 'of Stone', holy: 'of the Tides', wind: 'of Gales', arcane: 'of Stars',
};

/** What the weapon's name was made of when it was found: { text, format, words, archetype }. */
function nameOrigin(dna, prev) {
  if (prev.origin) return prev.origin;
  const n = dna.name ?? {};
  return { text: n.text ?? 'Weapon', format: n.format ?? null, words: n.words ?? null, archetype: dna.archetype };
}

/**
 * The name you found it with, its type word following the weapon's new
 * type ("Iron Warbow" becomes "Iron Arbalest" as a crossbow), the element
 * it was infused with ("… of Embers") and, at the end, Awakened.
 */
function evolvedName(data, dna, evo) {
  const o = evo.origin;
  let text = o.text;
  const a = data.byId.archetypes.get(dna.archetype);
  const [root, , noun, suffix] = o.words ?? [];
  if (a && o.archetype !== dna.archetype && o.words) {
    const pick = (list, salt) => (list?.length ? list[hashInts(dna.seed >>> 0, salt) % list.length] : null);
    if (['adj_noun', 'the_adj_noun', 'root_noun', 'title'].includes(o.format) && noun) {
      const at = text.lastIndexOf(noun);
      const next = pick(a.nouns, 0x6e6f);
      if (at >= 0 && next) text = text.slice(0, at) + next + text.slice(at + noun.length);
    } else if ((o.format === 'compound' || o.format === 'compound_epithet') && root && suffix) {
      const word = root[0].toUpperCase() + root.slice(1) + suffix;
      const next = pick(a.suffixes, 0x5f5f);
      if (next && text.startsWith(word)) text = word.slice(0, word.length - suffix.length) + next + text.slice(word.length);
    }
  }
  if (evo.path.some((n) => n.startsWith('awaken:'))) text = text.startsWith('The ') ? `The Awakened ${text.slice(4)}` : `Awakened ${text}`;
  const el = infusionOf(evo);
  // (Not on a name that already has an "of …" or an epithet.)
  if (el && ELEMENT_WORDS[el] && !/ of |, /.test(o.text)) text += ` ${ELEMENT_WORDS[el]}`;
  return { ...(dna.name ?? {}), text };
}

/**
 * The weapon after a step of its tree (pure: DNA in, new DNA out). Call
 * evolveBlockers first. ctx: { playerLevel } (it is tempered up to you, as
 * far as the new step allows).
 */
export function applyNode(data, dna, nodeId, ctx = {}) {
  const fam = familyOf(data, dna);
  const node = nodeOf(data, dna, nodeId);
  if (!fam || !node || node.hidden) throw new Error(`Unknown step ${nodeId}`);
  const prev = evoOf(data, dna);
  const tier = tierDef(data, node.tier);
  const evo = {
    family: fam.id,
    tier: node.tier,
    path: [...prev.path, node.id],
    rev: (prev.rev ?? 0) + 1,
    mult: {
      damage: (prev.mult?.damage ?? 1) * (tier.boost?.damage ?? 1),
      // How far above its rarity's usual power the weapon may go.
      ceiling: Math.round((prev.mult?.ceiling ?? 1) * (tier.ceiling ?? 1) * 1000) / 1000,
    },
    origin: nameOrigin(dna, prev),
  };
  // (On the weapon from the start: every recount of its stats sees the new ceiling.)
  let out = { ...dna, modifiers: dna.modifiers.slice(), effects: dna.effects.slice(), evo };
  out = raiseRarity(data, out, tier.rarity);
  const form = fam.forms.find((f) => f.id === (node.branch ?? branchOf(prev)));

  // A new weapon type (and material) for the form, or the cannon's Masterwork.
  const spec = node.kind === 'form' ? form : node.kind === 'mastery' ? form?.mastery : null;
  if (spec?.archetype) {
    const mat = formMaterial(data, out, spec.archetype, spec.material);
    if (spec.archetype !== out.archetype) {
      out = changeArchetype(data, out, spec.archetype, mat);
      // (The type's own base damage, with everything the tree has added so far.)
      out = { ...out, base: { ...out.base, damage: Math.max(1, Math.round(out.base.damage * (prev.mult?.damage ?? 1))) } };
      out = prune(data, out);
    } else if (mat && mat !== out.material) {
      out = changeMaterial(data, out, mat);
    }
  }
  // More damage, and the modifiers grow.
  out = { ...out, base: { ...out.base, damage: Math.max(1, Math.round(out.base.damage * (tier.boost?.damage ?? 1))) } };
  out = empower(data, out, tier.empower ?? 0.15);
  for (const [id, v] of tier.mods ?? []) out = addModifier(data, out, id, v);

  if (node.kind === 'form' || node.kind === 'mastery') {
    for (const [id, v] of spec?.mods ?? []) out = addModifier(data, out, id, v);
    for (const id of spec?.effects ?? []) out = addEffect(data, out, id);
  } else if (node.kind === 'infusion') {
    const inf = data.evolution.infusions.find((i) => i.element === node.element);
    out = infuse(data, out, node.element);
    for (const [id, v] of inf.mods) out = addModifier(data, out, id, v);
    out = addEffect(data, out, inf.effect);
  } else if (node.kind === 'awakening') {
    // A legendary power: the weapon needs an ability for it to rest on.
    if (!out.ability) {
      const pick = data.abilities.filter((a) => !data.gated.abilities.has(a.id));
      const tpl = pick[hashInts(dna.seed >>> 0, 0xa3a7e) % pick.length];
      out = { ...out, ability: makeAbility(data, tpl.id, { power: 0.8, element: out.element }) };
    }
    out = { ...out, signature: node.power };
  }
  out = fillModifiers(data, out, fam);
  out = recomputeStats(data, out);
  // Up to your level, as far as the new step allows.
  const cap = levelCap(data, node.tier);
  const want = Math.min(cap, Math.floor(ctx.playerLevel ?? 1));
  if (want > (out.ctx?.lvl ?? 1)) out = atLevel(data, out, want);
  out.name = evolvedName(data, out, evo);
  out.visual = { ...newLook(data, out, out.seed), evo: { tier: node.tier, branch: branchOf(evo), element: infusionOf(evo) } };
  return out;
}

/** The weapon as it would be after a step (for previews), or null if it can't be shown. */
export function previewNode(data, dna, nodeId) {
  try {
    return applyNode(data, dna, nodeId, { playerLevel: dna.ctx?.lvl ?? 1 });
  } catch {
    return null;
  }
}

export { dnaKey } from './dna.js';
