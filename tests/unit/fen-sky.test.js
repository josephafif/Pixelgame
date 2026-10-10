// Mireglass Fen and Skyreach: where they grow, the bog that slows and the
// wind that carries you, a horse leaping the gaps between islands, Gale
// Step, the Wind Beacon and the Healing Garden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, T, CHUNK, FAR_MIN } from '../../src/game/world.js';
import { groundEffect, tryLeap, stepMove, dash, DASH_DIST, LEAP_MAX, PLAYER_RADIUS } from '../../src/net/movement.js';
import { knownSkills, beaconOf, dashCooldown, GALE_STEP } from '../../src/game/skills.js';
import { computePlayerStats } from '../../src/game/stats.js';
import { upgradeBlockers, baseBonuses, describeBonus, TONIC } from '../../src/game/base.js';
import { createNewSave } from '../../src/storage/save.js';
import { PLANT_AREAS, plantsHit } from '../../src/game/plants.js';
import { loadData } from './helpers.js';

const data = loadData();

function chunkAt(w, x, y) {
  return w.getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
}

/** Sets a tile's ground and block directly (tests only). */
function setTile(w, x, y, ground, block = 0) {
  const c = chunkAt(w, x, y);
  const i = (y - c.cy * CHUNK) * CHUNK + (x - c.cx * CHUNK);
  c.ground[i] = ground;
  c.block[i] = block;
}

/** A strip of island grass, w × h tiles from (x, y), nothing on it. */
function strip(w, x, y, wide, high, ground = T.SKYGRASS) {
  for (let j = 0; j < high; j++) for (let i = 0; i < wide; i++) setTile(w, x + i, y + j, ground, 0);
}

test('far lands: the fen and Skyreach grow far out, with their own ground', () => {
  for (const seed of [1, 42, 4242]) {
    const w = new World(data, seed);
    const fen = w.farRegions.find((r) => r.id === 'fen');
    const sky = w.farRegions.find((r) => r.id === 'skyreach');
    assert.ok(fen && sky, `seed ${seed}: both regions`);
    assert.equal(w.biomeAt(fen.x, fen.y).id, 'fen');
    assert.equal(w.biomeAt(sky.x, sky.y).id, 'skyreach');
    for (const r of [fen, sky]) assert.ok(Math.hypot(r.x, r.y) > FAR_MIN);
    // The fen: moss and peat, turquoise water and bog.
    const grounds = new Set();
    const blocks = new Set();
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const c = chunkAt(w, fen.x + dx * CHUNK, fen.y + dy * CHUNK);
        for (const g of c.ground) grounds.add(g);
        for (const b of c.block) blocks.add(b);
      }
    }
    assert.ok(grounds.has(T.FENMOSS) && grounds.has(T.BOG), `seed ${seed}: fen moss and bog`);
    assert.ok(blocks.has(T.FENWATER), 'swamp water');
    assert.ok(blocks.has(T.MENDBLOOM) || blocks.has(T.PUFFCAP), 'plants to burst');
    // Skyreach: islands in a sea of clouds, with bridges between.
    const sg = new Set();
    const sb = new Set();
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const c = chunkAt(w, sky.x + dx * CHUNK, sky.y + dy * CHUNK);
        for (const g of c.ground) sg.add(g);
        for (const b of c.block) sb.add(b);
      }
    }
    assert.ok(sg.has(T.SKYGRASS) && sb.has(T.SKY), `seed ${seed}: islands and clouds`);
    assert.ok(sg.has(T.SKYBRIDGE), 'bridges');
  }
});

test('the ground underfoot: bog slows walkers (horses less), wind currents carry you', () => {
  const w = new World(data, 7);
  strip(w, 200, 40, 6, 3, T.FENMOSS);
  setTile(w, 202, 41, T.BOG);
  setTile(w, 203, 41, T.WIND_E);
  assert.equal(groundEffect(w, 200.5, 41.5, 'player').speed, 1);
  const foot = groundEffect(w, 202.5, 41.5, 'player');
  const horse = groundEffect(w, 202.5, 41.5, 'horse');
  assert.ok(foot.speed < horse.speed && horse.speed < 1);
  const wind = groundEffect(w, 203.5, 41.5, 'player');
  assert.ok(wind.wx > 0 && wind.wy === 0, 'blows east');
  assert.equal(groundEffect(w, 203.5, 41.5, 'boat').wx, 0, 'boats don\'t care');
  // Standing still on a current, you drift.
  const s = { x: 203.5, y: 41.5, kx: 0, ky: 0 };
  stepMove(w, s, { mx: 0, my: 0, buttons: 0 }, 4, 1.5);
  assert.ok(s.x > 203.5);
});

