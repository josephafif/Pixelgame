// Sailing in multiplayer: boats from the forge, setting sail at a shore,
// sailing (predicted by the client with the same rules), sea creatures
// around sailors, and going ashore again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { BTN, SF, angleToByte } from '../../src/net/protocol.js';
import { T, SAILABLE } from '../../src/game/world.js';

async function walk(bot, frames, frame = {}) {
  for (let i = 0; i < frames; i++) {
    bot.input(frame);
    await sleep(33);
  }
  await sleep(150);
}

/** A walkable tile by the open sea, outside town: { land: {x, y}, dir } (dir points at the sea). */
function findShore(gs) {
  const w = gs.world;
  for (let r = 40; r < 400; r += 2) {
    for (let a = 0; a < 64; a++) {
      const x = Math.floor(Math.cos((a / 64) * Math.PI * 2) * r);
      const y = Math.floor(Math.sin((a / 64) * Math.PI * 2) * r);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (w.blockAt(x, y) || !w.isFree(x + 0.5, y + 0.5, 0.32)) continue;
        // Two tiles of sea that way (room to float).
        if (w.blockAt(x + dx, y + dy) !== T.SEA || !SAILABLE.has(w.blockAt(x + 2 * dx, y + 2 * dy))) continue;
        if (!w.isFree(x + dx + 0.5, y + dy + 0.5, 0.32, 'boat')) continue;
        return { land: { x: x + 0.5, y: y + 0.5 }, dir: { x: dx, y: dy } };
      }
    }
  }
  return null;
}

test('sailing: build a boat at the forge, set sail, meet the sharks, go ashore', async () => {
  const t = await testServer({ worldSeed: 42 }); // a world with open sea within reach
  try {
    const bot = await t.bot('Sjöfararen');
    const p = t.player(bot);
    p.protectUntil = Date.now() + 10 * 60 * 1000;
    // A raft from Fristaden's forge; a real ship needs a better forge (in your base).
    p.ch.resources = { essence: 9999, scrap: 9999, wood: 9999, stone: 9999, gold: 0, shards: 0 };
    const forge = [...t.gs.world.objectsNear(0, 0, 3)].find((o) => o.type === 'building' && o.buildingId === 'forge');
    t.place(bot, forge.x, forge.y + 1);
    let res = await bot.request({ t: 'boat', tier: 1 });
    assert.equal(res.ok, true, res.error);
    res = await bot.request({ t: 'boat', tier: 2 });
    assert.equal(res.ok, false, 'the town forge is too simple for a sloop');
    const { spots } = await t.clanBase(bot, { forge: 3 });
    p.ch.resources = { essence: 9999, scrap: 9999, wood: 9999, stone: 9999, gold: 0, shards: 0 };
    t.nextTo(bot, spots.forge);
    res = await bot.request({ t: 'boat', tier: 2 });
    assert.equal(res.ok, true, res.error);
    assert.equal(p.ch.extra.boat, 2, 'a Sailing Sloop (crosses the open sea)');
    await bot.waitFor((m) => m.t === 'me' && m.boat === 2); // the client hears about it
    // Down at the shore, facing the sea: Use sets sail.
    const shore = findShore(t.gs);
    assert.ok(shore, 'found a shore');
    t.place(bot, shore.land.x, shore.land.y);
    const aim = angleToByte(Math.atan2(shore.dir.y, shore.dir.x));
    await walk(bot, 3, { aim });
    // Use sets sail (pressed again if the first press came before the turn, as a player would).
    for (let i = 0; i < 3 && !p.sailing; i++) {
      bot.input({ buttons: BTN.INTERACT, aim });
      await sleep(300);
      if (!p.sailing) await walk(bot, 2, { aim });
    }
    assert.equal(p.sailing, true, 'sailing');
    assert.ok(SAILABLE.has(t.gs.world.blockAt(Math.floor(p.x), Math.floor(p.y))), 'on the water');
    assert.ok(bot.self.flags & SF.SAILING, 'the snapshot says so');
    // Out to sea: the boat floats only on water, at its own speed.
    const start = { x: p.x, y: p.y };
    const mx = shore.dir.x * 127;
    const my = shore.dir.y * 127;
    await walk(bot, 30, { mx, my, aim });
    assert.ok(Math.hypot(p.x - start.x, p.y - start.y) > 1, 'sailed out');
    assert.ok(SAILABLE.has(t.gs.world.blockAt(Math.floor(p.x), Math.floor(p.y))), 'still on the water');
    // Sea creatures come for sailors.
    p.protectUntil = Date.now() + 10 * 60 * 1000;
    let sharks = 0;
    for (let i = 0; i < 40 && !sharks; i++) {
      await walk(bot, 3, { aim });
      sharks = [...t.gs.enemiesNear(p.x, p.y, 25)].filter((e) => e.def.sea).length;
    }
    assert.ok(sharks > 0, 'sharks around the boat');
    // Back to the shore and ashore.
    t.gs.world.gateFilter = null;
    p.x = shore.land.x + shore.dir.x;
    p.y = shore.land.y + shore.dir.y;
    p.queue.length = 0;
    const back = angleToByte(Math.atan2(-shore.dir.y, -shore.dir.x));
    await walk(bot, 3, { aim: back });
    bot.input({ buttons: BTN.INTERACT, aim: back });
    await sleep(300);
    assert.equal(p.sailing, false, 'ashore');
    assert.ok(!SAILABLE.has(t.gs.world.blockAt(Math.floor(p.x), Math.floor(p.y))), 'on land');
  } finally {
    await t.close();
  }
});

