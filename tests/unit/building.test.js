import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave } from '../../src/storage/save.js';
import { World, T, tileKey } from '../../src/game/world.js';
import {
  pickaxeBlockers, forgePickaxe, currentPickaxe, nextPickaxe, harvestInfo, rollDrops,
} from '../../src/game/gathering.js';
import { Construction, buildRadius, structureDef, refundFor } from '../../src/game/construction.js';
import { salvageValue } from '../../src/game/loot.js';
import { loadData } from './helpers.js';

const data = loadData();

/** Just enough of a Game for the construction system. */
function stubGame(save) {
  const world = new World(data, save.worldSeed);
  world.harvested = save.world.harvested;
  const game = {
    data, save, world, time: 0, enemies: [],
    player: { x: 0.5, y: 1.6, r: 0.32, dead: false },
    fx: { emit() {}, text() {} },
    audio: { play() {} },
    emit() {},
    toast() {},
    requestSave() {},
    damageEnemy() {},
    spawnProjectile() { return {}; },
    schedule() {},
  };
  game.construction = new Construction(game);
  return game;
}

function richSave() {
  const save = createNewSave({ worldSeed: 99 });
  save.player.level = 20;
  Object.assign(save.resources, { scrap: 5000, essence: 5000, wood: 5000, stone: 5000 });
  return save;
}

test('pickaxes are forged at the Forge, one tier after another', () => {
  const save = createNewSave({ worldSeed: 1 });
  const first = nextPickaxe(data, save);
  assert.equal(first.tier, 1);
  assert.ok(pickaxeBlockers(data, save, first).includes('Build a Forge first'));
  save.base.buildings.forge = 1;
  Object.assign(save.resources, { scrap: 100, essence: 100 });
  assert.deepEqual(pickaxeBlockers(data, save, first), []);
  forgePickaxe(data, save, 1);
  assert.equal(currentPickaxe(data, save).tier, 1);
  assert.equal(save.resources.scrap, 100 - first.cost.scrap);
  const second = nextPickaxe(data, save);
  assert.ok(pickaxeBlockers(data, save, second).some((b) => b.includes('Forge level')));
  assert.throws(() => forgePickaxe(data, save, 3), /previous/);
});

test('trees give wood, rocks give stone, crystals need a better pickaxe', () => {
  const tree = harvestInfo(data, T.TREE);
  const rock = harvestInfo(data, T.ROCK);
  const crystal = harvestInfo(data, T.CRYSTAL);
  assert.ok(tree.drops.wood && rock.drops.stone);
  assert.ok(crystal.tier > tree.tier);
  assert.equal(harvestInfo(data, T.WATER), null, 'water is not harvestable');
  for (let i = 0; i < 50; i++) {
    const d = rollDrops(tree);
    assert.ok(d.wood >= tree.drops.wood[0] && d.wood <= tree.drops.wood[1]);
  }
});

test('harvested tiles stay gone after reload and can regrow', () => {
  const save = createNewSave({ worldSeed: 7 });
  const world = new World(data, save.worldSeed);
  world.harvested = save.world.harvested;
  // Find a tree somewhere near the camp.
  let spot = null;
  for (let r = 10; r < 40 && !spot; r++) {
    for (let x = -r; x <= r && !spot; x++) {
      if (world.blockAt(x, r) === T.TREE) spot = { x, y: r };
    }
  }
  assert.ok(spot, 'found a tree');
  assert.equal(world.removeBlock(spot.x, spot.y), T.TREE);
  assert.equal(world.blockAt(spot.x, spot.y), 0);
  // A fresh world (after a reload) built from the same save keeps it cleared.
  const again = new World(data, save.worldSeed);
  again.harvested = save.world.harvested;
  assert.equal(again.blockAt(spot.x, spot.y), 0);
  again.restoreBlock(spot.x, spot.y);
  assert.equal(again.blockAt(spot.x, spot.y), T.TREE);
  assert.equal(save.world.harvested[`${spot.x},${spot.y}`], undefined);
});