test('a horse leaps a narrow gap in the clouds; on foot, or over a wide gap, you stay put', () => {
  const w = new World(data, 7);
  const y = 60;
  strip(w, 300, y, 4, 3); // 300..303
  for (let x = 304; x < 306; x++) for (let j = 0; j < 3; j++) setTile(w, x, y + j, T.SKYGRASS, T.SKY); // a 2-tile gap
  strip(w, 306, y, 4, 3); // 306..309
  // On foot the clouds are a wall.
  assert.equal(w.isFree(304.5, y + 1.5, PLAYER_RADIUS, 'player'), false);
  const foot = { x: 303.6, y: y + 1.5, kx: 0, ky: 0 };
  for (let i = 0; i < 20; i++) stepMove(w, foot, { mx: 127, my: 0, buttons: 0 }, 5, 1.5);
  assert.ok(foot.x < 304, 'walking stops at the edge');
  // A horse runs at it and lands on the far side.
  const rider = { x: 303.6, y: y + 1.5, kx: 0, ky: 0 };
  for (let i = 0; i < 20 && !rider.leap; i++) stepMove(w, rider, { mx: 127, my: 0, buttons: 0 }, 6, 1.6, PLAYER_RADIUS, 'horse');
  assert.ok(rider.leap, 'it leapt');
  assert.ok(rider.x >= 306, `landed across (${rider.x})`);
  // A gap wider than LEAP_MAX is too far.
  const w2 = new World(data, 7);
  strip(w2, 300, y, 4, 3);
  const wide = Math.ceil(LEAP_MAX) + 2;
  for (let x = 304; x < 304 + wide; x++) for (let j = 0; j < 3; j++) setTile(w2, x, y + j, T.SKYGRASS, T.SKY);
  strip(w2, 304 + wide, y, 4, 3);
  const s = { x: 303.6, y: y + 1.5, kx: 0, ky: 0 };
  assert.equal(tryLeap(w2, s, 1, 0, PLAYER_RADIUS), false);
  assert.equal(s.x, 303.6);
});

test('Gale Step: a quick dash the way you walk (or aim), stopped by walls and the clouds, the same everywhere', () => {
  const w = new World(data, 7);
  strip(w, 400, 80, 12, 3, T.GRASS);
  const s = { x: 400.5, y: 81.5, kx: 0, ky: 0 };
  assert.equal(dash(w, s, { mx: 127, my: 0, aim: 0 }), true);
  assert.ok(Math.abs(s.x - (400.5 + DASH_DIST)) < 1e-9, 'a full dash east');
  assert.deepEqual(s.dash, { x0: 400.5, y0: 81.5 });
  // Standing still, it goes the way you aim (64 = south on the wire).
  const t = { x: 404.5, y: 80.5, kx: 0, ky: 0 };
  strip(w, 404, 80, 1, 6, T.GRASS);
  dash(w, t, { mx: 0, my: 0, aim: 64 });
  assert.ok(Math.abs(t.y - (80.5 + DASH_DIST)) < 1e-9 && t.x === 404.5, 'south');
  // Water stops it at the edge.
  setTile(w, 403, 81, T.GRASS, T.WATER);
  const u = { x: 400.5, y: 81.5, kx: 0, ky: 0 };
  dash(w, u, { mx: 127, my: 0 });
  assert.ok(u.x < 403 - PLAYER_RADIUS + 1e-9, 'not through the water');
  // Bit for bit the same, run twice.
  const a = { x: 400.3, y: 81.2, kx: 0, ky: 0 };
  const b = { x: 400.3, y: 81.2, kx: 0, ky: 0 };
  dash(w, a, { mx: 90, my: 33 });
  dash(w, b, { mx: 90, my: 33 });
  assert.deepEqual([a.x, a.y], [b.x, b.y]);
});

