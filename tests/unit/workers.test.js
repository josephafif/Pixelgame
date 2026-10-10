import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import { World, T } from '../../src/game/world.js';
import { Construction, structureDef, upgradeDef, upgradeCost } from '../../src/game/construction.js';
import { Workforce } from '../../src/game/workforce.js';
import {
  workerCap, hireCost, workerTier, canWorkOn, createWorker, stepWorker, hurtWorker, workerStats, workerLook,
} from '../../src/game/workers.js';
import { upkeepPerDay, suppliesLast, chargeUpkeep, formatHours, HOUR_MS } from '../../src/game/upkeep.js';
import { harvestInfo } from '../../src/game/gathering.js';
import { buildRadius } from '../../src/game/construction.js';
import { loadData } from './helpers.js';

const data = loadData();

/** Just enough of a Game for the camp's construction and workforce. */
function stubGame(save) {
  const world = new World(data, save.worldSeed);
  world.harvested = save.world.harvested;
  const toasts = [];
  const game = {
    data, save, world, time: 0, enemies: [], toasts,
    player: { x: 0.5, y: 1.6, r: 0.32, dead: false },
    fx: { emit() {}, text() {}, number() {} },
    audio: { play() {} },
    harvestDamage: new Map(),
    emit() {},
    toast(text) { toasts.push(text); },
    requestSave() {},
    damageEnemy() {},
    spawnProjectile() { return {}; },
    schedule(_, fn) { fn(); },
    hurtPlayer(n) { game.hurt = (game.hurt ?? 0) + n; },
    buildRadius() { return buildRadius(data, save); },
  };
  game.construction = new Construction(game);
  game.workforce = new Workforce(game);
  return game;
}

function richSave() {
  const save = createNewSave({ worldSeed: 99 });
  save.player.level = 30;
  Object.assign(save.resources, { scrap: 9000, essence: 9000, wood: 9000, stone: 9000 });
  return save;
}

test('upkeep: per day by cause, how long the vault lasts, hourly charges', () => {
  const rates = { perStructure: { wood: 0.5, stone: 0.5 }, perBuildingLevel: { scrap: 1 }, perWorker: { scrap: 10, essence: 6 } };
  const day = upkeepPerDay({ structures: 10, buildingLevels: 4, workers: 2 }, rates);
  assert.deepEqual(day.structures, { wood: 5, stone: 5 });
  assert.deepEqual(day.buildings, { scrap: 4 });
  assert.deepEqual(day.workers, { scrap: 20, essence: 12 });
  assert.deepEqual(day.total, { wood: 5, stone: 5, scrap: 24, essence: 12 });
  // 48 scrap is two days of scrap; essence (24 = 2 days) and wood/stone last longer.
  assert.equal(suppliesLast({ wood: 50, stone: 50, scrap: 48, essence: 24 }, day.total), 48);
  assert.equal(suppliesLast({}, {}), Infinity);
  assert.equal(formatHours(50), '2 d 2 h');
  assert.equal(formatHours(50, 'sv'), '2 d 2 tim');
  assert.equal(formatHours(0.5), '30 min');
  // Twelve hours: half a day, paid from the vault, then from pockets.
  const vault = { scrap: 5, essence: 100, wood: 100, stone: 100 };
  const pockets = { scrap: 100 };
  const owed = {};
  assert.equal(chargeUpkeep(day.total, 12, owed, [vault, pockets]), true);
  assert.equal(vault.scrap, 0);
  assert.equal(pockets.scrap, 93, 'the rest of the 12 scrap came from your pockets');
  assert.equal(vault.essence, 94);
  // Nothing left anywhere: unpaid.
  assert.equal(chargeUpkeep(day.total, 24, owed, [{}, {}]), false);
});

