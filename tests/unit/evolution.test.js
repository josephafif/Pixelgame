import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWeapon, normalizeContext, requestFromContext, regenerate } from '../../src/weapons/generator.js';
import { auditWeapon } from '../../src/weapons/rules.js';
import { validateDna } from '../../src/weapons/dna.js';
import { createNewSave } from '../../src/storage/save.js';
import {
  familyOf, baseArchetypes, evoOf, treeFor, nodeOf, nodeStatus, evolveBlockers, requirementsOf, applyNode,
  previewNode, temper, temperInfo, levelCap, dnaKey, awakeningsFor,
} from '../../src/weapons/evolution.js';
import { loadData, allComponentIds, seeds } from './helpers.js';

const data = loadData();
const all = allComponentIds(data);
const RARITY = (id) => data.rarityIndex.get(id);

/** How hard a weapon hits over time (the generator's rating: damage, speed, crits, extra projectiles). */
function rating(w) {
  const a = data.byId.archetypes.get(w.archetype);
  const s = w.stats;
  const baseProj = Math.max(1, a.attack.count ?? 1);
  return s.damage * s.attackSpeed * (1 + (s.critChance / 100) * (s.critDamage / 100 - 1))
    * (1 + (0.6 * Math.max(0, s.projectiles - baseProj)) / baseProj);
}

const baseWeapon = (archetype, seed = 1234, level = 5) => generateWeapon(data, {
  seed, level, unlocked: all, maxRarity: 'rare', source: 'craft', craft: { archetype },
});

/** A save that meets every requirement of the trees. */
function richSave() {
  const save = createNewSave(data, 7);
  save.player.level = 60;
  for (const b of data.base.buildings) save.base.buildings[b.id] = b.levels?.length ?? 5;
  save.base.buildings.forge = 5;
  for (const id of all) save.components[id] = { found: 1, researched: true };
  for (const b of data.bosses) save.bosses.defeated[b.id] = 1;
  for (const k of ['scrap', 'essence', 'wood', 'stone', 'prismite', 'spores', 'aether', 'shards']) save.resources[k] = 1e6;
  return save;
}

test('every archetype is a base weapon or an evolved form, and only base weapons are found', () => {
  const bases = baseArchetypes(data);
  assert.deepEqual(bases.slice().sort(), ['axe', 'bow', 'spear', 'sword', 'throwing', 'wand']);
  for (const a of data.archetypes) assert.equal(!a.evolved, bases.includes(a.id), a.id);
  for (const s of seeds(60, 3)) {
    const w = generateWeapon(data, { seed: s, level: 20, unlocked: all, baseOnly: true, maxRarity: 'rare' });
    assert.ok(bases.includes(w.archetype), `found ${w.archetype}`);
    assert.ok(RARITY(w.rarity) <= RARITY('rare'));
  }
});

test('the base-only flag leaves older weapons exactly as they were', () => {
  const req = { seed: 99, level: 7, unlocked: all };
  assert.deepEqual(generateWeapon(data, req), generateWeapon(data, { ...req, baseOnly: false }), 'no flag, same weapon (and id)');
  assert.equal('base' in normalizeContext(req), false);
  const w = generateWeapon(data, { ...req, baseOnly: true });
  assert.equal(w.ctx.base, 1);
  assert.equal(requestFromContext(w.seed, w.ctx).baseOnly, true);
  assert.deepEqual(regenerate(data, w), w, 'a base-only weapon regenerates from its share code');
});

test('each family has its own tree: forms, masterworks, infusions; awakenings follow the infusion', () => {
  for (const fam of data.evolution.families) {
    const w = baseWeapon(fam.base);
    assert.equal(familyOf(data, w).id, fam.id);
    const tree = treeFor(data, w);
    assert.equal(tree.filter((n) => n.kind === 'form').length, fam.forms.length);
    assert.equal(tree.filter((n) => n.kind === 'mastery').length, fam.forms.length);
    assert.equal(tree.filter((n) => n.kind === 'infusion').length, fam.infusions.length);
    assert.ok(tree.some((n) => n.id === 'awaken:?' && n.hidden), 'the awakening is a secret until the infusion');
    for (const n of tree) assert.equal(nodeStatus(data, w, n), n.id === 'tempered' ? 'next' : 'future', n.id);
  }
  for (const el of data.evolution.infusions.map((i) => i.element)) {
    const aws = awakeningsFor(data, el);
    assert.ok(aws.length >= 2 && aws.length <= 3, `${el}: ${aws.length} awakenings`);
  }
});