test('skills come from researched components; the Wind Beacon speeds you up and recharges Gale Step', () => {
  const save = createNewSave({ worldSeed: 3 });
  assert.equal(knownSkills(data, save.components).size, 0);
  save.components.gale_feather = { researched: false };
  assert.equal(knownSkills(data, save.components).has(GALE_STEP.id), false, 'found is not enough');
  save.components.gale_feather.researched = true;
  assert.equal(knownSkills(data, save.components).has(GALE_STEP.id), true);
  // The beacon: no beacon, no bonus.
  assert.equal(beaconOf(data, save).moveSpeedPct, 0);
  const slow = computePlayerStats(data, save, null, []).moveSpeed;
  save.base.structures.push({ id: 'wind_beacon', x: 3, y: 3, hp: 260 });
  const b = beaconOf(data, save);
  assert.ok(b.moveSpeedPct > 0 && b.dashCooldownPct > 0);
  const fast = computePlayerStats(data, save, null, []).moveSpeed;
  assert.ok(Math.abs(fast - slow * (1 + b.moveSpeedPct / 100)) < 1e-9, 'quicker everywhere');
  assert.ok(dashCooldown(b) < dashCooldown(null), 'recharges sooner');
  assert.equal(dashCooldown(null), GALE_STEP.cooldown);
  // Multiplayer: the clan's beacon comes with the stat save.
  assert.equal(beaconOf(data, { base: { beacon: { moveSpeedPct: 8, dashCooldownPct: 40 } } }).moveSpeedPct, 8);
  // And something out there teaches it.
  assert.ok(data.biomes.find((x) => x.id === 'skyreach').components.includes('gale_feather'));
  assert.ok(data.components.find((c) => c.id === 'bp_wind_beacon').unlocks.structures.includes('wind_beacon'));
});

test('the Healing Garden: a blueprint first, then healing out of a fight, a ward against the bogs and Lumen Tonic', () => {
  const save = createNewSave({ worldSeed: 3 });
  save.player.level = 30;
  Object.assign(save.resources, { scrap: 9999, essence: 9999, wood: 9999, stone: 9999, spores: 999 });
  assert.match(upgradeBlockers(data, save, 'garden')[0], /Blueprint: Healing Garden/);
  save.components.bp_healing_garden = { researched: true };
  assert.deepEqual(upgradeBlockers(data, save, 'garden'), []);
  save.base.buildings.garden = 2;
  assert.ok(baseBonuses(data, save).regenPct > 0);
  assert.match(describeBonus(data, 'garden', 2), /bogs no longer sicken you/);
  assert.ok(TONIC.cost.spores > 0 && TONIC.seconds > 0);
  assert.ok(data.biomes.find((x) => x.id === 'fen').components.includes('bp_healing_garden'));
});

test('fen plants burst when hit: a healing glow and a poison cloud', () => {
  const w = new World(data, 7);
  strip(w, 500, 90, 5, 3, T.FENMOSS);
  setTile(w, 501, 91, T.FENMOSS, T.MENDBLOOM);
  setTile(w, 503, 91, T.FENMOSS, T.PUFFCAP);
  // They never block anyone.
  assert.equal(w.isFree(501.5, 91.5, PLAYER_RADIUS, 'player'), true);
  const hit = plantsHit(w, 500.5, 91.5, 3.5, () => true).map((x) => x.id).sort();
  assert.deepEqual(hit, [T.MENDBLOOM, T.PUFFCAP].sort());
  assert.equal(PLANT_AREAS[T.MENDBLOOM].kind, 'mend');
  assert.equal(PLANT_AREAS[T.PUFFCAP].kind, 'puff');
});

test('Mireglass Fen and Skyreach content: monsters, an elite, bosses and what they teach', () => {
  for (const id of ['fen', 'skyreach']) {
    const biome = data.byId.biomes.get(id);
    assert.ok(biome.far && biome.enemies.length >= 3);
    for (const e of biome.enemies) assert.ok(data.byId.enemies.get(e), e);
    const boss = data.bosses.find((b) => b.biome === id);
    assert.ok(boss?.far, `${id} has a far boss`);
  }
  assert.ok(data.components.find((c) => c.unlocks?.skills?.includes('gale_step') && c.boss), 'a boss core teaches Gale Step too');
});
