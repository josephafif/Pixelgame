import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import { World, T, CHUNK } from '../../src/game/world.js';
import {
  BREEDS, herdsNear, herdForCell, horseStats, herdHorseSeed, describeHorse, MAX_HORSES, STRAY_SECONDS, REGROW_MS,
} from '../../src/game/horses.js';
import { Stable } from '../../src/game/riding.js';
import { slideMove } from '../../src/net/movement.js';
import { loadData } from './helpers.js';

const data = loadData();

function stubGame(save) {
  const world = new World(data, save.worldSeed);
  const game = {
    data, save, world, buffs: [], toasts: [],
    player: { x: 0.5, y: 1.6, r: 0.32, dead: false },
    fx: { emit() {} },
    audio: { play() {} },
    emit() {},
    toast(text) { game.toasts.push(text); },
    requestSave() {},
    recomputeStats() {},
  };
  game.stable = new Stable(game);
  return game;
}

function setBlock(world, x, y, b) {
  const chunk = world.getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
  chunk.block[(y - chunk.cy * CHUNK) * CHUNK + (x - chunk.cx * CHUNK)] = b;
}

test('herds: here and there (a short ride from the start), on land, the same every time', () => {
  const world = new World(data, 4242);
  const herds = herdsNear(world, 0, 0, 600);
  assert.ok(herds.length >= 20, `plenty of herds (${herds.length})`);
  assert.ok(herds.length < 90, 'but not everywhere');
  assert.ok(herds.some((h) => Math.hypot(h.x, h.y) < 160), 'one within a short ride');
  for (const h of herds) {
    assert.ok(Math.hypot(h.x, h.y) > 60, 'none right next to the start');
    assert.ok(h.size >= 2 && h.size <= 4);
    assert.equal(h.breeds.length, h.size);
    for (const b of h.breeds) assert.ok(BREEDS.find((x) => x.id === b).biomes.includes(h.biome), 'breeds live in their biomes');
  }
  const again = new World(data, 4242);
  const [first] = herds;
  const [hx, hy] = first.key.slice(5).split(',').map(Number);
  assert.deepEqual(herdForCell(again, hx, hy), first);
});

test('horses differ: each has its own speed, health and name, from its breed', () => {
  const a = horseStats('courser', 1);
  const b = horseStats('courser', 2);
  const pony = BREEDS.find((x) => x.id === 'pony');
  const courser = BREEDS.find((x) => x.id === 'courser');
  for (const h of [a, b]) {
    assert.ok(h.speed >= courser.speed * 0.92 - 0.01 && h.speed <= courser.speed * 1.08 + 0.01);
    assert.ok(h.speed > pony.speed, 'a courser outruns a pony');
  }
  assert.deepEqual(horseStats('courser', 1), a, 'same seed, same horse');
  assert.match(describeHorse(a), /Courser · speed/);
  assert.match(describeHorse(a, true), /Fullblod · fart/);
});

test('on horseback you jump trees and rocks, but not water or walls', () => {
  const world = new World(data, 7);
  const x = 300;
  const y = 300;
  for (let i = 0; i < 6; i++) setBlock(world, x + i, y, 0);
  setBlock(world, x + 2, y, T.TREE);
  assert.equal(world.blockedFor(x + 2, y, 'player'), true, 'a tree stops you on foot');
  assert.equal(world.blockedFor(x + 2, y, 'horse'), false, 'a horse jumps it');
  setBlock(world, x + 3, y, T.WATER);
  assert.equal(world.blockedFor(x + 3, y, 'horse'), true, 'no swimming horses');
  const p = { x: x + 0.5, y: y + 0.5, r: 0.36 };
  for (let i = 0; i < 30; i++) slideMove(world, p, 0.15, 0, p.r, 'horse');
  assert.ok(p.x > x + 2.5 && p.x < x + 3, `over the tree, stopped at the water (${p.x})`);
});

test('taming, riding and stabling a horse (single player)', () => {
  const save = createNewSave({ worldSeed: 4242 });
  const game = stubGame(save);
  const herd = herdsNear(game.world, 0, 0, 600)[0];
  Object.assign(game.player, { x: herd.x, y: herd.y });
  game.stable.update(0.1);
  const wild = game.stable.list.filter((h) => !h.own);
  assert.equal(wild.length, herd.size, 'the herd shows up when you come near');
  const h = wild[0];
  const expected = horseStats(h.breed, herdHorseSeed(game.world, herd, h.idx));
  assert.equal(h.speed, expected.speed);
  assert.equal(game.stable.mount(h), true);
  assert.equal(game.stable.riding.name, expected.name);
  assert.equal(game.buffs.find((b) => b.source === 'horse').value, expected.hp, 'extra health while riding');
  assert.equal(game.stable.list.filter((x) => !x.own).length, herd.size - 1, 'it left the herd');
  // Off out in the wild: it waits a while, then runs off when you go far away.
  game.stable.dismount();
  assert.equal(game.buffs.length, 0);
  assert.equal(save.horses.owned[0].stabled, false);
  Object.assign(game.player, { x: herd.x + 500, y: herd.y });
  game.stable.update(1);
  save.horses.owned[0].leftAt = Date.now() - (STRAY_SECONDS + 1) * 1000;
  game.stable.checkT = 0;
  game.stable.update(1);
  assert.equal(save.horses.owned.length, 0, 'ran off');
  assert.match(game.toasts.at(-1), /ran off/);
  // The herd has one horse less for a while.
  Object.assign(game.player, { x: herd.x, y: herd.y });
  game.stable.wild.clear();
  game.stable.checkT = 0;
  game.stable.update(0.1);
  assert.equal(game.stable.list.length, herd.size - 1);
  save.horses.taken[h.key] = Date.now() - REGROW_MS - 1;
  game.stable.checkT = 0;
  game.stable.update(0.1);
  assert.equal(game.stable.list.length, herd.size, 'grows back');
  // Ride one home: in camp it stays, however far you go.
  game.stable.mount(game.stable.list[0]);
  Object.assign(game.player, { x: 1.5, y: 3.5 });
  game.stable.dismount();
  assert.equal(save.horses.owned[0].stabled, true);
  Object.assign(game.player, { x: 900, y: 900 });
  save.horses.owned[0].leftAt = 0;
  game.stable.checkT = 0;
  game.stable.update(1);
  assert.equal(save.horses.owned.length, 1, 'still in camp');
  // Saved and loaded on horseback: the extra health comes back.
  game.stable.mount(game.stable.list.find((x) => x.own));
  const loaded = fillDefaults(JSON.parse(JSON.stringify(save)));
  const game2 = stubGame(loaded);
  assert.ok(game2.stable.riding);
  assert.equal(game2.buffs[0].source, 'horse');
});

test('you can own only so many horses', () => {
  const save = createNewSave({ worldSeed: 4242 });
  const game = stubGame(save);
  for (let i = 0; i < MAX_HORSES; i++) save.horses.owned.push({ id: i + 1, breed: 'pony', speed: 6, gallop: 1.25, hp: 10, name: 'Molly', x: 0, y: 0, stabled: true });
  const herd = herdsNear(game.world, 0, 0, 600)[0];
  Object.assign(game.player, { x: herd.x, y: herd.y });
  game.stable.update(0.1);
  const wild = game.stable.list.find((h) => !h.own);
  assert.equal(game.stable.mount(wild), false);
  assert.match(game.toasts.at(-1), /Let one go/);
  assert.equal(game.stable.release(1), true);
  assert.equal(game.stable.mount(wild), true);
});
