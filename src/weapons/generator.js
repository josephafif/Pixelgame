// Procedural weapon generator.
//
// Pipeline (see README / spec §14):
//   1 seed → 2 archetype → 3 base stats (material, element) → 4 rarity
//   (+ theme / composition plan) → 5 modifiers → 6 special effects →
//   7 ability → balance pass → 8 visuals + sound → 9 name → 10 DNA
//
// Every stage draws from its own RNG stream derived from (seed, stage) so
// adding content to one stage never reshuffles the others. The generator is
// a pure function of (data, request): it runs in a Web Worker, on the main
// thread as a fallback, and in Node tests. It never uses unseeded randomness
// or transcendental Math functions, so the same seed + context produces the
// same weapon on every device.

import { createRng, deriveSeed, roundTo, clamp, hashString } from '../core/rng.js';
import { PROJECTILE_PATTERNS } from '../data/capabilities.js';
import { buildPool } from './pool.js';
import { createRuleState, incompatibility, addToState } from './rules.js';
import { generateName } from './naming.js';
import { generateVisual, generateSound } from './visuals.js';
import { DNA_VERSION } from './dna.js';

export const GENERATOR_VERSION = 1;

// How strongly a weapon's theme (build identity) pulls matching modifiers
// and effects. High enough that most weapons read as a clear build.
const THEME_BIAS = 6;

const lerp = (range, t) => range[0] + (range[1] - range[0]) * t;
const stageRng = (seed, stage) => createRng(deriveSeed(seed, stage));

/** Canonical, serialisable generation context (stored in the DNA). */
export function normalizeContext(req = {}) {
  const c = req.craft;
  return {
    lvl: clamp(Math.floor(req.level ?? 1), 1, 99),
    luck: clamp(Math.floor(req.luck ?? 0), 0, 200),
    src: req.source ?? 'drop',
    pool: [...new Set(req.unlocked ?? [])].sort(),
    min: req.minRarity ?? null,
    max: req.maxRarity ?? null,
    theme: req.theme ?? null,
    bias: [...new Set(req.elementBias ?? [])].sort(),
    craft: c
      ? {
          archetype: c.archetype ?? null,
          material: c.material ?? null,
          core: c.core ?? null,
          rune: c.rune ?? null,
          ability: c.ability ?? null,
        }
      : null,
  };
}

/** Inverse of normalizeContext: turns a stored ctx back into a request. */
export function requestFromContext(seed, ctx) {
  return {
    seed,
    level: ctx.lvl,
    luck: ctx.luck,
    source: ctx.src,
    unlocked: ctx.pool,
    minRarity: ctx.min,
    maxRarity: ctx.max,
    theme: ctx.theme,
    elementBias: ctx.bias,
    craft: ctx.craft,
  };
}

// --- Power budget arithmetic -------------------------------------------------
// Costs are tracked in integer tenths so budget comparisons are exact.

const cost10 = (def, v) => Math.round((def.cost.base + def.cost.per * v) * 10);
const minCost10 = (def) => cost10(def, def.range[0]);

function quantize(def, raw) {
  const step = def.step ?? 1;
  const n = Math.round((raw - def.range[0]) / step);
  return clamp(def.range[0] + n * step, Math.min(...def.range), Math.max(...def.range));
}

function rollMagnitude(def, rarity, rng) {
  const t = lerp(rarity.magnitude, rng.next());
  return quantize(def, lerp(def.range, t));
}

/** Largest magnitude <= wanted that fits in `available10`, or null. */
function fitMagnitude(def, wanted, available10) {
  const step = def.step ?? 1;
  let v = wanted;
  while (v >= def.range[0]) {
    if (cost10(def, v) <= available10) return v;
    if (def.cost.per <= 0) return null;
    v -= step;
  }
  return null;
}

function fillTemplate(template, v) {
  return template.replace('{v}', String(v));
}