test('movement modes: gates let you through, flyers skip trees but never water', () => {
  const save = richSave();
  const game = stubGame(save);
  const { world } = game;
  let water = null;
  let tree = null;
  for (let r = 10; r < 80 && (!water || !tree); r++) {
    for (let x = -r; x <= r; x++) {
      const b = world.blockAt(x, r);
      if (b === T.WATER && !water) water = { x, y: r };
      if (b === T.TREE && !tree) tree = { x, y: r };
    }
  }
  assert.ok(water && tree);
  assert.equal(world.blockedFor(water.x, water.y, 'fly'), true, 'flyers avoid water');
  assert.equal(world.blockedFor(tree.x, tree.y, 'fly'), false, 'flyers pass over trees');
  assert.equal(world.blockedFor(tree.x, tree.y, 'enemy'), true);
  assert.ok(game.construction.place('gate', 3, 0).ok);
  assert.equal(world.blockedFor(3, 0, 'player'), false, 'you walk through your gate');
  assert.equal(world.blockedFor(3, 0, 'enemy'), true, 'enemies do not');
  assert.ok(game.construction.place('wood_floor', 3, 1).ok);
  assert.equal(world.blockedFor(3, 1, 'enemy'), false, 'floors are walkable');
});

test('floors lie under things: turrets, walls and torches can stand on them', () => {
  const save = richSave();
  save.base.buildings.training = 1;
  const game = stubGame(save);
  const c = game.construction;
  const { world } = game;
  assert.ok(c.place('stone_floor', 3, 1).ok);
  assert.ok(c.place('arrow_turret', 3, 1).ok, 'a turret on a floor');
  assert.equal(world.structureAt(3, 1).id, 'arrow_turret');
  assert.equal(world.floorAt(3, 1).id, 'stone_floor');
  assert.equal(world.blockedFor(3, 1, 'enemy'), true, 'the turret still blocks');
  assert.match(c.place('wood_floor', 3, 1).reason, /already/, 'one floor per tile');
  assert.match(c.place('torch', 3, 1).reason, /already/, 'one thing on top');
  // A floor can also go under something already built.
  assert.ok(c.place('wood_wall', 3, 2).ok);
  assert.ok(c.place('wood_floor', 3, 2).ok);
  // Taking down removes the top first, then the floor.
  assert.equal(c.at(3, 1).id, 'arrow_turret');
  c.remove(3, 1);
  assert.equal(world.structureAt(3, 1), null);
  assert.equal(c.at(3, 1).id, 'stone_floor');
  c.remove(3, 1);
  assert.equal(c.at(3, 1), null);
  // Both layers come back after a reload.
  const reloaded = stubGame(save);
  assert.equal(reloaded.world.structureAt(3, 2).id, 'wood_wall');
  assert.equal(reloaded.world.floorAt(3, 2).id, 'wood_floor');
});

test('the camp: every building stands on the plaza, with room to walk around each', () => {
  const save = richSave();
  const game = stubGame(save);
  for (const b of data.base.buildings) {
    // The sprite's footprint (two tiles wide) is on the paved plaza.
    for (const dx of [-1, 0]) {
      const g = game.world.getChunk(Math.floor((b.x + dx) / 16), Math.floor(b.y / 16));
      const lx = ((Math.floor(b.x + dx) % 16) + 16) % 16;
      const ly = ((Math.floor(b.y) % 16) + 16) % 16;
      assert.equal(g.ground[ly * 16 + lx], T.CAMP, `${b.id} stands on the plaza`);
    }
    for (const o of data.base.buildings) {
      if (o === b) continue;
      const apart = Math.abs(Math.floor(o.x) - Math.floor(b.x)) >= 4 || Math.abs(Math.floor(o.y) - Math.floor(b.y)) >= 4;
      assert.ok(apart, `${b.id} and ${o.id} leave a lane between them`);
    }
  }
});

