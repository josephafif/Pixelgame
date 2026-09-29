import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateWeapon, regenerate, normalizeContext, requestFromContext, GENERATOR_VERSION } from '../../src/weapons/generator.js';
import { auditWeapon } from '../../src/weapons/rules.js';
import { validateDna, encodeDnaCode, decodeDnaCode, serializeDna } from '../../src/weapons/dna.js';
import { buildPool } from '../../src/weapons/pool.js';
import { hashString } from '../../src/core/rng.js';
import { loadData, allComponentIds, seeds, ROOT } from './helpers.js';

const data = loadData();

function sweep(n, extra = {}, salt = 1) {
  return seeds(n, salt).map((seed, i) => generateWeapon(data, {
    seed, level: 1 + (i % 25), luck: i % 40, ...extra,
  }));
}

test('same seed + context always produces the identical weapon', () => {
  for (const seed of seeds(50)) {
    const req = { seed, level: 7, luck: 3, unlocked: ['fire_core', 'bp_gun'] };
    assert.deepEqual(generateWeapon(data, req), generateWeapon(data, req));
  }
});

test('golden weapons: generation is stable (update deliberately + bump GENERATOR_VERSION)', () => {
  const a = generateWeapon(data, { seed: 83920174, level: 5 });
  assert.equal(a.name.text, 'Storm Staff');
  assert.equal(a.archetype, 'staff');
  assert.equal(a.rarity, 'rare');
  assert.equal(a.element, 'lightning');
  assert.equal(a.stats.damage, 33);
  assert.deepEqual(a.modifiers.map((m) => `${m.id}:${m.v}`), ['e_fire:35', 'multishot:2', 'critc:6']);
  assert.equal(hashString(JSON.stringify(a)).toString(16), '9c15198');

  const b = generateWeapon(data, { seed: 1, level: 1, minRarity: 'legendary' });
  assert.equal(b.name.text, 'The Frozen Warden');
  assert.equal(b.ability.id, 'blink');
  assert.equal(hashString(JSON.stringify(b)).toString(16), '5636a40');
});

test('weapons can be rebuilt from seed + context (DNA codes)', () => {
  for (const dna of sweep(40, { unlocked: allComponentIds(data) }, 3)) {
    const code = encodeDnaCode(dna);
    const inputs = decodeDnaCode(code);
    assert.deepEqual(regenerate(data, inputs), dna);
  }
  assert.throws(() => regenerate(data, { seed: 1, gen: GENERATOR_VERSION + 1, ctx: normalizeContext({}) }));
  assert.throws(() => decodeDnaCode('not-a-code'));
});

test('context normalisation round-trips', () => {
  const ctx = normalizeContext({ level: 3.7, luck: 5, unlocked: ['b', 'a', 'a'], elementBias: ['ice'], craft: { archetype: 'sword', material: 'iron' } });
  assert.deepEqual(ctx.pool, ['a', 'b']);
  assert.equal(ctx.lvl, 3);
  assert.deepEqual(normalizeContext(requestFromContext(1, ctx)), ctx);
});

test('every generated weapon is valid DNA and passes the combination rules', () => {
  for (const dna of sweep(2500, { unlocked: allComponentIds(data) })) {
    assert.deepEqual(validateDna(dna), [], dna.id);
    assert.deepEqual(auditWeapon(data, dna), [], `${dna.id} ${dna.name.text}`);
    assert.deepEqual(serializeDna(dna), dna);
  }
});

test('power budget, modifier counts and rarity guarantees hold', () => {
  const byRarity = new Map(data.rarities.map((r) => [r.id, r]));
  for (const dna of sweep(3000)) {
    const r = byRarity.get(dna.rarity);
    assert.ok(dna.power.used <= dna.power.budget, `${dna.id} over budget`);
    assert.ok(dna.modifiers.length >= r.modifiers[0] && dna.modifiers.length <= r.modifiers[1], `${dna.rarity} mods ${dna.modifiers.length}`);
    assert.ok(dna.effects.length >= r.effects[0], `${dna.rarity} effects ${dna.effects.length}`);
    const behaviours = dna.modifiers.filter((m) => m.kind !== 'stat').length;
    assert.ok(behaviours >= r.minBehavior, `${dna.id} needs ${r.minBehavior} behaviour modifiers`);
    if (dna.rarity === 'legendary') assert.ok(dna.ability, 'legendaries always get an ability');
    if (dna.rarity === 'common') assert.equal(dna.ability, null);
    for (const [k, v] of Object.entries(dna.stats)) assert.ok(Number.isFinite(v) && v >= 0, `${k}=${v}`);
    assert.ok(dna.stats.damage > 0 && dna.stats.attackSpeed > 0);
    assert.ok(dna.stats.attackSpeed <= data.balance.caps.attackSpeed);
    assert.ok(dna.stats.critChance <= data.balance.caps.critChance);
  }
});