function resolveHooks(hooks, v) {
  if (!hooks) return undefined;
  return hooks.map((h) => {
    const out = {};
    for (const [k, val] of Object.entries(h)) out[k] = val === '$v' ? v : val;
    return out;
  });
}

// --- Stages ------------------------------------------------------------------

function pickArchetype(data, pool, ctx, seed) {
  if (ctx.craft?.archetype) {
    const a = data.byId.archetypes.get(ctx.craft.archetype);
    if (!a) throw new Error(`Unknown blueprint archetype ${ctx.craft.archetype}`);
    return a;
  }
  return stageRng(seed, 'archetype').weighted(pool.archetypes);
}

function pickMaterial(data, pool, archetype, ctx, seed) {
  if (ctx.craft?.material) {
    const m = data.byId.materials.get(ctx.craft.material);
    if (!m || !m.kinds.some((k) => archetype.kinds.includes(k))) {
      throw new Error(`Material ${ctx.craft.material} does not fit ${archetype.id}`);
    }
    return m;
  }
  const fits = pool.materials.filter((m) => m.kinds.some((k) => archetype.kinds.includes(k)));
  return stageRng(seed, 'material').weighted(fits);
}

function pickElement(data, material, ctx, coreDef, seed) {
  if (ctx.craft) return coreDef?.element ?? 'physical';
  const rng = stageRng(seed, 'element');
  return rng.weighted(data.elements, (e) =>
    e.weight * (material.tags.includes(e.id) ? 2 : 1) * (ctx.bias.includes(e.id) ? 2.5 : 1)).id;
}

function rollBase(data, archetype, material, ctx, seed) {
  const rng = stageRng(seed, 'stats');
  const b = archetype.base;
  const levelMult = 1 + data.balance.levelDamageGrowth * (ctx.lvl - 1);
  const base = {
    damage: lerp(b.damage, rng.next()) * material.stats.damage * levelMult,
    attackSpeed: lerp(b.attackSpeed, rng.next()) * material.stats.attackSpeed,
    range: lerp(b.range, rng.next()) * material.stats.range,
    critChance: lerp(b.critChance, rng.next()) + material.stats.crit,
    critDamage: lerp(b.critDamage, rng.next()),
    projectileSpeed: 0,
    projectiles: 0,
    pierce: 0,
    homing: 0,
    knockback: archetype.tags.includes('heavy') ? 2 : archetype.class === 'melee' ? 1 : 0,
  };
  const a = archetype.attack;
  const ar = stageRng(seed, 'attack');
  const attack = { pattern: a.pattern };
  if (a.arc) attack.arc = Math.round(lerp(a.arc, ar.next()));
  if (a.width) attack.width = roundTo(lerp(a.width, ar.next()), 2);
  if (a.radius) attack.radius = roundTo(lerp(a.radius, ar.next()), 1);
  if (a.blast) attack.blast = roundTo(lerp(a.blast, ar.next()), 1);
  if (PROJECTILE_PATTERNS.has(a.pattern)) {
    attack.projectile = a.projectile;
    attack.size = a.size ?? 2;
    attack.spread = a.spread ?? 0;
    base.projectileSpeed = lerp(a.speed, ar.next());
    base.projectiles = a.count ?? 1;
    base.pierce = a.pierce ?? 0;
    base.homing = a.homing ?? 0;
  }
  return { base, attack, levelMult };
}

function rollRarity(data, ctx, coreDef, seed) {
  const last = data.rarities.length - 1;
  let minIdx = ctx.min ? data.rarityIndex.get(ctx.min) : 0;
  const maxIdx = ctx.max ? data.rarityIndex.get(ctx.max) : last;
  if (coreDef?.rarityBonus) minIdx += coreDef.rarityBonus;
  minIdx = clamp(minIdx, 0, maxIdx);
  const luckFactor = ctx.luck * 0.03 + (ctx.lvl - 1) * 0.02;
  const candidates = data.rarities.slice(minIdx, maxIdx + 1);
  return stageRng(seed, 'rarity').weighted(candidates, (r) =>
    r.weight * (1 + luckFactor * data.rarityIndex.get(r.id)));
}

