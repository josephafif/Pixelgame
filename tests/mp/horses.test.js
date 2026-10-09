// Horses in multiplayer: wild herds near players, taming by riding, faster
// and tougher on horseback (predicted with the same numbers), jumping trees,
// and horses that stay on your clan's land (and wander off anywhere else).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { BTN, SF, ET, fieldsOf } from '../../src/net/protocol.js';
import { T, CHUNK } from '../../src/game/world.js';
import { herdsNear, STRAY_SECONDS, BREEDS } from '../../src/game/horses.js';
import * as horses from '../../server/horses.js';
import { killPlayer } from '../../server/combat.js';

async function walk(bot, frames, frame = {}) {
  for (let i = 0; i < frames; i++) {
    bot.input(frame);
    await sleep(33);
  }
  await sleep(150);
}

async function press(bot, p, done) {
  for (let i = 0; i < 4 && !done(); i++) {
    bot.input({ buttons: BTN.INTERACT });
    await sleep(250);
    bot.input({});
    await sleep(100);
  }
}

function setBlock(world, x, y, b) {
  const chunk = world.getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
  chunk.block[(y - chunk.cy * CHUNK) * CHUNK + (x - chunk.cx * CHUNK)] = b;
}

test('horses: tame a wild one, ride it over a tree, keep it on your land', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Ryttaren');
    const b = await t.bot('Grannen');
    const p = t.player(a);
    const pb = t.player(b);
    for (const x of [p, pb]) x.protectUntil = Date.now() + 10 * 60 * 1000;
    const herd = herdsNear(t.gs.world, 0, 0, 800).sort((h1, h2) => Math.hypot(h1.x, h1.y) - Math.hypot(h2.x, h2.y))[0];
    assert.ok(herd, 'a herd somewhere');
    t.place(a, herd.x + 3, herd.y);
    t.place(b, herd.x + 5, herd.y + 2);
    await sleep(900);
    const wild = [...t.gs.horses.values()].filter((h) => h.wild && h.herd.key === herd.key);
    assert.equal(wild.length, herd.size, 'the herd comes to life near players');
    assert.ok([...a.known.values()].some((k) => k.type === ET.HORSE), 'horses are sent in snapshots');
    // Walk up and press Use: it is yours, and you ride it.
    const h = wild[0];
    const stats = { speed: h.speed, hp: h.hp, name: h.name, breed: h.breed };
    const hp0 = p.maxHp;
    Object.assign(p, { x: h.x + 0.6, y: h.y });
    h.wanderT = 99;
    h.tx = h.x;
    h.ty = h.y;
    await press(a, p, () => horses.ridingOf(p));
    const rec = horses.ridingOf(p);
    assert.ok(rec, 'riding');
    assert.equal(rec.name, stats.name);
    assert.equal(p.maxHp, hp0 + stats.hp, 'tougher on horseback');
    await sleep(150);
    assert.ok(a.self.flags & SF.RIDING, 'the snapshot says so');
    assert.equal(a.self.speed, stats.speed, 'the client predicts with the horse\'s speed');
    assert.ok(!t.gs.horses.has(h.eid), 'gone from the herd');
    // Others see the rider's breed.
    await sleep(200);
    const seen = [...b.known.entries()].find(([id, k]) => id === p.id && k.type === ET.PLAYER);
    assert.equal(BREEDS[fieldsOf(ET.PLAYER, seen[1].values).horse - 1].id, stats.breed);
    // Over a tree in the way.
    const w = t.gs.world;
    const y = Math.floor(p.y);
    const x0 = Math.floor(p.x);
    for (let i = -1; i < 6; i++) setBlock(w, x0 + i, y, 0);
    setBlock(w, x0 + 2, y, T.TREE);
    Object.assign(p, { x: x0 + 0.5, y: y + 0.5 });
    p.queue.length = 0;
    await walk(a, 25, { mx: 127 });
    assert.ok(p.x > x0 + 3, `jumped the tree (${p.x.toFixed(2)})`);
    // Off out in the wild: it waits there (with its saddle on), and only you can ride it.
    await press(a, p, () => !horses.ridingOf(p));
    assert.equal(horses.ridingOf(p), null);
    assert.equal(p.maxHp, hp0);
    assert.equal(rec.stabled, false);
    const mine = [...t.gs.horses.values()].find((x) => x.own && x.rec === rec);
    assert.ok(mine, 'standing in the world');
    assert.equal(horses.near(t.gs, pb)?.h === mine, false, 'not for others');
    // Away for long: it runs off.
    rec.leftAt = Date.now() - (STRAY_SECONDS + 5) * 1000;
    t.place(a, rec.x + 200, rec.y);
    await sleep(800);
    assert.equal(horses.horsesOf(p).owned.length, 0, 'ran off');
    await a.waitFor((m) => m.t === 'toast' && /sprang iväg/.test(m.text));
  } finally {
    await t.close();
  }
});