test('sailing: the attack button (which also means Use) hits sea creatures out on the water', async () => {
  const { spawnEnemy } = await import('../../server/enemies.js');
  const { findLanding } = await import('../../src/game/sailing.js');
  const t = await testServer({ worldSeed: 42 });
  try {
    const bot = await t.bot('Hajjägaren');
    const p = t.player(bot);
    p.protectUntil = Date.now() + 10 * 60 * 1000;
    p.ch.extra.boat = 2;
    const shore = findShore(t.gs);
    t.place(bot, shore.land.x, shore.land.y);
    const aim = angleToByte(Math.atan2(shore.dir.y, shore.dir.x));
    await walk(bot, 3, { aim });
    for (let i = 0; i < 3 && !p.sailing; i++) {
      bot.input({ buttons: BTN.INTERACT, aim });
      await sleep(300);
      if (!p.sailing) await walk(bot, 2, { aim });
    }
    assert.equal(p.sailing, true, 'sailing');
    // Out where no land is in reach (Use has nowhere to take you ashore).
    const w = t.gs.world;
    let open = null;
    for (let d = 3; d < 60 && !open; d++) {
      const x = p.x + shore.dir.x * d;
      const y = p.y + shore.dir.y * d;
      let sea = true;
      for (let dy = -3; dy <= 3 && sea; dy++) for (let dx = -3; dx <= 3 && sea; dx++) sea = SAILABLE.has(w.blockAt(Math.floor(x) + dx, Math.floor(y) + dy));
      if (sea) open = { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 };
    }
    assert.ok(open, 'open water');
    Object.assign(p, open);
    p.queue.length = 0;
    await walk(bot, 2, { aim }); // (Use let go of)
    assert.equal(findLanding({ world: w, player: p }), null);
    const shark = spawnEnemy(t.gs, 'shark', p.x + 1.6, p.y, { level: 1 });
    const hp = shark.hp;
    // A press: Use and attack together on the first frame, then attack held.
    for (let i = 0; i < 20; i++) {
      const at = angleToByte(Math.atan2(shark.y - p.y, shark.x - p.x));
      bot.input({ buttons: BTN.ATTACK | (i === 0 ? BTN.INTERACT : 0), aim: at, target: shark.id });
      await sleep(33);
    }
    await sleep(200);
    assert.ok(shark.dead || shark.hp < hp, `the shark was hit (${shark.hp}/${hp})`);
    assert.equal(p.sailing, true, 'still in the boat');
  } finally {
    await t.close();
  }
});