function pickTheme(data, archetype, rarityIdx, elementId, ctx, craftTags, seed) {
  const rng = stageRng(seed, 'theme');
  const themes = data.themes.filter((t) =>
    (!t.classes || t.classes.includes(archetype.class))
    && (!t.minRarity || data.rarityIndex.get(t.minRarity) <= rarityIdx)
    && (!t.elements || t.elements.includes(elementId) || (!ctx.craft && elementId === 'physical')));
  const theme = rng.weighted(themes, (t) =>
    t.weight
    * (ctx.theme === t.id ? 8 : 1)
    * (craftTags.some((tag) => t.tags.includes(tag)) ? 4 : 1)
    * (elementId !== 'physical' && t.elements?.includes(elementId) ? 3 : 1));
  // A physical weapon that rolls an elemental theme takes on that element.
  const element = theme.elements && !theme.elements.includes(elementId) ? rng.pick(theme.elements) : elementId;
  return { theme, element };
}

function planComposition(data, rarity, rarityIdx, theme, ctx, seed) {
  const rng = stageRng(seed, 'plan');
  const modCount = rng.int(rarity.modifiers[0], rarity.modifiers[1]);
  const [eMin, eMax] = rarity.effects;
  const effectCount = eMin + (eMax > eMin && rng.chance(rarity.effectChance) ? rng.int(1, eMax - eMin) : 0);
  const hasAbility = ctx.craft?.ability ? rarityIdx >= 3 : rng.chance(rarity.abilityChance);
  let drawback = null;
  if (theme.forceDrawback || rng.chance(rarity.drawbackChance)) {
    const def = theme.drawback ? data.byId.drawbacks.get(theme.drawback) : rng.pick(data.drawbacks);
    const v = quantize(def, lerp(def.range, rng.next()));
    drawback = {
      id: def.id,
      name: def.name,
      v,
      refund: def.refund,
      label: fillTemplate(def.label, v),
      tags: def.tags ?? [],
      ...(def.playerStat ? { playerStat: def.playerStat } : {}),
      ...(def.hooks ? { hooks: resolveHooks(def.hooks, v) } : {}),
    };
  }
  return { modCount, effectCount, hasAbility, drawback };
}