test('workers: lodge capacity, hiring costs, skills', () => {
  assert.equal(workerCap(data, 0), 0);
  assert.equal(workerCap(data, 1), 2);
  assert.equal(workerCap(data, 5), 6);
  const first = hireCost(data, 0);
  const third = hireCost(data, 2);
  assert.ok(third.scrap > first.scrap, 'each worker costs more than the last');
  assert.equal(workerTier(1), 1);
  assert.equal(workerTier(5), 4);
  const tree = harvestInfo(data, T.TREE);
  const rock = harvestInfo(data, T.ROCK);
  const ore = harvestInfo(data, T.ORE);
  assert.ok(canWorkOn(tree, 'wood', 1) && !canWorkOn(tree, 'stone', 1));
  assert.ok(canWorkOn(rock, 'stone', 1) && !canWorkOn(rock, 'wood', 1));
  assert.ok(!canWorkOn(ore, 'stone', 3) && canWorkOn(ore, 'stone', 4));
  assert.deepEqual(workerLook(3, 7), workerLook(3, 7), 'the same worker looks the same everywhere');
});

test('a lumberjack walks out, fells trees and carries the wood to the vault', () => {
  const save = richSave();
  save.base.buildings.lodge = 1;
  save.base.buildings.vault = 1;
  const game = stubGame(save);
  const w = game.workforce.hire('wood');
  assert.ok(w);
  assert.equal(game.workforce.list.length, 1);
  const before = save.base.vault.wood ?? 0;
  const harvested = Object.keys(save.world.harvested).length;
  // Simulate up to five minutes of work.
  const worker = game.workforce.list[0];
  for (let i = 0; i < 60 * 300 && (save.base.vault.wood ?? 0) === before; i++) {
    game.time += 1 / 60;
    game.workforce.update(1 / 60);
  }
  assert.ok((save.base.vault.wood ?? 0) > before, `wood reached the vault (worker is ${worker.state})`);
  assert.ok(Object.keys(save.world.harvested).length > harvested, 'trees were cut down');
  // Nothing was cut inside the camp.
  for (const key of Object.keys(save.world.harvested)) {
    const [x, y] = key.split(',').map(Number);
    assert.ok(Math.hypot(x, y) > buildRadius(data, save), `cut at ${key}`);
  }
});

test('a hurt worker turns on you, calms down, and a dead one is gone', () => {
  const save = richSave();
  save.base.buildings.lodge = 2;
  const game = stubGame(save);
  game.workforce.hire('stone');
  const w = game.workforce.list[0];
  w.x = game.player.x + 0.6;
  w.y = game.player.y;
  assert.ok(game.workforce.hit({ kind: 'circle', x: w.x, y: w.y, r: 0.5 }, 5));
  assert.equal(w.angry, 'player');
  for (let i = 0; i < 120; i++) {
    game.time += 1 / 60;
    game.workforce.update(1 / 60);
  }
  assert.ok(game.hurt > 0, 'the angry worker hit back');
  game.time += 60;
  game.workforce.update(1 / 60);
  assert.equal(w.angry, null, 'calm again after a while');
  game.workforce.hit({ kind: 'circle', x: w.x, y: w.y, r: 0.5 }, 9999);
  game.workforce.update(1 / 60);
  assert.equal(save.base.workers.length, 0);
  assert.equal(game.workforce.list.length, 0);
});

test('the camp pays upkeep every hour from the vault, and unpaid workers stop', () => {
  const save = richSave();
  save.base.buildings.lodge = 1;
  save.base.buildings.vault = 1;
  const game = stubGame(save);
  game.workforce.hire('wood');
  game.workforce.hire('stone');
  game.construction.place('wood_wall', 3, 3);
  const day = game.workforce.perDay();
  assert.ok(day.workers.scrap > 0 && day.structures.wood > 0 && day.buildings.scrap > 0);
  game.workforce.deposit({ scrap: 100, essence: 100, wood: 10, stone: 10 });
  assert.equal(save.base.vault.scrap, 100);
  assert.ok(Number.isFinite(game.workforce.suppliesLast()));
  // Three hours pass (away: workers bring in a rough share).
  const now = Date.now();
  save.base.upkeepAt = now - 3 * HOUR_MS - 1000;
  game.workforce.chargeDue(now);
  assert.ok(save.base.vault.scrap < 100, 'wages came out of the vault');
  assert.ok(save.base.vault.wood > 10, 'away, workers still brought wood in');
  assert.equal(save.base.unpaid, false);
  // Broke: nothing in the vault or pockets.
  for (const k of ['scrap', 'essence', 'wood', 'stone']) {
    save.base.vault[k] = 0;
    save.resources[k] = 0;
  }
  save.base.owed = {};
  save.base.upkeepAt = now - 24 * HOUR_MS;
  game.workforce.chargeDue(now);
  assert.equal(save.base.unpaid, true);
  assert.ok(game.toasts.some((t) => /not being paid/.test(t)));
  game.workforce.update(0.1);
  assert.ok(game.workforce.list.every((w) => w.state === 'rest' || w.state === 'return'));
});

