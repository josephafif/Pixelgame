// Prism Barrens in multiplayer: mirror crystals send shots off at an angle
// (and turn monsters' shots on monsters), shots bounce on (Ricochet,
// Prism Split), the Mirror Knight throws shots back, shardlings burst, a
// Prism Relay boosts its clan's turret, and old worlds keep their bases'
// land.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, clearArea } from './helpers.js';
import { T, CHUNK } from '../../src/game/world.js';
import { spawnProjectile, updateProjectiles, killEnemy } from '../../server/combat.js';
import { spawnEnemy } from '../../server/enemies.js';

/** Sets a tile's block directly (tests only). */
function setBlock(world, x, y, id) {
  const chunk = world.getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
  chunk.block[(y - chunk.cy * CHUNK) * CHUNK + (x - chunk.cx * CHUNK)] = id;
}

function step(gs, seconds) {
  for (let t = 0; t < seconds; t += 1 / 30) updateProjectiles(gs, 1 / 30, Date.now());
}

test('mirror crystals bounce shots back the way they came, and a monster\'s shot turns on monsters', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    const at = clearArea(gs, 160, 40, 6);
    setBlock(gs.world, at.x + 4, at.y, T.MIRROR);
    // A shot flying east into the mirror comes back west.
    const pr = spawnProjectile(gs, { x: at.x + 0.5, y: at.y + 0.6, angle: 0, speed: 10, damage: 10, range: 12, owner: 1 });
    step(gs, 0.6);
    assert.equal(pr.reflections, 1, 'reflected once');
    assert.ok(pr.vx < 0, 'now flying west');
    assert.ok(pr.damage > 10, 'a little stronger');
    // A monster's shot comes back as one that hurts monsters.
    const slime = spawnEnemy(gs, 'slime', at.x - 2.5, at.y + 0.6, { level: 1 });
    const hp = slime.hp;
    const shot = spawnProjectile(gs, { x: at.x + 1.5, y: at.y + 0.6, angle: 0, speed: 10, damage: 8, range: 14, enemy: 999 });
    step(gs, 1.2);
    assert.equal(shot.turned, true);
    assert.ok(slime.hp < hp || slime.dead, 'the turned shot hit the slime');
  } finally {
    await t.close();
  }
});

test('shots bounce on to the next monster, the Mirror Knight throws them back, shardlings burst', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    const at = clearArea(gs, 200, -40, 6);
    const a = spawnEnemy(gs, 'golem', at.x + 3, at.y + 0.5, { level: 1 });
    const b = spawnEnemy(gs, 'golem', at.x + 3, at.y + 3.5, { level: 1 });
    const ha = a.hp;
    const hb = b.hp;
    const pr = spawnProjectile(gs, { x: at.x + 0.5, y: at.y + 0.5, angle: 0, speed: 10, damage: 5, range: 10, owner: 1, bounces: 1 });
    step(gs, 1.2);
    assert.ok(a.hp < ha && b.hp < hb, 'both golems hit');
    assert.equal(pr.bounces, 0);
    for (const e of [a, b]) gs.enemies.delete(e.id);
    // The knight is always an elite, and with a sure shield every shot comes back.
    const knight = spawnEnemy(gs, 'mirror_knight', at.x + 3, at.y + 0.5, { level: 1 });
    assert.equal(knight.elite, true);
    knight.def = { ...knight.def, reflect: 1 };
    const kh = knight.hp;
    const shot = spawnProjectile(gs, { x: at.x + 0.5, y: at.y + 0.5, angle: 0, speed: 10, damage: 5, range: 10, owner: 1 });
    step(gs, 0.4);
    assert.equal(knight.hp, kh, 'the shield took it');
    assert.ok(shot.vx < 0 && shot.enemy === knight.id, 'it flies back as the knight\'s shot');
    gs.enemies.delete(knight.id);
    // A shardling bursts into shards.
    const before = gs.projectiles.size;
    const sh = spawnEnemy(gs, 'shardling', at.x + 2, at.y, { level: 1 });
    killEnemy(gs, sh, null);
    assert.equal(gs.projectiles.size - before, sh.def.deathBurst.count);
  } finally {
    await t.close();
  }
});

test('a Prism Relay makes its clan\'s turret fire three shots', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    const gs = t.gs;
    const bot = await t.bot('Reläbyggaren');
    const p = t.player(bot);
    p.ch.level = 30;
    p.ch.resources = { wood: 9999, stone: 9999, scrap: 9999, essence: 9999, prismite: 200, gold: 0, shards: 0 };
    await bot.request({ t: 'clan', op: 'create', name: 'Prisma', tag: 'PRS' });
    const at = clearArea(gs, 120, 80, 7);
    t.place(bot, at.x + 0.5, at.y + 2.5);
    let res = await bot.request({ t: 'build', id: 'banner', x: at.x, y: at.y });
    assert.equal(res.ok, true, res.error);
    res = await bot.request({ t: 'build', id: 'arrow_turret', x: at.x + 2, y: at.y + 2 });
    assert.equal(res.ok, true, res.error);
    // The relay needs its blueprint.
    res = await bot.request({ t: 'build', id: 'prism_relay', x: at.x + 3, y: at.y + 2 });
    assert.equal(res.ok, false, 'no blueprint, no relay');
    p.ch.extra.components = { ...p.ch.extra.components, bp_prism_relay: { researched: true } };
    res = await bot.request({ t: 'build', id: 'prism_relay', x: at.x + 3, y: at.y + 2 });
    assert.equal(res.ok, true, res.error);
    // A monster in range: one volley, three shots.
    gs.config.maxEnemies = 0;
    for (const e of gs.enemies.values()) e.dead = true;
    spawnEnemy(gs, 'slime', at.x + 2.5, at.y + 6.5, { level: 1 });
    const turret = gs.world.structureAt(at.x + 2, at.y + 2);
    turret.rt.cd = 0;
    turret.rt.aim = Math.PI / 2;
    const before = [...gs.projectiles.values()].filter((x) => x.turret === turret.sid).length;
    const building = await import('../../server/building.js');
    for (let i = 0; i < 10; i++) building.update?.(gs, 1 / 30, Date.now());
    const shots = [...gs.projectiles.values()].filter((x) => x.turret === turret.sid).length - before;
    assert.equal(shots, 3);
  } finally {
    await t.close();
  }
});