test('structures in the way of a building are taken down and refunded on load', () => {
  const save = richSave();
  const den = data.base.buildings.find((b) => b.id === 'den');
  save.base.structures.push({ id: 'wood_wall', x: Math.floor(den.x), y: Math.floor(den.y), hp: 120 });
  const wood = save.resources.wood;
  stubGame(save);
  assert.equal(save.base.structures.length, 0);
  assert.equal(save.resources.wood, wood + structureDef(data, 'wood_wall').cost.wood);
});

test('building: costs, camp area, obstacles, refunds and saving', () => {
  const save = richSave();
  const game = stubGame(save);
  const c = game.construction;
  const wall = structureDef(data, 'wood_wall');
  const wood = save.resources.wood;
  assert.ok(c.place('wood_wall', 3, 0).ok);
  assert.equal(save.resources.wood, wood - wall.cost.wood);
  assert.equal(game.world.structureAt(3, 0).id, 'wood_wall');
  assert.match(c.place('wood_wall', 3, 0).reason, /already/);
  const far = Math.ceil(buildRadius(data, save)) + 3;
  game.player.x = far;
  game.player.y = 0.5;
  assert.match(c.place('wood_wall', far, 0).reason, /Outside your camp/);
  game.player.x = 0.5;
  game.player.y = 1.6;
  assert.match(c.place('wood_wall', 0, 0).reason, /camp building/);
  assert.match(c.place('wood_wall', 0, 1).reason, /camp building|standing/);
  save.resources.wood = 0;
  assert.match(c.place('wood_wall', 3, 2).reason, /wood/);
  save.resources.wood = 100;
  // Stone walls need a better Hearth.
  assert.match(c.place('stone_wall', 3, 3).reason, /Hearth level 2/);
  save.base.buildings.hearth = 2;
  assert.ok(c.place('stone_wall', 3, 3).ok);
  // Removing refunds half.
  const before = save.resources.wood;
  const refund = c.remove(3, 0);
  assert.deepEqual(refund, refundFor(data, wall));
  assert.equal(save.resources.wood, before + refund.wood);
  assert.equal(game.world.structureAt(3, 0), null);
  // Only plain data is saved (no runtime fields).
  const saved = JSON.parse(JSON.stringify(save.base.structures));
  assert.deepEqual(Object.keys(saved[0]).sort(), ['hp', 'id', 'x', 'y']);
  // Reloading rebuilds the collision map.
  const reloaded = stubGame(save);
  assert.equal(reloaded.world.structureAt(3, 3).id, 'stone_wall');
});

test('enemies can break structures; turrets hit harder as you grow', () => {
  const save = richSave();
  save.base.buildings.training = 1;
  const game = stubGame(save);
  const c = game.construction;
  assert.ok(c.place('wood_wall', 3, 0).ok);
  const st = game.world.structureAt(3, 0);
  c.damage(st, st.def.hp + 1);
  assert.equal(game.world.structureAt(3, 0), null);
  assert.equal(save.base.structures.length, 0);
  const turret = structureDef(data, 'arrow_turret');
  const strong = c.turretDamage(turret);
  save.player.level = 1;
  save.base.buildings.training = 0;
  assert.ok(c.turretDamage(turret) < strong);
  assert.ok(game.world.structures.get(tileKey(3, 0)) === undefined);
});

test('salvaging is a trickle: never more than a fraction of crafting costs', () => {
  const dna = (rarity, lvl) => ({ rarity, ctx: { lvl } });
  assert.deepEqual(salvageValue(dna('common', 1)), { scrap: 2, essence: 0 });
  const legendary = salvageValue(dna('legendary', 20));
  assert.ok(legendary.essence < data.catalysts.find((c) => c.id === 'legendary').essence / 20);
});
