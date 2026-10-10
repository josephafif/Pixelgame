// NPC factions: where they start, how their AI grows them (income,
// reinforcements, armies that march and fight with the same numbers as
// everything else), personalities, and the limits that keep them in check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.js';
import {
  createFactions, stepFactions, factionSquares, troopsFor, troopPower, factionConfig, loseToOthers, takeFor, factionById,
} from '../../src/game/factions.js';
import { parseKey, outpostFor, monsterPower, defendersFor, outpostLevel } from '../../src/game/territory.js';
import { createRng } from '../../src/core/rng.js';
import { loadData } from './helpers.js';

const data = loadData();

/** A context with no player at all: every square is neutral or a faction's. */
function quietCtx(world, extra = {}) {
  const r = createRng(5);
  return {
    world, data, rng: () => r.next(),
    ownerOf: () => null,
    defense: (key, site) => monsterPower(data, defendersFor(data, site), outpostLevel(site)),
    allowed: (key) => key !== '0,0',
    live: () => false,
    realAttack: () => {},
    taken: () => {},
    lost: () => {},
    plunder: () => {},
    ...extra,
  };
}

test('factions: three to five, each with a headquarters and a camp, away from the camp, the same every time', () => {
  for (const seed of [1, 42, 4242]) {
    const w = new World(data, seed);
    const st = createFactions(w, data);
    assert.ok(st.list.length >= 3 && st.list.length <= 5, `seed ${seed}: ${st.list.length}`);
    for (const f of st.list) {
      const hq = parseKey(f.hq);
      assert.ok(Math.max(Math.abs(hq.tx), Math.abs(hq.ty)) >= 2, 'not next to the camp');
      assert.equal(st.owned[f.hq].tier, 'hq');
      assert.ok(factionSquares(st, f.id).length >= 1);
      assert.ok(outpostFor(w, data, hq.tx, hq.ty), 'on an outpost');
      assert.ok(f.quality >= 1 && f.quality <= 3);
    }
    assert.equal(st.owned['0,0'], undefined);
    assert.deepEqual(createFactions(new World(data, seed), data), st, 'deterministic');
  }
});

test('troops: a captain in strongholds and headquarters; more troops weigh more', () => {
  const w = new World(data, 42);
  const st = createFactions(w, data);
  const f = st.list[0];
  const camp = troopsFor(f, 'camp', 3);
  const hq = troopsFor(f, 'hq', 3);
  assert.ok(!camp.some((t) => t.elite) && hq[0].elite && hq[0].kind === `${f.id}_captain`);
  for (const t of hq) assert.ok(data.byId.enemies.get(t.kind), t.kind);
  const site = outpostFor(w, data, ...Object.values(parseKey(f.hq)));
  assert.ok(troopPower(data, f, 'camp', 6, site) > troopPower(data, f, 'camp', 3, site));
});

test('over time the factions grow: income, garrisons, armies that take neutral land, never your camp', () => {
  const w = new World(data, 42);
  const st = createFactions(w, data);
  const before = Object.keys(st.owned).length;
  let marches = 0;
  const ctx = quietCtx(w, { told: (e) => { if (e.kind === 'march') marches++; } });
  for (let t = 0; t < 60 * 60; t += 3) stepFactions(st, ctx, 3);
  assert.ok(marches > 0, 'armies marched');
  assert.ok(Object.keys(st.owned).length > before, 'they took land');
  const cfg = factionConfig(data);
  for (const f of st.list) {
    assert.ok(factionSquares(st, f.id).length <= cfg.maxTerritories + 1, 'within their limit');
    const hq = parseKey(f.hq);
    for (const key of factionSquares(st, f.id)) {
      const p = parseKey(key);
      assert.ok(Math.max(Math.abs(p.tx - hq.tx), Math.abs(p.ty - hq.ty)) <= cfg.reach + 1, 'within reach of their headquarters');
    }
  }
  assert.equal(st.owned['0,0'], undefined, 'never the camp');
});

test('your land: armies come for it, a raider plunders and leaves, the others keep it; strong defence holds', () => {
  const w = new World(data, 42);
  const st = createFactions(w, data);
  // You hold every free square next to the factions' land.
  const mine = new Set();
  for (const key of Object.keys(st.owned)) {
    const { tx, ty } = parseKey(key);
    for (const [x, y] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]) {
      const k = `${x},${y}`;
      if (!st.owned[k] && k !== '0,0' && outpostFor(w, data, x, y)) mine.add(k);
    }
  }
  const lost = [];
  const plundered = [];
  let strong = false;
  const ctx = quietCtx(w, {
    ownerOf: (key) => (mine.has(key) ? { kind: 'player', id: 'me' } : null),
    defense: (key, site) => (mine.has(key) ? (strong ? 1e6 : 10) : monsterPower(data, defendersFor(data, site), outpostLevel(site))),
    lost: (key, fid, to) => {
      mine.delete(key);
      lost.push([key, to]);
    },
    plunder: (owner, pct, f) => plundered.push(f.personality),
  });
  for (let t = 0; t < 30 * 60; t += 3) stepFactions(st, ctx, 3);
  assert.ok(lost.length > 0, 'they took some of your land');
  for (const [key, to] of lost) {
    if (to) assert.equal(st.owned[key]?.faction, to.slice(2), 'kept by who took it');
  }
  assert.ok(plundered.every((p) => p === 'raider'), 'only raiders plunder');
  // With a strong defence, nothing more falls.
  strong = true;
  const n = lost.length;
  for (let t = 0; t < 20 * 60; t += 3) stepFactions(st, ctx, 3);
  assert.equal(lost.length, n);
});

test('you take a faction\'s headquarters: it is theirs no more; with no land left a faction falls', () => {
  const w = new World(data, 42);
  const st = createFactions(w, data);
  const f = st.list[0];
  const hq = f.hq;
  assert.equal(loseToOthers(st, hq).id, f.id);
  assert.equal(st.owned[hq], undefined);
  assert.ok(f.hqLost);
  for (const key of factionSquares(st, f.id)) loseToOthers(st, key);
  const events = [];
  stepFactions(st, quietCtx(w, { told: (e) => events.push(e.kind) }), 13);
  assert.equal(factionById(st, f.id).alive, false);
  assert.ok(events.includes('gone'));
  takeFor(st, data, hq, st.list[1].id);
  assert.equal(st.owned[hq].faction, st.list[1].id);
});
