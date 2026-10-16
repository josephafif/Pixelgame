// Weapon Evolution in multiplayer: the server checks every step with the
// same rules as single player, changes the weapon in place (same id) and
// saves it; the owner gets the new DNA, the forge they stand at counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer } from './helpers.js';
import { auditWeapon } from '../../src/weapons/rules.js';

test('evolve and temper a weapon at the forge: checked, paid, saved, synced', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Smeden');
    const p = t.player(a);
    const gs = t.gs;
    const sword = p.inv.bag.find((w) => w.archetype === 'sword') ?? p.inv.bag[0];
    assert.ok(sword, 'a starter weapon');

    // Not at a forge: refused.
    t.place(a, 60, 0.5);
    let res = await a.request({ t: 'evolve', id: sword.id, node: 'tempered' });
    assert.match(res.error, /smedja/i);

    // Fristaden's forge is level 1: Tempered, but nothing beyond.
    const town = gs.data.base.buildings.find((b) => b.id === 'forge');
    t.place(a, town.x + 1, town.y + 1);
    p.ch.resources = { essence: 0, scrap: 0, wood: 0, stone: 0, gold: 0, shards: 0 };
    res = await a.request({ t: 'evolve', id: sword.id, node: 'tempered' });
    assert.match(res.error, /fattas/, 'it costs');
    p.ch.resources = { essence: 100000, scrap: 100000, wood: 100000, stone: 100000, gold: 0, shards: 10, prismite: 100, spores: 100, aether: 100 };
    res = await a.request({ t: 'evolve', id: sword.id, node: 'tempered' });
    assert.equal(res.ok, true, res.error);
    const msg = await a.waitFor((m) => m.t === 'inv~' && m.dna.id === sword.id);
    assert.equal(msg.dna.evo.tier, 1);
    assert.equal(msg.node, 'tempered');
    const now = p.inv.bag.find((w) => w.id === sword.id);
    assert.equal(now.evo.tier, 1, 'changed in place, same id');
    assert.ok(p.ch.resources.scrap < 100000, 'paid');
    // Saved: the database has the new DNA.
    const row = gs.db.itemsOf(p.accountId).find((r) => r.id === sword.id);
    assert.equal(row.dna.evo.tier, 1);
    // The weapon in hand follows.
    if (p.inv.equipped === sword.id) assert.equal(p.weapon.dna.evo.tier, 1);

    p.ch.level = 30;
    res = await a.request({ t: 'evolve', id: sword.id, node: 'form:titan' });
    assert.match(res.error, /Fristadens smedja/, 'the town forge is too small');

    // A clan forge at level 5, and the blueprint found: on to the Titan.
    const { spots } = await t.clanBase(a, { forge: 5 });
    t.nextTo(a, spots.forge);
    res = await a.request({ t: 'evolve', id: sword.id, node: 'form:titan' });
    assert.match(res.error, /Kräver/, 'needs the component');
    p.ch.extra.components = { ...(p.ch.extra.components ?? {}), ancient_blade: { found: 1, researched: false } };
    p.ch.level = 10;
    res = await a.request({ t: 'evolve', id: sword.id, node: 'form:titan' });
    assert.equal(res.ok, true, res.error);
    const titan = (await a.waitFor((m) => m.t === 'inv~' && m.dna.evo?.tier === 2)).dna;
    assert.equal(titan.archetype, 'greatsword');
    assert.equal(titan.ctx.lvl, 10, 'tempered up to you on the way');
    assert.deepEqual(auditWeapon(gs.data, titan), []);
    assert.ok(p.ch.extra.codex.evolutions.includes('sword:form:titan'), 'the codex remembers');
    // Another branch is closed now.
    res = await a.request({ t: 'evolve', id: sword.id, node: 'form:shadow' });
    assert.match(res.error, /annan väg/);

    // Tempering: up to the player's level, as far as the step's cap.
    p.ch.level = 60;
    res = await a.request({ t: 'temper', id: sword.id });
    assert.equal(res.ok, true, res.error);
    const tempered = (await a.waitFor((m) => m.t === 'inv~' && m.kind === 'temper')).dna;
    assert.equal(tempered.ctx.lvl, gs.data.evolution.levelCaps[2]);
    res = await a.request({ t: 'temper', id: sword.id });
    assert.match(res.error, /tak/);

    // Someone else's weapon, or nonsense: refused.
    res = await a.request({ t: 'evolve', id: 'nope', node: 'tempered' });
    assert.equal(res.ok, false);
    res = await a.request({ t: 'evolve', id: sword.id, node: 'awaken:starfall' });
    assert.equal(res.ok, false);
  } finally {
    await t.close();
  }
});

test('found weapons on the server are base weapons, rare at best', async () => {
  const t = await testServer();
  try {
    const { generate } = await import('../../server/loot.js');
    for (let i = 0; i < 80; i++) {
      const dna = generate(t.gs, { level: 30, source: i % 2 ? 'boss' : 'chest', minRarity: i % 2 ? 'epic' : 'uncommon' });
      assert.ok(!t.gs.data.byId.archetypes.get(dna.archetype).evolved, dna.archetype);
      assert.ok(['uncommon', 'rare'].includes(dna.rarity), dna.rarity);
    }
    const axe = generate(t.gs, { level: 10, source: 'boss', minRarity: 'rare', base: 'axe' });
    assert.equal(axe.archetype, 'axe', 'a boss gives a family you lack');
    // The forge still makes what you ask for.
    const forged = generate(t.gs, { level: 5, source: 'craft', minRarity: 'rare', maxRarity: 'rare', craft: { archetype: 'bow', material: 'oak' } });
    assert.equal(forged.archetype, 'bow');
  } finally {
    await t.close();
  }
});
