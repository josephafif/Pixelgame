import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MINUTES, START_HOUR, clockAt, hourAt, darknessAt, glowAt, spawnFactor, phaseOf,
} from '../../src/game/daynight.js';
import { scaryLights, litBy, shunLight, campLights, STRUCTURE_LIGHTS } from '../../src/game/lights.js';
import { createNewSave } from '../../src/storage/save.js';
import { loadData } from './helpers.js';

const data = loadData();

test('a day goes round: morning, dusk, night, dawn', () => {
  assert.ok(Math.abs(hourAt(clockAt(13.5)) - 13.5) < 1e-9);
  assert.ok(Math.abs(hourAt(clockAt(13.5) + DAY_MINUTES * 60_000) - 13.5) < 1e-9, 'a whole day later, the same hour');
  assert.ok(Math.abs(hourAt(-clockAt(1)) - 23) < 1e-9, 'before 0 wraps round');
  assert.equal(phaseOf(START_HOUR), 'day');
  assert.equal(phaseOf(19), 'dusk');
  assert.equal(phaseOf(0), 'night');
  assert.equal(phaseOf(6), 'dawn');
  assert.equal(darknessAt(12), 0);
  assert.equal(darknessAt(1), 1);
  assert.ok(darknessAt(19) > 0 && darknessAt(19) < 1, 'dusk is half dark');
  assert.ok(darknessAt(6) > 0 && darknessAt(6) < 1, 'dawn is half dark');
  assert.ok(glowAt(18.8) > 0.9 && glowAt(12) === 0, 'the red glow of sunset');
});

test('fewer monsters by day, more at night', () => {
  assert.ok(spawnFactor(0) < 1);
  assert.ok(spawnFactor(1) > 1.4);
});

test('a new game starts in the morning', () => {
  const save = createNewSave(data, 42);
  assert.equal(phaseOf(hourAt(save.world.clock)), 'day');
});

test('monsters shun the light of fire, never glowing stones', () => {
  const world = {
    structures: new Map([
      ['a', { id: 'torch', x: 10, y: 10 }],
      ['b', { id: 'prism_relay', x: 30, y: 30 }],
      ['c', { id: 'torch', x: 50, y: 50, dead: true }],
    ]),
  };
  const lights = scaryLights(world, 0, [{ x: 0.5, y: 0.5, r: 7, scare: true }]);
  assert.equal(lights.length, 2, 'the torch and the camp fire (not the relay, not a broken torch)');
  assert.ok(litBy(lights, 10.5, 12, 0), 'next to the torch is lit');
  assert.equal(litBy(lights, 30.5, 30.5, 0), null, 'a prism relay only glows');
  assert.equal(scaryLights(world, 500), lights, 'cached for a second');

  // Inside the circle: out, at once.
  const r = STRUCTURE_LIGHTS.torch.r;
  const inside = { x: 10.5 + 1, y: 10.5, vx: -1, vy: 0 };
  shunLight(lights, inside, 2);
  assert.ok(inside.vx > 0 && Math.abs(inside.vy) < 1e-9, 'flees away from the fire');
  // At the edge: never a step further in, but it may go round.
  const edge = { x: 10.5 + r + 0.6, y: 10.5, vx: -2, vy: 1 };
  shunLight(lights, edge, 2);
  assert.ok(Math.abs(edge.vx) < 1e-9, 'no step inwards');
  assert.equal(edge.vy, 1, 'still free to walk round');
  // Bosses don't care.
  const boss = { x: 11, y: 10.5, vx: -1, vy: 0, boss: true };
  shunLight(lights, boss, 2);
  assert.equal(boss.vx, -1);
});

test('the camp\'s hearth and forge light up the night in single player', () => {
  const fires = campLights(data, () => 1);
  assert.ok(fires.some((f) => f.r >= 6), 'the hearth');
  assert.ok(fires.every((f) => f.scare && Number.isFinite(f.x) && Number.isFinite(f.y)));
  assert.equal(campLights(data, () => 0).length, 0, 'no buildings, no fires');
});
