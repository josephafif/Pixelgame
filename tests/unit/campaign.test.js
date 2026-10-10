// The single-player campaign: recruits trained into soldiers, a squad sent
// to take an outpost far away (decided as a whole), an outpost taken up
// close by standing at its flag, counterattacks, income and saving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewSave, fillDefaults } from '../../src/storage/save.js';
import { World } from '../../src/game/world.js';
import { Construction, buildRadius } from '../../src/game/construction.js';
import { Workforce } from '../../src/game/workforce.js';
import { Campaign } from '../../src/game/campaign.js';
import { outpostFor, territoryKey } from '../../src/game/territory.js';
import { loadData } from './helpers.js';

const data = loadData();

// Monsters get their sprites when they spawn: a canvas that draws nothing will do here.
globalThis.OffscreenCanvas ??= class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }

  getContext() {
    const img = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
    const ctx = { getImageData: (x, y, w, h) => img(w, h), createImageData: (w, h) => img(w, h), measureText: () => ({ width: 0 }) };
    return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  }
};

function stubGame(save) {
  const world = new World(data, save.worldSeed);
  world.harvested = save.world.harvested;
  const toasts = [];
  const game = {
    data, save, world, time: 0, enemies: [], toasts, pstats: { luck: 0, critChance: 0, critDamage: 150 },
    player: { x: 0.5, y: 1.6, r: 0.32, dead: false },
    fx: { emit() {}, text() {}, number() {} },
    audio: { play() {} },
    harvestDamage: new Map(),
    emit() {},
    toast(text) { toasts.push(text); },
    requestSave() {},
    onEnemyKilled() {},
    damageEnemy() {},
    spawnProjectile() { return {}; },
    schedule(_, fn) { fn(); },
    hurtPlayer() {},
    buildRadius() { return buildRadius(data, save); },
  };
  game.construction = new Construction(game);
  game.workforce = new Workforce(game);
  game.campaign = new Campaign(game);
  return game;
}

function campSave() {
  const save = createNewSave({ worldSeed: 99 });
  save.player.level = 30;
  Object.assign(save.resources, { scrap: 9e4, essence: 9e4, wood: 9e4, stone: 9e4, prismite: 99 });
  Object.assign(save.base.buildings, { lodge: 3, training: 2, forge: 5, vault: 1 });
  return save;
}

function run(game, seconds, dt = 0.5) {
  for (let t = 0; t < seconds; t += dt) {
    game.time += dt;
    game.workforce.update(dt);
    game.campaign.update(dt);
  }
}

/** The nearest square around the camp that has an outpost. */
function nearSite(game) {
  for (const [tx, ty] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const s = outpostFor(game.world, data, tx, ty);
    if (s) return s;
  }
  throw new Error('no outpost near the camp');
}

test('recruits train into soldiers; the lodge then has room for new workers', () => {
  const save = campSave();
  const game = stubGame(save);
  const a = game.workforce.hire('wood');
  game.workforce.hire('stone');
  assert.match(game.campaign.trainProblem(a.id, 'archer'), /level 3/);
  game.campaign.train(a.id, 'guard');
  const rec = save.base.workers.find((r) => r.id === a.id);
  assert.equal(rec.trainingTo, 'guard');
  assert.equal(game.workforce.workerCount(), 1, 'a recruit no longer counts as a worker');
  rec.trainUntil = Date.now() - 1;
  run(game, 1.5);
  assert.equal(rec.role, 'guard');
  assert.equal(game.campaign.soldiers().length, 1);
  assert.ok(game.toasts.some((t) => /finished training/.test(t)));
  // Gear makes them tougher.
  const hp = game.campaign.soldiers()[0].maxHp;
  game.campaign.buyGear(a.id);
  run(game, 0.5);
  assert.ok(game.campaign.soldiers()[0].maxHp > hp);
  // Soldiers cost more upkeep than workers.
  const day = game.workforce.perDay();
  assert.ok(day.soldiers.scrap > 0);
});

test('a squad marches to an outpost far from you and takes it in one fight', () => {
  const save = campSave();
  const game = stubGame(save);
  const site = nearSite(game);
  // The player is far away, the other side of the camp.
  Object.assign(game.player, { x: -site.x * 2, y: -site.y * 2 });
  const ids = [game.workforce.hire('wood').id, game.workforce.hire('wood').id, game.workforce.hire('wood').id];
  for (const id of ids) {
    const rec = save.base.workers.find((r) => r.id === id);
    Object.assign(rec, { role: 'infantry', gear: 5, rank: 5, xp: 999 });
  }
  save.base.buildings.training = 3;
  game.workforce.sync();
  const squad = game.campaign.createSquad('Ulvarna');
  for (const id of ids) game.campaign.assign(id, squad.id);
  assert.equal(game.campaign.order(squad.id, 'attack', { key: site.key }), null);
  run(game, 120);
  assert.ok(game.campaign.isOwned(site.key), `taken (${game.toasts.join(' | ')})`);
  assert.equal(game.campaign.army.squads[0].order.kind, 'defend', 'they stay to hold it');
  // The map knows.
  const view = game.campaign.territoriesAround(site.tx, site.ty, 0)[0];
  assert.equal(view.status, 'own');
});

