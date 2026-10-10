// Clan workers, fortified walls and the vault's upkeep in multiplayer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { ET } from '../../src/net/protocol.js';
import * as workers from '../../server/workers.js';
import * as building from '../../server/building.js';

test('walls upgrade in place, one by one or all at once, paid from the vault', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Murare');
    const p = t.player(a);
    const { banner, clan } = await t.clanBase(a, {});
    Object.assign(p, { x: banner.x + 0.5, y: banner.y + 2.5 });
    Object.assign(p.ch.resources, { wood: 500, stone: 0, scrap: 0, essence: 0 });
    clan.vault = { stone: 500, scrap: 500, wood: 0 };
    for (let dx = -2; dx <= 2; dx++) {
      const res = await a.request({ t: 'build', id: 'wood_wall', x: banner.x + dx, y: banner.y + 4 });
      assert.equal(res.ok, true, res.error);
    }
    const x = banner.x - 2;
    const y = banner.y + 4;
    let res = await a.request({ t: 'upgrade', x, y });
    assert.equal(res.ok, true, res.error);
    const st = t.gs.world.structureAt(x, y);
    assert.equal(st.id, 'stone_wall');
    assert.equal(st.hp, st.def.hp);
    assert.ok(clan.vault.stone < 500, 'paid from the vault');
    const row = t.gs.db.loadStructures().find((r) => r.sid === st.sid);
    assert.equal(row.id, 'stone_wall', 'saved as stone');
    res = await a.request({ t: 'upgrade', all: 'wood_wall' });
    assert.equal(res.ok, true, res.error);
    for (let dx = -2; dx <= 2; dx++) assert.equal(t.gs.world.structureAt(banner.x + dx, y).id, 'stone_wall');
    // Reinforced walls need a higher level; and nobody else may upgrade your walls.
    p.ch.level = 5;
    res = await a.request({ t: 'upgrade', x, y });
    assert.match(res.error, /nivå/);
    const b = await t.bot('Granne');
    const q = t.place(b, x + 0.5, y + 1.5);
    q.ch.level = 30;
    res = await b.request({ t: 'upgrade', x, y });
    assert.match(res.error, /inte er klans/);
  } finally {
    await t.close();
  }
});

