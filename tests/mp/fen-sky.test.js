// Mireglass Fen and Skyreach in multiplayer: Gale Step on the server (only
// once learnt, with a cooldown, out of reach for a moment), the clan's Wind
// Beacon, the fen's bog and the Healing Garden's Lumen Tonic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, clearArea, sleep } from './helpers.js';
import { BTN, angleToByte } from '../../src/net/protocol.js';
import { T, CHUNK } from '../../src/game/world.js';
import { DASH_DIST } from '../../src/net/movement.js';
import { GALE_STEP } from '../../src/game/skills.js';
import { TONIC } from '../../src/game/base.js';

function setGround(world, x, y, id) {
  const chunk = world.getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
  chunk.ground[(y - chunk.cy * CHUNK) * CHUNK + (x - chunk.cx * CHUNK)] = id;
}

/** Sends `n` frames, one per tick. */
async function frames(bot, n, frame = {}) {
  for (let i = 0; i < n; i++) {
    bot.input(frame);
    await sleep(34);
  }
}

test('Gale Step: only once learnt, a quick dash on the server, then a cooldown', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    t.gs.config.maxEnemies = 0;
    const bot = await t.bot('Vindlöparen');
    const p = t.player(bot);
    const at = clearArea(t.gs, 150, 30, 7);
    t.place(bot, at.x - 4.5, at.y + 0.5);
    await sleep(80);
    // Not learnt: nothing happens.
    let x0 = p.x;
    bot.input({ buttons: BTN.DASH, aim: angleToByte(0) });
    await sleep(120);
    assert.ok(Math.abs(p.x - x0) < 0.01, 'no Gale Step without the feather');
    // Learnt: a dash east of DASH_DIST, out of reach for a moment.
    p.ch.extra.components = { ...p.ch.extra.components, gale_feather: { researched: true } };
    x0 = p.x;
    bot.input({ buttons: BTN.DASH, aim: angleToByte(0) });
    await sleep(120);
    assert.ok(Math.abs(p.x - x0 - DASH_DIST) < 0.01, `dashed ${p.x - x0}`);
    assert.ok(p.invulnUntil > Date.now() - 200, 'out of reach while dashing');
    // Straight away again: still recharging.
    x0 = p.x;
    bot.input({ buttons: BTN.DASH, aim: angleToByte(Math.PI) });
    await sleep(120);
    assert.ok(Math.abs(p.x - x0) < 0.01, 'on cooldown');
    // After the cooldown it works again.
    p.dashReadyAt = t.gs.time;
    bot.input({ buttons: BTN.DASH, aim: angleToByte(Math.PI) });
    await sleep(120);
    assert.ok(Math.abs(x0 - p.x - DASH_DIST) < 0.01, 'dashed back west');
  } finally {
    await t.close();
  }
});

test('the clan\'s Wind Beacon: quicker members and a shorter Gale Step cooldown, until it falls', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    const bot = await t.bot('Fyrvaktaren');
    const p = t.player(bot);
    const { banner } = await t.clanBase(bot, {});
    Object.assign(p.ch.resources, { stone: 500, scrap: 500, aether: 100 });
    const speed = p.speed;
    let res = await bot.request({ t: 'build', id: 'wind_beacon', x: banner.x + 3, y: banner.y + 1 });
    assert.equal(res.ok, false, 'needs its blueprint');
    p.ch.extra.components = { ...p.ch.extra.components, bp_wind_beacon: { researched: true } };
    res = await bot.request({ t: 'build', id: 'wind_beacon', x: banner.x + 3, y: banner.y + 1 });
    assert.equal(res.ok, true, res.error);
    const def = t.gs.data.building.structures.find((s) => s.id === 'wind_beacon');
    assert.ok(p.speed > speed * (1 + (def.beacon.moveSpeedPct - 1) / 100), `quicker (${speed} → ${p.speed})`);
    await sleep(150);
    const me = bot.json.filter((m) => m.t === 'me').at(-1);
    assert.ok(me.dashCd < GALE_STEP.cooldown, 'the client hears the shorter cooldown');
    // It falls: back to normal.
    const building = await import('../../server/building.js');
    building.destroyStructure(t.gs, t.gs.world.structureAt(banner.x + 3, banner.y + 1), null);
    assert.ok(Math.abs(p.speed - speed) < 1e-9);
  } finally {
    await t.close();
  }
});

test('the fen\'s bog sickens you, unless the Healing Garden or a Lumen Tonic wards you', async () => {
  const t = await testServer({ worldSeed: 7 });
  try {
    t.gs.config.maxEnemies = 0;
    const bot = await t.bot('Myrvandraren');
    const p = t.player(bot);
    const at = clearArea(t.gs, 170, -40, 4);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setGround(t.gs.world, at.x + dx, at.y + dy, T.BOG);
    t.place(bot, at.x + 0.5, at.y + 0.5);
    p.protectUntil = 0;
    await frames(bot, 70);
    assert.ok(p.statuses.poison?.until > t.gs.time, 'poisoned by the bog');
    // A Lumen Tonic from the clan's garden.
    delete p.statuses.poison;
    const { clan } = await t.clanBase(bot, {});
    let res = await bot.request({ t: 'base', op: 'tonic' });
    assert.equal(res.ok, false, 'no garden, no tonic');
    clan.base.buildings.garden = 1;
    const base = await import('../../server/base.js');
    base.changed(t.gs, clan);
    // (The garden only counts when it stands: give the level directly.)
    p.gardenLevel = 1;
    p.ch.resources.spores = TONIC.cost.spores;
    res = await bot.request({ t: 'base', op: 'tonic' });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.resources.spores, 0, 'paid with spores');
    assert.ok(p.tonicUntil > t.gs.time);
    t.place(bot, at.x + 0.5, at.y + 0.5);
    await frames(bot, 70);
    assert.ok(!(p.statuses.poison?.until > t.gs.time), 'the tonic wards you');
  } finally {
    await t.close();
  }
});