test('up close: beat the guards, stand at the flag, and the outpost is yours; it pays every hour', () => {
  const save = campSave();
  const game = stubGame(save);
  const site = nearSite(game);
  Object.assign(game.player, { x: site.x, y: site.y + 1 });
  run(game, 1);
  assert.ok(game.campaign.active.has(site.key), 'the outpost stands');
  assert.ok(game.campaign.structures.some((st) => st.id === 'outpost_flag'));
  const guards = game.enemies.filter((e) => e.outpost === site.key);
  assert.ok(guards.length >= 3, 'guarded');
  run(game, 5);
  assert.equal(game.campaign.isOwned(site.key), false, 'not while the guards stand');
  for (const e of guards) e.dead = true;
  game.enemies = [];
  run(game, 25);
  assert.ok(game.campaign.isOwned(site.key));
  // Two hours later: income in the Vault.
  const before = save.base.vault.scrap ?? 0;
  save.territories.incomeAt = Date.now() - 2.1 * 3600 * 1000;
  run(game, 1.5);
  assert.ok((save.base.vault.scrap ?? 0) > before);
  // Monsters come for it while you are away, and with no garrison it falls.
  Object.assign(game.player, { x: -site.x * 3, y: -site.y * 3 });
  run(game, 1);
  assert.equal(game.campaign.active.has(site.key), false);
  save.territories.raidT = 0;
  run(game, 0.5);
  assert.equal(game.campaign.isOwned(site.key), false, 'lost');
  assert.ok(game.toasts.some((t) => /lost/.test(t)));
});

test('the army and the territories are saved', () => {
  const save = campSave();
  const game = stubGame(save);
  game.campaign.createSquad('Björnarna');
  save.territories.owned[territoryKey(1, 0)] = { since: 5 };
  const again = fillDefaults(JSON.parse(JSON.stringify(save)));
  assert.equal(again.army.squads[0].name, 'Björnarna');
  assert.deepEqual(again.territories.owned['1,0'], { since: 5 });
  // An old save has none and gets the defaults.
  const old = JSON.parse(JSON.stringify(save));
  delete old.army;
  delete old.territories;
  const up = fillDefaults(old);
  assert.deepEqual(up.army.squads, []);
  assert.deepEqual(up.territories.owned, {});
});

test('factions: their bases are guarded by their troops; beat them and hold the flag to take a base', () => {
  const save = campSave();
  const game = stubGame(save);
  const st = save.factions;
  assert.ok(st.list.length >= 3, 'the world has factions');
  const key = Object.keys(st.owned).find((k) => st.owned[k].tier === 'camp') ?? Object.keys(st.owned)[0];
  const fid = st.owned[key].faction;
  const site = game.campaign.site(key);
  Object.assign(game.player, { x: site.x, y: site.y + 1 });
  run(game, 1);
  const troops = game.enemies.filter((e) => e.outpost === key && e.faction === fid);
  assert.ok(troops.length >= 1, 'its garrison stands');
  assert.equal(game.campaign.structures.find((s) => s.id === 'outpost_flag' && s.outpost === key).color, st.list.find((f) => f.id === fid).color);
  for (const e of troops) e.dead = true;
  game.enemies = [];
  run(game, 25);
  assert.ok(game.campaign.isOwned(key), 'yours now');
  assert.equal(st.owned[key], undefined, 'not theirs');
  const view = game.campaign.factionsView();
  assert.ok(view.list.some((f) => f.id === fid));
});

test('factions: an army comes for your outpost while you are away and takes it', () => {
  const save = campSave();
  const game = stubGame(save);
  const st = save.factions;
  // Your outpost right next to a faction's land, no garrison; you far away.
  const fkey = Object.keys(st.owned)[0];
  const { tx, ty } = { tx: Number(fkey.split(',')[0]), ty: Number(fkey.split(',')[1]) };
  let mine = null;
  for (const [x, y] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]) {
    const k = `${x},${y}`;
    if (!st.owned[k] && k !== '0,0' && game.campaign.site(k)) mine = k;
  }
  assert.ok(mine);
  save.territories.owned[mine] = { since: 1 };
  Object.assign(game.player, { x: -5000, y: -5000 });
  for (const f of st.list) f.bank = 600;
  for (let i = 0; i < 400 && game.campaign.isOwned(mine); i++) run(game, 3, 3);
  assert.equal(game.campaign.isOwned(mine), false, 'lost');
  assert.ok(game.toasts.some((t) => /took your outpost|plundered/.test(t)), game.toasts.slice(-5).join(' | '));
});
