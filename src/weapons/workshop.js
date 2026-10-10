// The Weapon Workshop's toolbox: everything the generator does, one piece
// at a time, so a weapon can be changed freely and still be a well-formed
// Weapon DNA the game can use (modifiers, effects and abilities are built
// exactly like the generator builds them), plus a code that carries a whole
// weapon (PGX1.…), not only how to roll it (PGW1.…, see dna.js).

import { createRng, roundTo, clamp, hashString } from '../core/rng.js';
import { PROJECTILE_PATTERNS } from '../data/capabilities.js';
import { generateWeapon, regenerate, finalizeStats, collectPlayerBonuses, fillTemplate, resolveHooks } from './generator.js';
import { generateVisual, generateSound } from './visuals.js';
import { generateName } from './naming.js';
import { validateDna, serializeDna, decodeDnaCode, DNA_VERSION } from './dna.js';

export const FULL_CODE_PREFIX = 'PGX1.'; // deflated JSON
const PLAIN_CODE_PREFIX = 'PGX0.'; // plain JSON (browsers without CompressionStream)

const lerp = (range, t) => range[0] + (range[1] - range[0]) * t;
const mid = (range) => lerp(range, 0.5);

/** Every component unlocked: the workshop can use anything. */
export function allUnlocked(data) {
  return data.components.map((c) => c.id);
}

/**
 * A fresh weapon from the generator with the workshop's choices: any
 * rarity, type, material, element (through its core), ability, rune, level.
 * opts: { seed, level, luck, rarity, archetype, material, element, ability, rune, theme }
 */
export function forgeWeapon(data, opts = {}) {
  const seed = (opts.seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const core = opts.element && opts.element !== 'physical'
    ? data.components.find((c) => c.type === 'core' && c.element === opts.element)?.id ?? null
    : null;
  const crafted = opts.archetype || opts.material || opts.element || opts.ability || opts.rune;
  let craft = null;
  if (crafted) {
    const archetype = opts.archetype ?? data.archetypes[seed % data.archetypes.length].id;
    const a = data.byId.archetypes.get(archetype);
    const fits = data.materials.filter((m) => m.kinds.some((k) => a.kinds.includes(k)));
    const material = opts.material && fits.some((m) => m.id === opts.material) ? opts.material : fits[seed % fits.length]?.id;
    craft = { archetype, material, core, rune: opts.rune ?? null, ability: opts.ability ?? null };
  }
  const dna = generateWeapon(data, {
    seed, level: opts.level ?? 20, luck: opts.luck ?? 0, source: 'workshop', unlocked: allUnlocked(data),
    minRarity: opts.rarity ?? null, maxRarity: opts.rarity ?? null, theme: opts.theme ?? null, craft,
  });
  // A crafted weapon only gets an ability from epic up: the workshop gives it anyway.
  if (opts.ability && !dna.ability) dna.ability = makeAbility(data, opts.ability, { element: dna.element });
  return dna;
}

/** A modifier entry, as the generator writes it (v = its magnitude). */
export function makeModifier(data, id, v = null) {
  const def = data.byId.modifiers.get(id);
  if (!def) throw new Error(`Unknown modifier ${id}`);
  const value = v ?? Math.round(mid(def.range));
  const cost = Math.round((def.cost.base + def.cost.per * value) * 10) / 10;
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    kind: def.kind,
    v: value,
    cost,
    label: fillTemplate(def.label, value),
    ...(def.stat ? { stat: def.stat } : {}),
    ...(def.playerStat ? { playerStat: def.playerStat } : {}),
    ...(def.element ? { element: def.element } : {}),
    ...(def.hooks ? { hooks: resolveHooks(def.hooks, value) } : {}),
  };
}

export function makeEffect(data, id) {
  const def = data.byId.effects.get(id);
  if (!def) throw new Error(`Unknown effect ${id}`);
  return { id: def.id, name: def.name, desc: def.desc, cost: def.cost, hooks: resolveHooks(def.hooks, 0) };
}

export function makeDrawback(data, id, v = null) {
  const def = data.byId.drawbacks.get(id);
  if (!def) throw new Error(`Unknown drawback ${id}`);
  const value = v ?? Math.round(mid(def.range));
  return {
    id: def.id,
    name: def.name,
    v: value,
    refund: def.refund,
    label: fillTemplate(def.label, value),
    tags: def.tags ?? [],
    ...(def.playerStat ? { playerStat: def.playerStat } : {}),
    ...(def.hooks ? { hooks: resolveHooks(def.hooks, value) } : {}),
  };
}

/**
 * An ability entry like the generator's. opts: { power (0–1), element
 * (infusion), twist }.
 */