test('higher rarity means more budget and complexity, not just more damage', () => {
  const weapons = sweep(3000);
  const avg = (id, fn) => {
    const list = weapons.filter((w) => w.rarity === id);
    return list.reduce((s, w) => s + fn(w), 0) / list.length;
  };
  assert.ok(avg('legendary', (w) => w.power.budget) > avg('common', (w) => w.power.budget));
  assert.ok(avg('legendary', (w) => w.modifiers.length + w.effects.length) > avg('rare', (w) => w.modifiers.length + w.effects.length));
  // A strong common can out-damage a weak legendary.
  const commons = weapons.filter((w) => w.rarity === 'common').map((w) => w.stats.damage);
  const legendaries = weapons.filter((w) => w.rarity === 'legendary').map((w) => w.stats.damage);
  assert.ok(Math.max(...commons) > Math.min(...legendaries));
});

test('contradictory and impossible combinations never appear', () => {
  for (const dna of sweep(2500, { unlocked: allComponentIds(data) }, 7)) {
    const ids = new Set([...dna.modifiers, ...dna.effects].map((m) => m.id));
    assert.ok(!(ids.has('burning') && ids.has('freezing')), 'burning + freezing');
    const els = new Set([dna.element, ...dna.modifiers.filter((m) => m.element).map((m) => m.element)]);
    assert.ok(!(els.has('fire') && els.has('ice')), 'fire + ice');
    assert.ok(!(els.has('holy') && els.has('void')), 'holy + void');
    const coloured = new Set(dna.modifiers.filter((m) => m.kind === 'element').map((m) => m.element));
    if (dna.element !== 'physical') coloured.add(dna.element);
    assert.ok(coloured.size <= data.balance.maxElements, 'too many elements to read');
    if (!dna.tags.includes('projectile')) {
      for (const id of ['homing', 'pierce', 'split', 'multishot', 'pspeed', 'ricochet']) assert.ok(!ids.has(id), `${id} without projectiles`);
    }
    const rarity = data.byId.rarities.get(dna.rarity);
    const perf = [...dna.modifiers.map((m) => data.byId.modifiers.get(m.id)), ...dna.effects.map((e) => data.byId.effects.get(e.id))]
      .reduce((s, d) => s + (d.perf ?? 0), 0);
    assert.ok(perf <= rarity.perfBudget, 'too heavy for mobile');
  }
});

test('min/max rarity and themes are respected', () => {
  for (const dna of sweep(200, { minRarity: 'epic' })) assert.ok(['epic', 'legendary'].includes(dna.rarity));
  for (const dna of sweep(200, { maxRarity: 'uncommon' })) assert.ok(['common', 'uncommon'].includes(dna.rarity));
});

test('research gates the generator pool', () => {
  const locked = new Set([...data.gated.archetypes]);
  assert.ok(locked.has('scythe') && locked.has('orb'));
  for (const dna of sweep(1500)) {
    assert.ok(!locked.has(dna.archetype), `${dna.archetype} appeared before research`);
    for (const e of dna.effects) assert.ok(!data.gated.effects.has(e.id), `${e.id} appeared before research`);
  }
  const pool = buildPool(data, ['bp_scythe', 'inferno_core']);
  assert.ok(pool.archetypes.some((a) => a.id === 'scythe'));
  assert.ok(pool.effects.some((e) => e.id === 'lava_burst'));
  assert.ok(pool.abilities.some((a) => a.id === 'phoenix'));
  const withScythe = sweep(800, { unlocked: ['bp_scythe'] }, 5).filter((w) => w.archetype === 'scythe');
  assert.ok(withScythe.length > 0, 'researched archetype shows up in drops');
});

test('names are varied (rarely repeated)', () => {
  const weapons = sweep(3000, {}, 11);
  const unique = new Set(weapons.map((w) => w.name.text));
  assert.ok(unique.size / weapons.length > 0.9, `only ${unique.size} unique names`);
});

test('every weapon has a clear identity and visuals derived from its DNA', () => {
  for (const dna of sweep(500, { unlocked: allComponentIds(data) }, 13)) {
    assert.ok(dna.identity && data.byId.themes.has(dna.theme));
    const el = data.byId.elements.get(dna.element);
    if (el.glow) assert.equal(dna.visual.palette.glow, el.glow);
    if (dna.element === 'ice') assert.equal(dna.visual.edge, 'crystal');
    if (dna.element === 'void') assert.equal(dna.visual.distortion, true);
    if (dna.element === 'fire') assert.equal(dna.visual.particles.kind, 'ember');
    assert.equal(dna.visual.template, data.byId.archetypes.get(dna.archetype).sprite.template);
  }
});

test('generation code only uses deterministic arithmetic', () => {
  const files = ['generator.js', 'rules.js', 'naming.js', 'visuals.js', 'pool.js', 'dna.js', 'crafting.js'];
  const forbidden = /Math\.(random|sin|cos|tan|atan2?|pow|exp|log\d*|cbrt|hypot)\b|[\w)\]]\s*\*\*\s*[\w(]/;
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'src/weapons', f), 'utf8');
    assert.ok(!forbidden.test(src), `${f} uses a non-deterministic Math function`);
  }
});