test('walls upgrade in place: wood → stone → reinforced', () => {
  const save = richSave();
  Object.assign(save.base.buildings, { hearth: 4, forge: 3 });
  const game = stubGame(save);
  const c = game.construction;
  assert.ok(c.place('wood_wall', 3, 3).ok);
  const wood = structureDef(data, 'wood_wall');
  const stone = upgradeDef(data, wood);
  assert.equal(stone.id, 'stone_wall');
  const cost = upgradeCost(data, wood, stone);
  const before = save.resources.stone;
  assert.ok(c.upgrade(3, 3).ok);
  assert.equal(game.world.structureAt(3, 3).id, 'stone_wall');
  assert.equal(game.world.structureAt(3, 3).hp, stone.hp);
  assert.equal(save.resources.stone, before - cost.stone);
  assert.ok(c.upgrade(3, 3).ok);
  assert.equal(game.world.structureAt(3, 3).id, 'iron_wall');
  assert.match(c.upgrade(3, 3).reason, /as strong as it gets/);
  // Bulk: every wooden wall at once.
  for (let x = -2; x < 2; x++) assert.ok(c.place('wood_wall', x, 4).ok);
  assert.equal(c.upgradeAll('wood_wall'), 4);
  assert.ok(save.base.structures.filter((st) => st.y === 4).every((st) => st.id === 'stone_wall'));
  // Saved as the new kind.
  const reloaded = stubGame(fillDefaults(JSON.parse(JSON.stringify(save))));
  assert.equal(reloaded.world.structureAt(3, 3).id, 'iron_wall');
});

test('cut trees grow back in steps, never inside the camp', () => {
  const world = new World(data, 7);
  world.noRegrow = (tx, ty) => Math.hypot(tx, ty) < 20;
  let spot = null;
  for (let y = 30; y < 90 && !spot; y++) for (let x = 30; x < 90 && !spot; x++) if (world.blockAt(x, y) === T.TREE) spot = [x, y];
  assert.ok(spot, 'found a tree');
  const [x, y] = spot;
  const t0 = 1_000_000;
  world.removeBlock(x, y, t0);
  const entry = world.harvested[`${x},${y}`];
  const minutes = harvestInfo(data, T.TREE).regrowMinutes;
  const at = (frac) => world.growthStage(x, y, entry, t0 + frac * minutes * 60000);
  assert.deepEqual([at(0), at(0.3), at(0.55), at(0.8)], [0, 1, 2, 3]);
  const chunk = world.getChunk(Math.floor(x / 16), Math.floor(y / 16));
  assert.equal(world.growthOf(chunk, t0).length, 1);
  assert.equal(world.growthStage(1, 1, entry, t0), -1, 'the camp stays cleared');
  world.restoreBlock(x, y);
  assert.equal(world.blockAt(x, y), T.TREE);
  assert.equal(world.growthOf(chunk, t0).length, 0);
});

test('workers stand still while not working, and can be stepped without a game', () => {
  const stats = workerStats(data, 1);
  const w = createWorker({ id: 1, role: 'wood' }, { x: 0, y: 0 }, stats);
  const ctx = { world: new World(data, 3), data, time: 0, stats, home: { x: 0, y: 0 }, clear: null, working: false, taken: new Set(), fell: () => ({}), deliver() {}, target: () => null, strike() {} };
  for (let i = 0; i < 300; i++) stepWorker(w, ctx, 1 / 30);
  assert.equal(w.state, 'rest');
  assert.equal(w.idle, true);
  assert.equal(hurtWorker(w, ctx, w.hp + 1, 'x'), true);
  assert.equal(w.dead, true);
});