function selectModifiers(data, pool, state, plan, budget, ctx, theme, craftTags, seed) {
  const rng = stageRng(seed, 'modifiers');
  const { rarity } = state;
  const themeTags = new Set(theme.tags);
  const craftTagSet = new Set(craftTags);
  const minMods = rarity.modifiers[0];
  const chosen = [];
  let behaviors = 0;

  const weightOf = (m) =>
    m.weight
    * (m.tags.some((t) => themeTags.has(t)) ? THEME_BIAS : 1)
    * (craftTagSet.size && m.tags.some((t) => craftTagSet.has(t)) ? 2 : 1)
    * (m.statusElement && m.statusElement === state.element ? 2 : 1)
    * (m.kind === 'element' && m.element === state.element ? 0.5 : 1);

  const take = (def, v) => {
    const c = cost10(def, v);
    budget.used10 += c;
    addToState(def, state);
    if (def.kind !== 'stat') behaviors++;
    chosen.push({
      id: def.id,
      name: def.name,
      category: def.category,
      kind: def.kind,
      v,
      cost: c / 10,
      label: fillTemplate(def.label, v),
      ...(def.stat ? { stat: def.stat } : {}),
      ...(def.playerStat ? { playerStat: def.playerStat } : {}),
      ...(def.element ? { element: def.element } : {}),
      ...(def.hooks ? { hooks: resolveHooks(def.hooks, v) } : {}),
    });
  };

  // Crafting rune: a guaranteed modifier chosen by the player.
  if (ctx.craft?.rune) {
    const def = data.byId.modifiers.get(ctx.craft.rune);
    if (def && !incompatibility(def, state, 'modifier')) {
      const wanted = rollMagnitude(def, rarity, rng);
      const v = fitMagnitude(def, wanted, budget.total10 - budget.used10 - budget.reserveLater10)
        ?? fitMagnitude(def, wanted, budget.total10 - budget.used10 - budget.abilityReserve10);
      if (v !== null) take(def, v);
    }
  }

  for (let i = chosen.length; i < plan.modCount; i++) {
    const compatible = pool.modifiers.filter((m) => !incompatibility(m, state, 'modifier'));
    if (!compatible.length) break;
    const cheapest = Math.min(...compatible.map(minCost10));
    const requiredAfter = Math.max(0, minMods - i - 1);
    // Behaviour-changing modifiers required by the rarity are picked first,
    // while the whole budget is still available.
    const mustBehave = behaviors < plan.minBehavior;

    const attempt = (reserveLater, behaveOnly) => {
      const available = budget.total10 - budget.used10 - requiredAfter * cheapest - reserveLater;
      let cands = compatible.filter((m) => minCost10(m) <= available);
      if (behaveOnly) cands = cands.filter((m) => m.kind !== 'stat');
      return { cands, available };
    };
    // Priority when the budget is tight: the rarity's minimum modifier count
    // and behaviour-changing modifiers, then a planned ability, then effects.
    let { cands, available } = attempt(budget.reserveLater10, mustBehave);
    if (!cands.length && i < minMods) {
      ({ cands, available } = attempt(budget.requiredEffectReserve10 + budget.abilityReserve10, mustBehave));
    }
    if (!cands.length && i < minMods) ({ cands, available } = attempt(budget.requiredEffectReserve10, mustBehave));
    if (!cands.length && i < minMods) ({ cands, available } = attempt(0, mustBehave));
    if (!cands.length && mustBehave) ({ cands, available } = attempt(0, false));
    if (!cands.length) break;

    const def = rng.weighted(cands, weightOf);
    const v = fitMagnitude(def, rollMagnitude(def, rarity, rng), available);
    if (v === null) break;
    take(def, v);
  }
  return chosen;
}

function selectEffects(data, pool, state, plan, budget, theme, coreDef, seed) {
  const rng = stageRng(seed, 'effects');
  const themeTags = new Set(theme.tags);
  const coreEffects = new Set(coreDef?.unlocks?.effects ?? []);
  const chosen = [];
  for (let i = 0; i < plan.effectCount; i++) {
    // The rarity's required effects come before a planned ability; optional
    // extra effects only use what the ability doesn't need.
    const reserve = i < budget.requiredEffects ? 0 : budget.abilityReserve10;
    const available = budget.total10 - budget.used10 - reserve;
    const cands = pool.effects.filter((e) => !incompatibility(e, state, 'effect') && e.cost * 10 <= available);
    if (!cands.length) break;
    const def = rng.weighted(cands, (e) =>
      e.weight
      * (e.tags.some((t) => themeTags.has(t)) ? THEME_BIAS : 1)
      * (coreEffects.has(e.id) ? 6 : 1)
      * (e.element && e.element === state.element ? 3 : 1));
    budget.used10 += def.cost * 10;
    addToState(def, state);
    chosen.push({ id: def.id, name: def.name, desc: def.desc, cost: def.cost, hooks: resolveHooks(def.hooks, 0) });
  }
  return chosen;
}

