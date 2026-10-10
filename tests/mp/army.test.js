// The army in multiplayer: workers trained into soldiers at the clan's
// Training Grounds, squads with orders, outposts taken by standing at the
// flag or by a squad far away, and territories saved and sent to everyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { outpostFor } from '../../src/game/territory.js';
import * as army from '../../server/army.js';
import * as workers from '../../server/workers.js';

/** A squad's soldiers, made strong (tests only). */
function harden(clan) {
  for (const r of clan.base.workers) Object.assign(r, { gear: 5, rank: 5, xp: 999 });
}

function nearestSite(gs, x, y) {
  for (const [tx, ty] of [[1, 0], [1, 1], [1, -1], [2, 0], [0, 1], [0, -1]]) {
    const s = outpostFor(gs.world, gs.data, tx, ty);
    if (s) return s;
  }
  throw new Error('no outpost');
}

async function armyClan(t, name, tag) {
  const bot = await t.bot(name);
  const p = t.player(bot);
  const { clan } = await t.clanBase(bot, { lodge: 3, training: 3, forge: 3 }, { name: `${name}s`, tag, near: [130, 40] });
  Object.assign(p.ch.resources, { scrap: 99999, essence: 99999, wood: 9999, stone: 9999 });
  clan.vault = { scrap: 99999, essence: 99999, wood: 9999, stone: 9999 };
  for (let i = 0; i < 3; i++) {
    const res = await bot.request({ t: 'base', op: 'hire', role: 'wood' });
    assert.equal(res.ok, true, res.error);
  }
  return { bot, p, clan };
}

test('workers train into soldiers at the clan\'s Training Grounds; squads take orders', async () => {
  const t = await testServer({ worldSeed: 7, outposts: true });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    const { bot, clan } = await armyClan(t, 'Kaptenen', 'KAP');
    const ids = clan.base.workers.map((r) => r.id);
    let res = await bot.request({ t: 'army', op: 'train', id: ids[0], role: 'archer' });
    assert.equal(res.ok, true, res.error);
    res = await bot.request({ t: 'army', op: 'train', id: ids[1], role: 'rider' });
    assert.equal(res.ok, false, 'riders need the Training Grounds at level 4');
    assert.match(res.error, /nivå 4/);
    res = await bot.request({ t: 'army', op: 'train', id: ids[1], role: 'guard' });
    assert.equal(res.ok, true, res.error);
    const rec = clan.base.workers.find((r) => r.id === ids[0]);
    assert.equal(rec.trainingTo, 'archer');
    for (const r of clan.base.workers) if (r.trainingTo) r.trainUntil = Date.now() - 1;
    await sleep(1300);
    assert.equal(rec.role, 'archer');
    // The soldiers go out on the wire with their role.
    await sleep(200);
    const live = [...gs.workers.values()].filter((w) => w.clanId === clan.id && w.role === 'archer');
    assert.equal(live.length, 1);
    // The lodge has room again: soldiers live in the barracks.
    assert.equal(clan.base.workers.filter((r) => r.role === 'wood').length, 1);
    res = await bot.request({ t: 'base', op: 'hire', role: 'stone' });
    assert.equal(res.ok, true, res.error);
    // A squad, two soldiers in it, an order.
    res = await bot.request({ t: 'army', op: 'squad-create', name: 'Vargarna' });
    assert.equal(res.ok, true, res.error);
    const squad = clan.base.army.squads[0];
    for (const id of ids.slice(0, 2)) {
      res = await bot.request({ t: 'army', op: 'assign', soldier: id, squad: squad.id });
      assert.equal(res.ok, true, res.error);
    }
    res = await bot.request({ t: 'army', op: 'order', squad: squad.id, kind: 'defend', key: '1,0' });
    assert.equal(res.ok, false, 'not yours to defend');
    res = await bot.request({ t: 'army', op: 'order', squad: squad.id, kind: 'follow' });
    assert.equal(res.ok, true, res.error);
    assert.equal(squad.order.kind, 'follow');
    const msg = bot.json.filter((m) => m.t === 'clan').at(-1);
    assert.equal(msg.army.squads[0].name, 'Vargarna');
    assert.equal(msg.army.barracks.used, 2);
    await sleep(1200);
    assert.ok(bot.json.some((m) => m.t === 'squads' && m.list[0].n === 2), 'the clan hears where its squads are');
  } finally {
    await t.close();
  }
});

test('a squad far from everyone takes an outpost in one fight; everyone hears who holds it, and it is saved', async () => {
  const t = await testServer({ worldSeed: 7, outposts: true });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    const { bot, p, clan } = await armyClan(t, 'Fältherren', 'FLT');
    const ids = clan.base.workers.map((r) => r.id);
    for (const id of ids) Object.assign(clan.base.workers.find((r) => r.id === id), { role: 'infantry' });
    harden(clan);
    workers.sync(gs, clan);
    let res = await bot.request({ t: 'army', op: 'squad-create', name: 'Stormarna' });
    const squad = clan.base.army.squads[0];
    for (const id of ids) res = await bot.request({ t: 'army', op: 'assign', soldier: id, squad: squad.id });
    assert.equal(res.ok, true, res.error);
    const site = nearestSite(gs);
    // Everyone is far away; the soldiers are almost there.
    t.place(bot, -900, 300);
    for (const w of gs.workers.values()) if (w.clanId === clan.id) Object.assign(w, { x: site.x + 8, y: site.y + 8 });
    res = await bot.request({ t: 'army', op: 'order', squad: squad.id, kind: 'attack', key: site.key });
    assert.equal(res.ok, true, res.error);
    for (let i = 0; i < 60 && !army.ownedBy(gs, clan.id).includes(site.key); i++) await sleep(250);
    assert.ok(army.ownedBy(gs, clan.id).includes(site.key), 'taken');
    assert.equal(squad.order.kind, 'defend');
    await sleep(1200);
    const terr = bot.json.filter((m) => m.t === 'terr').at(-1);
    assert.ok(terr.list.some((e) => e.key === site.key && e.owner === clan.id && e.tag === 'FLT'));
    // Saved: a fresh territory state reads it back.
    army.update(gs, 25);
    gs.terr = null;
    assert.ok(army.ownedBy(gs, clan.id).includes(site.key));
    assert.ok(p);
  } finally {
    await t.close();
  }
});

test('up close: beat the guards and stand at the flag; a lone player without a clan takes nothing', async () => {
  const t = await testServer({ worldSeed: 7, outposts: true });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    gs.data.army.territory.captureSeconds = 2;
    const loner = await t.bot('Ensamvargen');
    const { bot, clan } = await armyClan(t, 'Flaggbäraren', 'FLG');
    const site = nearestSite(gs);
    t.place(loner, site.x, site.y + 1);
    t.place(bot, site.x + 30, site.y + 30);
    await sleep(800);
    const guards = [...gs.enemies.values()].filter((e) => e.outpost === site.key);
    assert.ok(guards.length >= 3, 'its guards stand');
    for (const e of guards) e.dead = true;
    await sleep(3000);
    assert.equal(army.ownedBy(gs, clan.id).length, 0);
    assert.equal(gs.terr.map.get(site.key)?.owner ?? null, null, 'no clan, no territory');
    t.place(bot, site.x + 1, site.y + 1);
    for (let i = 0; i < 20 && !army.ownedBy(gs, clan.id).includes(site.key); i++) await sleep(250);
    assert.ok(army.ownedBy(gs, clan.id).includes(site.key));
  } finally {
    await t.close();
  }
});
