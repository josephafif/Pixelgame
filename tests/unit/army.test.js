// Soldiers, squads and territories: the rules shared by single player and
// the server (army.js, territory.js), and the single-player campaign.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, LIQUID } from '../../src/game/world.js';
import {
  trainProblem, startTraining, finishTraining, soldierStats, soldierPower, addXp, gearUpgrade, barracksCap,
  ensureArmy, createSquad, assignSoldier, makeOrder, postFor, stepSoldier, makeSoldier, hurtSoldier, isSoldier,
} from '../../src/game/army.js';
import {
  territoryAt, outpostFor, outpostLayout, defendersFor, monsterPower, outpostLevel, abstractBattle, stepCapture,
  frontier, defenseFactor, incomeFor, territoryKey, outpostDormant,
} from '../../src/game/territory.js';
import { createWorker } from '../../src/game/workers.js';
import { upkeepPerDay } from '../../src/game/upkeep.js';
import { loadData } from './helpers.js';

const data = loadData();

test('territories: squares centred on the camp, an outpost on dry land in most, the same every time', () => {
  assert.deepEqual(territoryAt(data, 0, 0), { tx: 0, ty: 0 });
  assert.deepEqual(territoryAt(data, 47, -47), { tx: 0, ty: 0 });
  assert.deepEqual(territoryAt(data, 49, 0), { tx: 1, ty: 0 });
  const w = new World(data, 42);
  assert.equal(outpostFor(w, data, 0, 0), null, 'the camp\'s own square has none');
  let sites = 0;
  for (let ty = -3; ty <= 3; ty++) {
    for (let tx = -3; tx <= 3; tx++) {
      const s = outpostFor(w, data, tx, ty);
      if (!s) continue;
      sites++;
      assert.deepEqual(territoryAt(data, s.fx, s.fy), { tx, ty }, 'inside its own square');
      assert.ok(s.tier >= 1 && s.tier <= 5);
      // Dry everywhere inside the palisade.
      for (const p of outpostLayout()) assert.ok(!LIQUID.has(w.blockAt(s.fx + p.x, s.fy + p.y)), 'no water under the palisade');
    }
  }
  assert.ok(sites >= 20, `most squares have one (${sites})`);
  const again = new World(data, 42);
  assert.deepEqual(outpostFor(again, data, 2, -1), outpostFor(w, data, 2, -1), 'deterministic');
  // The palisade has a gap to walk in, and a flag in the middle.
  const layout = outpostLayout();
  assert.ok(layout.some((p) => p.id === 'outpost_flag' && p.x === 0 && p.y === 0));
  assert.ok(!layout.some((p) => p.id === 'palisade' && p.x === 0 && p.y === 4), 'a gap on the south side');
});

test('outposts: guards by the land and distance; a fight far away uses the same numbers', () => {
  const w = new World(data, 42);
  const near = outpostFor(w, data, 1, 0);
  const far = outpostFor(w, data, 4, 0) ?? outpostFor(w, data, 4, 1);
  const pNear = monsterPower(data, defendersFor(data, near), outpostLevel(near));
  const pFar = monsterPower(data, defendersFor(data, far), outpostLevel(far));
  assert.ok(pFar > pNear * 1.5, 'further out is tougher');
  const r = () => 0.5;
  assert.equal(abstractBattle(pNear * 2, pNear, r).win, true);
  assert.equal(abstractBattle(pNear * 0.5, pNear, r).win, false);
  const close = abstractBattle(pNear * 1.05, pNear, r);
  const easy = abstractBattle(pNear * 3, pNear, r);
  assert.ok(close.attackerLoss > easy.attackerLoss, 'a close fight costs more');
  // Capture: friends alone fill it, foes alone drain it, both hold it.
  assert.equal(stepCapture(0, { friendly: true, hostile: false, dt: 10, seconds: 20 }), 0.5);
  assert.equal(stepCapture(0.5, { friendly: true, hostile: true, dt: 10, seconds: 20 }), 0.5);
  assert.equal(stepCapture(0.5, { friendly: false, hostile: true, dt: 5, seconds: 20 }), 0.25);
  // A long front is harder to hold.
  const line = ['1,0', '2,0', '3,0', '4,0'];
  const block = ['1,0', '2,0', '1,1', '2,1'];
  assert.ok(frontier(line) >= frontier(block));
  assert.ok(defenseFactor(data, 4, 6) < defenseFactor(data, 4, 1));
  assert.ok(incomeFor(data, 3).scrap > incomeFor(data, 1).scrap);
  // A clan base right by an outpost puts it to sleep (multiplayer).
  assert.equal(outpostDormant(near, [{ x: near.x + 10, y: near.y }], 16), true);
  assert.equal(outpostDormant(near, [{ x: near.x + 60, y: near.y }], 16), false);
});