function generateAbility(data, pool, state, budget, rarityIdx, ctx, coreDef, seed) {
  const rng = stageRng(seed, 'ability');
  const rarity = state.rarity;
  const available10 = budget.total10 - budget.used10;
  let templates = ctx.craft?.ability
    ? [data.byId.abilities.get(ctx.craft.ability)].filter(Boolean)
    : pool.abilities;
  templates = templates.filter((a) => a.cost[0] * 10 <= available10);
  if (!templates.length) return null;
  const coreAbilities = new Set(coreDef?.unlocks?.abilities ?? []);
  const tpl = rng.weighted(templates, (a) =>
    a.weight * (a.affinity === state.element ? 3 : 1) * (coreAbilities.has(a.id) ? 4 : 1));

  let p = lerp(rarity.magnitude, rng.next());
  let c10 = Math.round(lerp(tpl.cost, p) * 10);
  if (c10 > available10) {
    p = tpl.cost[1] > tpl.cost[0] ? (available10 / 10 - tpl.cost[0]) / (tpl.cost[1] - tpl.cost[0]) : 0;
    p = clamp(p, 0, 1);
    c10 = Math.min(available10, Math.round(lerp(tpl.cost, p) * 10));
  }
  const cooldownRoll = rng.next();

  let twist = null;
  if (rarityIdx >= data.rarities.length - 1 && rng.chance(0.45)) {
    const twists = data.abilityTwists.filter((t) =>
      (!t.only || t.only.includes(tpl.id))
      && !(t.exclude ?? []).includes(tpl.id)
      && t.cost * 10 <= available10 - c10);
    if (twists.length) twist = rng.weighted(twists);
  }
  const element = data.byId.elements.get(state.element);
  let prefix = element?.abilityPrefix ?? '';
  // "Frost Glacial Nova" / "Storm Storm Call" read badly: no prefix when the
  // ability already belongs to that element or already contains the word.
  if (prefix && (tpl.affinity === state.element || tpl.name.toLowerCase().includes(prefix.toLowerCase()))) prefix = '';
  const name = [twist?.name, prefix, tpl.name].filter(Boolean).join(' ');
  const cooldown = lerp(tpl.cooldown, clamp(0.5 * p + 0.5 * cooldownRoll, 0, 1)) * (twist?.id === 'swift' ? 0.75 : 1);
  const total10 = c10 + (twist ? twist.cost * 10 : 0);
  budget.used10 += total10;
  return {
    id: tpl.id,
    action: tpl.do,
    name,
    desc: tpl.desc,
    infuse: state.element === 'physical' ? null : state.element,
    twist: twist?.id ?? null,
    twistDesc: twist?.desc ?? null,
    damage: Math.round(lerp(tpl.damage, p)),
    radius: roundTo(lerp(tpl.radius, p), 1),
    duration: roundTo(lerp(tpl.duration, p), 1),
    cooldown: roundTo(cooldown, 1),
    count: tpl.count ? Math.round(lerp(tpl.count, p)) : 0,
    range: tpl.range ? roundTo(lerp(tpl.range, p), 1) : 0,
    slow: tpl.slow ? Math.round(lerp(tpl.slow, p)) : 0,
    sound: tpl.sound,
    cost: total10 / 10,
  };
}

const critFactor = (chance, dmg) => 1 + (chance / 100) * (dmg / 100 - 1);