test('every path of every tree makes a valid weapon that grows stronger and rarer', () => {
  for (const fam of data.evolution.families) {
    for (const s of seeds(3, fam.id.length)) {
      const w0 = baseWeapon(fam.base, s, 3);
      for (const form of fam.forms) {
        for (const el of fam.infusions) {
          let w = w0;
          let rarity = RARITY(w.rarity);
          for (const id of ['tempered', `form:${form.id}`, `mastery:${form.id}`, `infuse:${el}`]) {
            const before = w;
            w = applyNode(data, w, id, { playerLevel: 1 });
            const where = `${fam.id}/${form.id}/${el} ${id}`;
            assert.deepEqual(auditWeapon(data, w), [], where);
            assert.deepEqual(validateDna(w), [], where);
            assert.ok(RARITY(w.rarity) >= rarity, `${where}: rarity never drops`);
            rarity = RARITY(w.rarity);
            assert.equal(w.id, w0.id, 'the same weapon');
            assert.equal(w.evo.rev, before.evo ? before.evo.rev + 1 : 1);
            if (before.archetype === w.archetype) assert.ok(rating(w) >= rating(before) * 0.97, `${where}: it grows stronger (small numbers round) (${rating(before).toFixed(0)} → ${rating(w).toFixed(0)})`);
          }
          assert.equal(w.archetype, form.mastery.archetype ?? form.archetype);
          assert.equal(w.element, el);
          assert.equal(w.rarity, 'epic');
          for (const aw of treeFor(data, w).filter((n) => n.kind === 'awakening')) {
            assert.ok(!aw.hidden);
            const f = applyNode(data, w, aw.id, { playerLevel: 1 });
            assert.deepEqual(auditWeapon(data, f), [], `${fam.id}/${form.id}/${el} ${aw.id}`);
            assert.equal(f.rarity, 'legendary');
            assert.equal(f.signature, aw.power);
            assert.ok(f.ability, 'a legendary power rests on an ability');
            assert.equal(f.evo.tier, 5);
            assert.match(f.name.text, /Awakened/);
          }
        }
      }
    }
  }
});

test('evolving is pure and deterministic, and the look follows the tree', () => {
  const w = baseWeapon('sword');
  const copy = structuredClone(w);
  const a = applyNode(data, w, 'tempered', { playerLevel: 5 });
  const b = applyNode(data, w, 'tempered', { playerLevel: 5 });
  assert.deepEqual(w, copy, 'the old DNA is untouched');
  assert.deepEqual(a, b);
  assert.equal(a.visual.evo.tier, 1);
  const titan = applyNode(data, a, 'form:titan');
  assert.equal(titan.archetype, 'greatsword');
  assert.equal(titan.material, 'ancient');
  assert.notDeepEqual(titan.visual.dims, a.visual.dims, 'a new shape');
  assert.equal(titan.visual.evo.branch, 'titan');
  assert.equal(dnaKey(w), w.id);
  assert.equal(dnaKey(titan), `${w.id}~2`, 'caches see the change');
  assert.deepEqual(previewNode(data, a, 'form:titan').archetype, 'greatsword');
  assert.equal(previewNode(data, a, 'nope'), null);
});

test('a branch, once chosen, closes the others', () => {
  let w = applyNode(data, baseWeapon('axe'), 'tempered');
  w = applyNode(data, w, 'form:quake');
  const status = (id) => nodeStatus(data, w, nodeOf(data, w, id));
  assert.equal(status('form:quake'), 'owned');
  assert.equal(status('form:crusher'), 'closed');
  assert.equal(status('mastery:quake'), 'next');
  assert.equal(status('mastery:crusher'), 'closed');
  assert.equal(status('infuse:fire'), 'future');
  const save = richSave();
  assert.deepEqual(evolveBlockers(data, save, w, 'form:crusher'), ['Another path was chosen']);
  assert.deepEqual(evolveBlockers(data, save, w, 'infuse:fire'), ['Take the steps before it first']);
  assert.deepEqual(evolveBlockers(data, save, w, 'tempered'), ['Already done']);
  assert.deepEqual(evolveBlockers(data, save, w, 'mastery:quake'), []);
  assert.deepEqual(evolveBlockers(data, save, w, 'awaken:?'), ['Unknown step']);
});