test('workers: hired at the lodge, they chop outside the claim and fill the clan vault', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Förman');
    const p = t.player(a);
    const { clan, banner } = await t.clanBase(a, { lodge: 2 });
    assert.ok(clan.lodge === undefined);
    let res = await a.request({ t: 'base', op: 'hire', role: 'wood' });
    assert.match(res.error ?? '', /fattas/, 'hiring costs scrap and essence');
    clan.vault = { scrap: 5000, essence: 5000 };
    res = await a.request({ t: 'base', op: 'hire', role: 'wood' });
    assert.equal(res.ok, true, res.error);
    res = await a.request({ t: 'base', op: 'hire', role: 'stone' });
    assert.equal(res.ok, true, res.error);
    assert.equal(clan.base.workers.length, 2);
    const mine = [...t.gs.workers.values()].filter((w) => w.clanId === clan.id);
    assert.equal(mine.length, 2);
    // They show up in snapshots for players nearby.
    Object.assign(p, { x: mine[0].x, y: mine[0].y - 1 });
    await sleep(300);
    assert.ok([...a.known.values()].some((k) => k.type === ET.WORKER), 'workers are sent in snapshots');
    // A grove just outside the claim (test worlds are random: some have few trees).
    const { T, CHUNK } = await import('../../src/game/world.js');
    const w = t.gs.world;
    for (let k = 0; k < 24; k++) {
      const x = Math.floor(banner.x + Math.cos(k / 4) * 21);
      const y = Math.floor(banner.y + Math.sin(k / 4) * 21);
      const chunk = w.getChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
      chunk.block[(y - chunk.cy * CHUNK) * CHUNK + (x - chunk.cx * CHUNK)] = T.TREE;
    }
    // Ten minutes of work (stepped here, faster than real time).
    const before = clan.vault.wood ?? 0;
    for (let i = 0; i < 30 * 600 && (clan.vault.wood ?? 0) === before; i++) {
      t.gs.time += 1 / 30;
      workers.update(t.gs, 1 / 30);
    }
    assert.ok((clan.vault.wood ?? 0) > before, 'wood reached the clan vault');
    // Nothing was cut inside the claim.
    for (const key of Object.keys(t.gs.world.harvested)) {
      const [x, y] = key.split(',').map(Number);
      if (Math.hypot(x + 0.5 - (banner.x + 0.5), y + 0.5 - (banner.y + 0.5)) < 9) continue; // (the test cleared a square around the base itself)
      assert.ok(Math.hypot(x + 0.5 - (banner.x + 0.5), y + 0.5 - (banner.y + 0.5)) > t.gs.rules.claimRadius, `cut inside the claim at ${key} (banner ${banner.x},${banner.y})`);
    }
    // The clan panel knows them, their wages and what the lodge allows.
    const { clanPayload } = await import('../../server/clans.js');
    const msg = clanPayload(t.gs, clan);
    assert.equal(msg.workers.length, 2);
    assert.equal(msg.lodge.cap, 3, "lodge level 2 houses three");
    assert.ok(msg.upkeep.perDay.workers.scrap > 0, 'wages are part of the upkeep');
    // Fire one; change the other's job.
    res = await a.request({ t: 'base', op: 'fire', id: clan.base.workers[0].id });
    assert.equal(res.ok, true, res.error);
    res = await a.request({ t: 'base', op: 'role', id: clan.base.workers[0].id, role: 'wood' });
    assert.equal(res.ok, true, res.error);
    assert.equal([...t.gs.workers.values()].filter((w) => w.clanId === clan.id).length, 1);
  } finally {
    await t.close();
  }
});

test('workers: their wages are paid hourly from the vault; unpaid they stop; hurt one and it fights back', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Arbetsgivare');
    const p = t.player(a);
    const { clan } = await t.clanBase(a, { lodge: 1 });
    clan.vault = { scrap: 500, essence: 500, wood: 500, stone: 500 };
    let res = await a.request({ t: 'base', op: 'hire', role: 'stone' });
    assert.equal(res.ok, true, res.error);
    const scrap = clan.vault.scrap;
    for (let h = 0; h < 24; h++) building.upkeep(t.gs);
    assert.ok(clan.vault.scrap < scrap - 5, 'a day of wages came out of the vault');
    assert.equal(clan.unpaid, false);
    clan.vault = {};
    clan.upkeep = {};
    for (let h = 0; h < 30; h++) building.upkeep(t.gs);
    assert.equal(clan.unpaid, true, 'nothing left: unpaid');
    const w = [...t.gs.workers.values()].find((x) => x.clanId === clan.id);
    for (let i = 0; i < 60; i++) workers.update(t.gs, 1 / 30);
    assert.ok(w.state === 'rest' || w.state === 'return', 'unpaid workers stay home');
    // A careless swing: the worker turns on you and hits back.
    Object.assign(p, { x: w.x + 0.6, y: w.y });
    const hp = p.hp;
    assert.equal(workers.hit(t.gs, p, w.x, w.y, 1, 5, () => true), true);
    assert.equal(w.angry, p.id);
    for (let i = 0; i < 90; i++) {
      t.gs.time += 1 / 30;
      workers.update(t.gs, 1 / 30);
    }
    assert.ok(p.hp < hp, 'the angry worker hit back');
    // Killed, it's gone from the roster.
    workers.hit(t.gs, p, w.x, w.y, 1, 99999, () => true);
    assert.equal(clan.base.workers.length, 0);
    assert.equal([...t.gs.workers.values()].filter((x) => x.clanId === clan.id).length, 0);
  } finally {
    await t.close();
  }
});