/** Applies modifiers to base stats, enforces caps and the rating ceiling. */
function finalizeStats(data, archetype, rarity, base, modifiers, levelMult) {
  const caps = data.balance.caps;
  const totals = {};
  for (const m of modifiers) if (m.stat) totals[m.stat] = (totals[m.stat] ?? 0) + m.v;
  const t = (k) => totals[k] ?? 0;

  const stats = {
    damage: base.damage * rarity.statMult * (1 + Math.min(t('damagePct'), caps.damagePct) / 100),
    attackSpeed: Math.min(caps.attackSpeed, base.attackSpeed * (1 + t('attackSpeedPct') / 100)),
    range: Math.min(caps.range, base.range * (1 + t('rangePct') / 100)),
    critChance: Math.min(caps.critChance, base.critChance + t('critChance')),
    critDamage: Math.min(caps.critDamage, base.critDamage + t('critDamage')),
    projectileSpeed: base.projectileSpeed * (1 + t('projectileSpeedPct') / 100),
    projectiles: Math.min(caps.projectiles, base.projectiles + t('projectiles')),
    pierce: base.pierce >= 99 ? 99 : Math.min(caps.pierce, base.pierce + t('pierce')),
    homing: base.homing > 0 || t('homing') > 0 ? 1 : 0,
    knockback: base.knockback + t('knockback'),
    split: t('split'),
  };

  // Rating ceiling: stops stacked stat modifiers from creating a weapon far
  // above what its rarity tier should deal. Mechanics are budgeted separately.
  const b = archetype.base;
  const mid = (r) => (r[0] + r[1]) / 2;
  const baseProj = Math.max(1, base.projectiles);
  const projFactor = 1 + (0.6 * Math.max(0, stats.projectiles - baseProj)) / baseProj;
  const rating = stats.damage * stats.attackSpeed * critFactor(stats.critChance, stats.critDamage) * projFactor;
  const baseline = mid(b.damage) * mid(b.attackSpeed) * critFactor(mid(b.critChance), mid(b.critDamage)) * levelMult;
  const ceiling = baseline * rarity.ratingCap * 1.15;
  let balanced = false;
  if (rating > ceiling) {
    stats.damage *= ceiling / rating;
    balanced = true;
  }
  return {
    stats: {
      damage: Math.max(1, Math.round(stats.damage)),
      attackSpeed: roundTo(stats.attackSpeed, 2),
      range: roundTo(stats.range, 1),
      critChance: Math.round(stats.critChance),
      critDamage: Math.round(stats.critDamage),
      projectileSpeed: roundTo(stats.projectileSpeed, 1),
      projectiles: stats.projectiles,
      pierce: stats.pierce,
      homing: stats.homing,
      knockback: stats.knockback,
      split: stats.split,
    },
    balanced,
  };
}

function collectPlayerBonuses(modifiers, drawback) {
  const bonuses = {};
  for (const m of [...modifiers, ...(drawback ? [drawback] : [])]) {
    if (m.playerStat) bonuses[m.playerStat] = (bonuses[m.playerStat] ?? 0) + m.v;
  }
  return bonuses;
}

/**
 * Generates a complete weapon DNA.
 * @param {object} data indexed game data
 * @param {object} request { seed, level, luck, source, unlocked, minRarity,
 *   maxRarity, theme, elementBias, craft }
 */