test('steps need the forge, your level, bosses, found components and resources', () => {
  const w = applyNode(data, baseWeapon('bow'), 'tempered');
  const save = createNewSave(data, 3);
  const blockers = evolveBlockers(data, save, w, 'form:crossbow');
  assert.ok(blockers.some((b) => /Forge level 2/.test(b)), blockers.join('; '));
  assert.ok(blockers.some((b) => /level 8/.test(b)));
  assert.ok(blockers.some((b) => /Crossbow/.test(b)), 'the blueprint');
  assert.ok(blockers.some((b) => /scrap/.test(b)));
  const rows = requirementsOf(data, save, w, nodeOf(data, w, 'form:crossbow'));
  const comp = rows.find((r) => r.kind === 'component');
  assert.ok(comp && !comp.ok && comp.hint, 'a hint where it is found');

  // Met one by one.
  const rich = richSave();
  assert.deepEqual(evolveBlockers(data, rich, w, 'form:crossbow'), []);
  rich.components.bp_crossbow = { found: 0, researched: false };
  assert.deepEqual(evolveBlockers(data, rich, w, 'form:crossbow'), [`Needs ${data.byId.components.get('bp_crossbow').name}`]);
  rich.components.bp_crossbow.found = 1;
  // The server passes its own forge level and the player's level.
  assert.ok(evolveBlockers(data, rich, w, 'form:crossbow', { forgeLevel: 1, playerLevel: 60 }).some((b) => /Forge/.test(b)));
  assert.ok(evolveBlockers(data, rich, w, 'form:crossbow', { forgeLevel: 5, playerLevel: 3 }).some((b) => /level/.test(b)));

  // The Masterwork needs a boss; the awakening a far core and Star Shards.
  let m = applyNode(data, w, 'form:crossbow');
  rich.bosses.defeated = {};
  assert.ok(evolveBlockers(data, rich, m, 'mastery:crossbow').some((b) => /boss/.test(b)));
  m = applyNode(data, applyNode(data, m, 'mastery:crossbow'), 'infuse:fire');
  const aw = treeFor(data, m).find((n) => n.kind === 'awakening');
  assert.ok(aw.requires.cost.shards > 0);
  rich.resources.shards = 0;
  assert.ok(evolveBlockers(data, rich, m, aw.id).some((b) => /shards/.test(b)));
});

test('tempering raises the weapon to your level, up to its step\'s cap', () => {
  const w = baseWeapon('spear', 77, 3);
  const info = temperInfo(data, w, 40);
  assert.equal(info.cap, levelCap(data, 0));
  assert.equal(info.to, levelCap(data, 0));
  assert.ok(info.cost.essence > 0 && info.cost.scrap > 0);
  const t = temper(data, w, info.to);
  assert.equal(t.ctx.lvl, info.to);
  assert.ok(t.stats.damage > w.stats.damage);
  assert.equal(t.evo.rev, 1, 'a new look for the caches');
  assert.equal(temperInfo(data, t, 40).cost, null, 'at the cap');
  // Evolving lifts the cap, and tempers it up to you on the way.
  const e = applyNode(data, t, 'tempered', { playerLevel: 40 });
  assert.equal(e.ctx.lvl, levelCap(data, 1));
  assert.ok(temperInfo(data, e, 12).cost === null, 'never down');
});

test('weapons from before the trees find their place in them', () => {
  const great = generateWeapon(data, { seed: 5, level: 12, unlocked: all, craft: { archetype: 'greatsword' }, source: 'craft', maxRarity: 'rare' });
  const evo = evoOf(data, great);
  assert.equal(evo.family, 'sword');
  assert.equal(evo.tier, 2);
  assert.deepEqual(evo.path, ['tempered', 'form:titan']);
  assert.equal(nodeStatus(data, great, nodeOf(data, great, 'mastery:titan')), 'next');
  const next = applyNode(data, great, 'mastery:titan');
  assert.deepEqual(next.evo.path, ['tempered', 'form:titan', 'mastery:titan']);
  assert.deepEqual(auditWeapon(data, next), []);
  const cannon = generateWeapon(data, { seed: 6, level: 12, unlocked: all, craft: { archetype: 'cannon' }, source: 'craft', maxRarity: 'rare' });
  assert.equal(evoOf(data, cannon).tier, 3, 'the cannon is the gun\'s Masterwork');
  // A found legendary from before keeps working: its tree starts where its type is.
  const old = generateWeapon(data, { seed: 8, level: 30, unlocked: all, minRarity: 'legendary' });
  assert.ok(evoOf(data, old));
});

test('an evolved weapon keeps its name, with its new type, element and awakening', () => {
  let w = baseWeapon('bow', 4242);
  const found = w.name.text;
  w = applyNode(data, applyNode(data, w, 'tempered'), 'form:crossbow');
  w = applyNode(data, applyNode(data, w, 'mastery:crossbow'), 'infuse:lightning');
  assert.equal(w.evo.origin.text, found);
  assert.match(w.name.text, /Storms$/);
  const aw = treeFor(data, w).find((n) => n.kind === 'awakening');
  assert.match(applyNode(data, w, aw.id).name.text, /Awakened/);
});