export function makeAbility(data, id, { power = 0.75, element = 'physical', twist = null } = {}) {
  const tpl = data.byId.abilities.get(id);
  if (!tpl) throw new Error(`Unknown ability ${id}`);
  const tw = twist ? data.abilityTwists.find((t) => t.id === twist) : null;
  const el = data.byId.elements.get(element);
  let prefix = el?.abilityPrefix ?? '';
  if (prefix && (tpl.affinity === element || tpl.name.toLowerCase().includes(prefix.toLowerCase()))) prefix = '';
  const p = clamp(power, 0, 1);
  return {
    id: tpl.id,
    action: tpl.do,
    name: [tw?.name, prefix, tpl.name].filter(Boolean).join(' '),
    desc: tpl.desc,
    infuse: element === 'physical' ? null : element,
    twist: tw?.id ?? null,
    twistDesc: tw?.desc ?? null,
    damage: Math.round(lerp(tpl.damage, p)),
    radius: roundTo(lerp(tpl.radius, p), 1),
    duration: roundTo(lerp(tpl.duration, p), 1),
    cooldown: roundTo(lerp(tpl.cooldown, 1 - p) * (tw?.id === 'swift' ? 0.75 : 1), 1),
    count: tpl.count ? Math.round(lerp(tpl.count, p)) : 0,
    range: tpl.range ? roundTo(lerp(tpl.range, p), 1) : 0,
    slow: tpl.slow ? Math.round(lerp(tpl.slow, p)) : 0,
    sound: tpl.sound,
    cost: roundTo(lerp(tpl.cost, p) + (tw?.cost ?? 0), 1),
  };
}

/** Level multiplier of a weapon's base damage (from its stored level). */
function levelMult(data, dna) {
  return 1 + data.balance.levelDamageGrowth * ((dna.ctx?.lvl ?? 1) - 1);
}

/**
 * Turns a weapon into another type: its attack, base stats, class and look
 * follow the new type (and material); modifiers, effects and ability stay.
 */
export function changeArchetype(data, dna, archetypeId, materialId = null) {
  const a = data.byId.archetypes.get(archetypeId);
  if (!a) throw new Error(`Unknown weapon type ${archetypeId}`);
  const fits = data.materials.filter((m) => m.kinds.some((k) => a.kinds.includes(k)));
  const material = data.byId.materials.get(materialId ?? dna.material);
  const mat = material && fits.includes(material) ? material : fits[0] ?? data.materials[0];
  const lm = levelMult(data, dna);
  const b = a.base;
  const base = {
    damage: mid(b.damage) * mat.stats.damage * lm,
    attackSpeed: mid(b.attackSpeed) * mat.stats.attackSpeed,
    range: mid(b.range) * mat.stats.range,
    critChance: mid(b.critChance) + mat.stats.crit,
    critDamage: mid(b.critDamage),
    projectileSpeed: 0,
    projectiles: 0,
    pierce: 0,
    homing: 0,
    knockback: a.tags.includes('heavy') ? 2 : a.class === 'melee' ? 1 : 0,
  };
  const attack = { pattern: a.attack.pattern };
  for (const key of ['arc', 'width', 'radius', 'blast']) {
    if (a.attack[key]) attack[key] = key === 'arc' ? Math.round(mid(a.attack[key])) : roundTo(mid(a.attack[key]), key === 'width' ? 2 : 1);
  }
  if (PROJECTILE_PATTERNS.has(a.attack.pattern)) {
    attack.projectile = a.attack.projectile;
    attack.size = a.attack.size ?? 2;
    attack.spread = a.attack.spread ?? 0;
    base.projectileSpeed = mid(a.attack.speed);
    base.projectiles = a.attack.count ?? 1;
    base.pierce = a.attack.pierce ?? 0;
    base.homing = a.attack.homing ?? 0;
  }
  const out = {
    ...dna,
    archetype: a.id,
    class: a.class,
    material: mat.id,
    attack,
    base: {
      damage: Math.round(base.damage),
      attackSpeed: roundTo(base.attackSpeed, 2),
      range: roundTo(base.range, 1),
      critChance: Math.round(base.critChance),
      critDamage: Math.round(base.critDamage),
      projectileSpeed: roundTo(base.projectileSpeed, 1),
      projectiles: base.projectiles,
      pierce: base.pierce,
      homing: base.homing,
      knockback: base.knockback,
    },
  };
  out.visual = newLook(data, out, dna.seed);
  out.sound = newSound(data, out, dna.seed);
  return recomputeStats(data, out);
}

/** Final stats from the base stats and the stat modifiers (the generator's rules and caps). */
export function recomputeStats(data, dna) {
  const a = data.byId.archetypes.get(dna.archetype);
  const rarity = data.byId.rarities.get(dna.rarity) ?? data.rarities[0];
  const base = {
    damage: dna.base.damage,
    attackSpeed: dna.base.attackSpeed,
    range: dna.base.range,
    critChance: dna.base.critChance,
    critDamage: dna.base.critDamage,
    projectileSpeed: dna.base.projectileSpeed ?? dna.stats.projectileSpeed ?? 0,
    projectiles: dna.base.projectiles ?? (PROJECTILE_PATTERNS.has(dna.attack.pattern) ? Math.max(1, dna.stats.projectiles - dna.modifiers.reduce((s, m) => s + (m.stat === 'projectiles' ? m.v : 0), 0)) : 0),
    pierce: dna.base.pierce ?? 0,
    homing: dna.base.homing ?? 0,
    knockback: dna.base.knockback ?? (a?.class === 'melee' ? 1 : 0),
  };
  const { stats, balanced } = finalizeStats(data, a, rarity, base, dna.modifiers, levelMult(data, dna));
  return { ...dna, stats, balanced, ...derived(data, { ...dna, stats }) };
}