export function generateWeapon(data, request) {
  const seed = request.seed >>> 0; // 1. seed
  const ctx = normalizeContext(request);
  const pool = buildPool(data, ctx.pool);
  ctx.pool = pool.unlocked;
  const coreDef = ctx.craft?.core ? data.byId.components.get(ctx.craft.core) ?? null : null;
  const craftTags = coreDef ? coreDef.craftTags ?? [coreDef.element] : [];

  const archetype = pickArchetype(data, pool, ctx, seed); // 2.
  const material = pickMaterial(data, pool, archetype, ctx, seed); // 3.
  let elementId = pickElement(data, material, ctx, coreDef, seed);
  const { base, attack, levelMult } = rollBase(data, archetype, material, ctx, seed);

  const rarity = rollRarity(data, ctx, coreDef, seed); // 4.
  const rarityIdx = data.rarityIndex.get(rarity.id);
  const picked = pickTheme(data, archetype, rarityIdx, elementId, ctx, craftTags, seed);
  const theme = picked.theme;
  elementId = picked.element;
  const plan = planComposition(data, rarity, rarityIdx, theme, ctx, seed);
  plan.minBehavior = rarity.minBehavior;

  const state = createRuleState(data, { archetype, rarity, element: elementId });
  for (const tag of plan.drawback?.tags ?? []) state.tags.add(tag);

  // Reserve enough that *any* ability template fits at its minimum power;
  // reserving only the cheapest would make that one ability dominate.
  const forcedAbility = ctx.craft?.ability ? data.byId.abilities.get(ctx.craft.ability) : null;
  const abilityReserve10 = !plan.hasAbility ? 0
    : forcedAbility ? forcedAbility.cost[0] * 10
      : pool.abilities.length ? Math.max(...pool.abilities.map((a) => a.cost[0] * 10)) : 0;
  // Reserve room for the planned effects, priced by the most expensive effect
  // that can actually go on this weapon (modifiers can only narrow that set).
  // Pricing by the cheapest one would leave room for nothing else, and the
  // cheapest effect would end up on almost every weapon.
  const fittingEffects = pool.effects.filter((e) => !incompatibility(e, state, 'effect'));
  const effectPrice10 = fittingEffects.length ? Math.max(...fittingEffects.map((e) => e.cost * 10)) : 0;
  const requiredEffects = Math.min(plan.effectCount, rarity.effects[0]);
  const budget = {
    total10: (rarity.budget + (plan.drawback?.refund ?? 0)) * 10,
    used10: 0,
    requiredEffects,
    // What later steps still need, from most to least important.
    requiredEffectReserve10: requiredEffects * effectPrice10,
    abilityReserve10,
    reserveLater10: abilityReserve10 + plan.effectCount * effectPrice10,
  };

  const modifiers = selectModifiers(data, pool, state, plan, budget, ctx, theme, craftTags, seed); // 5.
  const effects = selectEffects(data, pool, state, plan, budget, theme, coreDef, seed); // 6.
  const ability = plan.hasAbility // 7.
    ? generateAbility(data, pool, state, budget, rarityIdx, ctx, coreDef, seed)
    : null;

  const { stats, balanced } = finalizeStats(data, archetype, rarity, base, modifiers, levelMult);
  const element = data.byId.elements.get(state.element);

  const visual = generateVisual(data, { // 8.
    archetype, material, element, rarity, rarityIdx, stateTags: state.tags,
  }, stageRng(seed, 'visual'));
  const sound = generateSound(data, { archetype, element, rarityIdx }, stageRng(seed, 'sound'));
  const name = generateName(data, { // 9.
    archetype, element: state.element, rarityIdx, theme, modifiers, ability,
  }, stageRng(seed, 'name'));

  const ctxHash = hashString(JSON.stringify(ctx));
  return { // 10. DNA
    v: DNA_VERSION,
    id: `w${seed.toString(36)}${(ctxHash & 0xfffff).toString(36)}`,
    seed,
    gen: GENERATOR_VERSION,
    data: data.dataVersion,
    ctx,
    archetype: archetype.id,
    class: archetype.class,
    rarity: rarity.id,
    theme: theme.id,
    identity: theme.label,
    material: material.id,
    element: state.element,
    attack,
    base: {
      damage: Math.round(base.damage),
      attackSpeed: roundTo(base.attackSpeed, 2),
      range: roundTo(base.range, 1),
      critChance: Math.round(base.critChance),
      critDamage: Math.round(base.critDamage),
    },
    stats,
    balanced,
    playerBonuses: collectPlayerBonuses(modifiers, plan.drawback),
    modifiers,
    effects,
    drawback: plan.drawback,
    ability,
    power: { used: budget.used10 / 10, budget: budget.total10 / 10 },
    visual,
    sound,
    name,
    tags: [...state.tags].sort(),
  };
}

/** Rebuilds a weapon from its seed and context (e.g. from a share code). */
export function regenerate(data, { seed, gen, ctx }) {
  if (gen !== GENERATOR_VERSION) {
    throw new Error(`Weapon was made by generator v${gen}; this client runs v${GENERATOR_VERSION}`);
  }
  return generateWeapon(data, requestFromContext(seed, ctx));
}