test('horses: one left on your clan\'s land stays; fall off when you die; let one go', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Stallägaren');
    const p = t.player(a);
    p.protectUntil = Date.now() + 10 * 60 * 1000;
    const { banner } = await t.clanBase(a, {});
    const st = horses.horsesOf(p);
    st.owned.push({ id: st.nextId++, breed: 'fjord', speed: 6.6, gallop: 1.3, hp: 30, name: 'Freja', x: p.x, y: p.y, stabled: false });
    st.owned.push({ id: st.nextId++, breed: 'pony', speed: 6, gallop: 1.25, hp: 10, name: 'Molly', x: p.x, y: p.y, stabled: false });
    await sleep(700);
    const freja = [...t.gs.horses.values()].find((x) => x.own && x.rec.name === 'Freja');
    Object.assign(p, { x: freja.x + 0.5, y: freja.y });
    assert.equal(horses.mount(t.gs, p, freja), true);
    // Off on your land: it stays, however long you are away.
    Object.assign(p, { x: banner.x + 3.5, y: banner.y + 3.5 });
    horses.dismount(t.gs, p);
    const rec = st.owned.find((x) => x.name === 'Freja');
    assert.equal(rec.stabled, true);
    rec.leftAt = 0;
    t.place(a, banner.x + 300, banner.y);
    await sleep(700);
    assert.ok(st.owned.includes(rec), 'still at home');
    // Riding when you die: you fall off.
    const molly = [...t.gs.horses.values()].find((x) => x.own && x.rec.name === 'Molly');
    Object.assign(p, { x: molly.x + 0.5, y: molly.y });
    horses.mount(t.gs, p, molly);
    assert.ok(horses.ridingOf(p));
    killPlayer(t.gs, p, null);
    assert.equal(horses.ridingOf(p), null, 'fell off');
    // Let one go.
    const res = await a.request({ t: 'horse', op: 'release', id: rec.id });
    assert.equal(res.ok, true, res.error);
    assert.ok(!st.owned.includes(rec));
    assert.ok(![...t.gs.horses.values()].some((x) => x.rec === rec), 'gone from the world');
  } finally {
    await t.close();
  }
});

test('horses: back on horseback after logging in again, and strays gone while you were away', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Återkomsten');
    const p = t.player(a);
    const st = horses.horsesOf(p);
    st.owned.push({ id: 1, breed: 'courser', speed: 7.8, gallop: 1.4, hp: 5, name: 'Storm', x: p.x, y: p.y, stabled: false });
    st.owned.push({ id: 2, breed: 'pony', speed: 6, gallop: 1.25, hp: 10, name: 'Bamse', x: p.x, y: p.y, stabled: false, leftAt: Date.now() - (STRAY_SECONDS + 60) * 1000 });
    st.nextId = 3;
    st.riding = 1;
    const { players } = await import('../../server/players.js').then((m) => ({ players: m }));
    players.persist(t.gs, p);
    // Log in again (a fresh body from the database).
    t.gs.removePlayer({ ...p, conn: null });
    t.gs.players.delete(p.id);
    t.gs.byAccount.delete(p.accountId);
    const again = t.gs.join({ id: p.accountId, name: p.name }, null);
    assert.equal(horses.ridingOf(again)?.name, 'Storm', 'still riding');
    assert.equal(again.maxHp, again.stats.maxHp);
    assert.ok(again.buffs.some((x) => x.source === 'horse'), 'its health with you');
    assert.deepEqual(horses.horsesOf(again).owned.map((x) => x.name), ['Storm'], 'Bamse wandered off');
  } finally {
    await t.close();
  }
});