test('soldiers: trained at the Training Grounds, better with gear and rank, room in the barracks', () => {
  const roster = [{ id: 1, role: 'wood' }, { id: 2, role: 'stone' }, { id: 3, role: 'wood' }];
  assert.match(trainProblem(data, roster, roster[0], 'guard', { training: 0 }), /Training Grounds/);
  assert.match(trainProblem(data, roster, roster[0], 'archer', { training: 1 }), /level 3/);
  assert.equal(trainProblem(data, roster, roster[0], 'guard', { training: 1 }), null);
  startTraining(data, roster[0], 'guard', 1000);
  startTraining(data, roster[1], 'guard', 1000);
  assert.equal(barracksCap(data, 1), 2);
  assert.match(trainProblem(data, roster, roster[2], 'guard', { training: 1 }), /barracks are full/);
  assert.equal(finishTraining(roster[0], 2000), false, 'not yet');
  assert.equal(finishTraining(roster[0], 1000 + 60 * 60 * 1000), true);
  assert.equal(roster[0].role, 'guard');
  assert.ok(isSoldier(data, 'guard') && !isSoldier(data, 'wood'));
  const base = soldierStats(data, roster[0], 1);
  roster[0].gear = 3;
  addXp(data, roster[0], 100);
  assert.ok(roster[0].rank >= 2);
  const better = soldierStats(data, roster[0], 1);
  assert.ok(better.hp > base.hp && better.damage > base.damage);
  assert.ok(soldierPower(data, roster[0], 3) > soldierPower(data, roster[0], 1), 'the Training Grounds\' level helps');
  assert.match(gearUpgrade(data, { gear: 3 }, { forge: 1 }).problem, /Forge/);
  // Soldiers draw their own pay.
  const pay = upkeepPerDay({ workers: 1, soldiers: 2 }, { perWorker: { scrap: 10 }, perSoldier: { scrap: 30 } });
  assert.equal(pay.total.scrap, 70);
});

test('squads: orders, posts in formation, and a soldier that walks there and fights', () => {
  const army = ensureArmy(null);
  const sq = createSquad(data, army, 'Ulvarna');
  assert.equal(assignSoldier(data, army, 7, sq.id), null);
  assert.equal(assignSoldier(data, army, 8, sq.id), null);
  assert.deepEqual(sq.members, [7, 8]);
  assert.match(makeOrder('dance').problem, /Unknown/);
  assert.match(makeOrder('attack', {}).problem, /Pick a place/);
  const site = { key: '1,0', x: 100.5, y: 4.5 };
  const { order } = makeOrder('attack', { key: '1,0', site: () => site });
  assert.deepEqual(order, { kind: 'attack', key: '1,0', x: 100.5, y: 4.5 });
  sq.order = order;
  const a = postFor(sq, 0, { home: { x: 0, y: 0 } });
  const b = postFor(sq, 1, { home: { x: 0, y: 0 } });
  assert.ok(Math.hypot(a.x - site.x, a.y - site.y) < 3 && (a.x !== b.x || a.y !== b.y), 'side by side at the flag');
  // One soldier, open ground, a monster by the post: it walks over and strikes.
  const w = new World(data, 7);
  const s = makeSoldier(createWorker({ id: 1, role: 'infantry' }, { x: 300.5, y: 300.5 }, { hp: 140 }));
  const foe = { x: 306, y: 300.5, r: 0.4, dead: false, hp: 50 };
  let hits = 0;
  const ctx = {
    world: { ...w, isFree: () => true, blockedFor: () => false, findFreeSpot: (x, y) => ({ x, y }) },
    time: 0, stats: () => soldierStats(data, { role: 'infantry', gear: 1, rank: 0 }), post: () => ({ x: 304, y: 300.5 }),
    stance: () => 'balanced', foes: () => (foe.dead ? [] : [foe]), hit: () => { hits++; foe.hp -= 15; if (foe.hp <= 0) foe.dead = true; },
    shoot: () => {}, live: () => true,
  };
  for (let i = 0; i < 200 && !foe.dead; i++) stepSoldier(s, ctx, 0.05);
  assert.ok(hits > 0 && foe.dead, 'it fought and won');
  assert.equal(hurtSoldier(s, 1000), true);
  assert.ok(s.dead);
});

test('far away, a soldier marches straight to its post (no fights there)', () => {
  const s = makeSoldier(createWorker({ id: 2, role: 'rider' }, { x: 0, y: 0 }, { hp: 150 }));
  const ctx = {
    world: {}, time: 0, stats: () => soldierStats(data, { role: 'rider', gear: 1, rank: 0 }), post: () => ({ x: 100, y: 0 }),
    stance: () => 'balanced', foes: () => [], hit: () => {}, shoot: () => {}, live: () => false,
  };
  for (let i = 0; i < 10; i++) stepSoldier(s, ctx, 1);
  assert.ok(s.ghost && s.x > 30 && s.x < 40 && s.y === 0, `marched ${s.x}`);
  assert.equal(territoryKey(1, -2), '1,-2');
});