/** What follows from the rest: player bonuses, tags, the power used. */
export function derived(data, dna) {
  const tags = new Set([dna.element, dna.class]);
  const add = (def) => def?.tags?.forEach((t) => tags.add(t));
  add(data.byId.archetypes.get(dna.archetype));
  for (const m of dna.modifiers) add(data.byId.modifiers.get(m.id));
  for (const e of dna.effects) add(data.byId.effects.get(e.id));
  for (const t of dna.drawback?.tags ?? []) tags.add(t);
  const used = dna.modifiers.reduce((s, m) => s + (m.cost ?? 0), 0) + dna.effects.reduce((s, e) => s + (e.cost ?? 0), 0) + (dna.ability?.cost ?? 0);
  const rarity = data.byId.rarities.get(dna.rarity);
  const budget = Math.max(rarity?.budget ?? 0, Math.round(used * 10) / 10);
  return {
    playerBonuses: collectPlayerBonuses(dna.modifiers, dna.drawback),
    tags: [...tags].filter(Boolean).sort(),
    power: { used: Math.round(used * 10) / 10, budget },
  };
}

function partsOf(data, dna) {
  const archetype = data.byId.archetypes.get(dna.archetype);
  const material = data.byId.materials.get(dna.material) ?? data.materials[0];
  const element = data.byId.elements.get(dna.element) ?? data.elements[0];
  const rarity = data.byId.rarities.get(dna.rarity) ?? data.rarities[0];
  return { archetype, material, element, rarity, rarityIdx: data.rarityIndex.get(rarity.id) ?? 0, stateTags: new Set(dna.tags ?? []) };
}

/** A new look for the weapon's type, material, element and rarity. */
export function newLook(data, dna, seed = Math.floor(Math.random() * 0xffffffff)) {
  return generateVisual(data, partsOf(data, dna), createRng(seed ^ 0x9157));
}

export function newSound(data, dna, seed = Math.floor(Math.random() * 0xffffffff)) {
  return generateSound(data, partsOf(data, dna), createRng(seed ^ 0x50d));
}

export function newName(data, dna, seed = Math.floor(Math.random() * 0xffffffff)) {
  const parts = partsOf(data, dna);
  const theme = data.themes.find((t) => t.id === dna.theme) ?? data.themes[0];
  return generateName(data, { archetype: parts.archetype, element: dna.element, rarityIdx: parts.rarityIdx, theme, modifiers: dna.modifiers, ability: dna.ability }, createRng(seed ^ 0x4a3e));
}

/** A copy with a new id, marked as made in the workshop. */
export function workshopCopy(dna) {
  const out = serializeDna(dna);
  out.id = `x${(Date.now() % 1e9).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  out.custom = true;
  return out;
}

/** Problems that would stop the game using this weapon (empty = fine). */
export function workshopProblems(data, dna) {
  const out = validateDna(dna);
  if (!data.byId.archetypes.get(dna.archetype)) out.push('unknown weapon type');
  if (!data.byId.rarities.get(dna.rarity)) out.push('unknown rarity');
  if (!data.byId.elements.get(dna.element)) out.push('unknown element');
  return out;
}

// --- Codes -------------------------------------------------------------------------

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '==='.slice((b64.length + 3) % 4);
  const bin = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** A code that carries the whole weapon, however it was made or changed. */
export async function encodeWeaponCode(dna) {
  const json = new TextEncoder().encode(JSON.stringify(serializeDna(dna)));
  if (typeof CompressionStream === 'function') {
    return FULL_CODE_PREFIX + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
  }
  return PLAIN_CODE_PREFIX + toBase64Url(json);
}

/**
 * Any weapon code back into a weapon: PGX1/PGX0 (the whole weapon) or PGW1
 * (rebuilt by the generator from its seed). Throws a readable error.
 */
export async function decodeWeaponCode(data, code) {
  const text = String(code ?? '').trim();
  let dna;
  try {
    if (text.startsWith(FULL_CODE_PREFIX) || text.startsWith(PLAIN_CODE_PREFIX)) {
      let bytes = fromBase64Url(text.slice(FULL_CODE_PREFIX.length));
      if (text.startsWith(FULL_CODE_PREFIX)) {
        if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open full weapon codes');
        bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
      }
      dna = JSON.parse(new TextDecoder().decode(bytes));
    } else {
      dna = regenerate(data, decodeDnaCode(text));
    }
  } catch (err) {
    throw new Error(err.message?.startsWith('This browser') ? err.message : 'That is not a weapon code (or it is damaged)');
  }
  if (dna?.v !== DNA_VERSION) throw new Error('That weapon code is from another version of the game');
  const problems = workshopProblems(data, dna);
  if (problems.length) throw new Error(`That weapon code is broken: ${problems[0]}`);
  return dna;
}

/** A short, stable fingerprint of a weapon (for tests and the panel). */
export function fingerprint(dna) {
  return hashString(JSON.stringify(serializeDna(dna))).toString(36);
}
