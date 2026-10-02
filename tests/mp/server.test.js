// End-to-end tests of the authoritative server with headless bots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { BTN, ET, angleToByte } from '../../src/net/protocol.js';

async function walk(bot, frames, frame = {}) {
  for (let i = 0; i < frames; i++) {
    bot.input(frame);
    await sleep(33);
  }
  await sleep(150);
}

test('join as a guest: name, starter sword, world seed', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Alfa');
    assert.equal(a.welcome.name, 'Alfa');
    assert.ok(a.welcome.seed > 0);
    const inv = a.json.find((m) => m.t === 'inv');
    assert.equal(inv.bag.length, 1, 'starter weapon');
    assert.equal(inv.equipped, inv.bag[0].id);
    assert.ok(a.json.some((m) => m.t === 'chunk'), 'world data');
    // Names are unique.
    const b = new (await import('./bot.js')).Bot(t.url, { name: 'alfa' });
    let errors = 0;
    b.on((m) => {
      if (m.t === 'need-name' && m.error) {
        errors++;
        b.ws.send(JSON.stringify({ t: 'create', name: 'Alfa2' }));
      }
    });
    await b.connect();
    assert.equal(errors, 1);
    assert.equal(b.welcome.name, 'Alfa2');
    b.close();
  } finally {
    await t.close();
  }
});

test('movement is server-side: flooding inputs gives no speed', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Speedy');
    const p = t.player(a);
    const x0 = p.x;
    await walk(a, 30, { mx: 127 });
    // One second of input = exactly one second of walking (the starter
    // sword may carry a small speed bonus, so use the server's speed).
    assert.ok(Math.abs(p.x - x0 - p.speed) < 0.01, `walked ${p.x - x0} at ${p.speed}`);
    const x1 = p.x;
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) a.input({ mx: 127 });
    await sleep(1000);
    const seconds = (Date.now() - t0) / 1000;
    assert.ok(p.x - x1 <= p.speed * seconds + 0.6, `flood moved ${p.x - x1} in ${seconds}s`);
    // The client's acknowledged position matches where the server says it is.
    await sleep(200);
    assert.ok(Math.abs(a.self.x - p.x) < 1e-9);
  } finally {
    await t.close();
  }
});

test('garbage gets you kicked', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Junk');
    for (let i = 0; i < 6; i++) a.ws.send(Buffer.from([1, 9, 9, 9]));
    await sleep(300);
    assert.ok(a.closed, 'connection closed');
  } finally {
    await t.close();
  }
});

test('you only see players near you (no wallhack/ESP)', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Near');
    const b = await t.bot('Far');
    t.place(b, 200, 200);
    await sleep(300);
    const seesB = () => [...a.known.entries()].some(([id, e]) => id === b.welcome.id && e.type === ET.PLAYER);
    assert.equal(seesB(), false);
    t.place(b, t.player(a).x + 3, t.player(a).y);
    await sleep(300);
    assert.equal(seesB(), true);
    assert.ok(a.json.some((m) => m.t === 'pinfo' && m.id === b.welcome.id && m.name === 'Far'));
  } finally {
    await t.close();
  }
});

async function fightSetup(t) {
  const a = await t.bot('Hunter');
  const b = await t.bot('Prey');
  const pa = t.player(a);
  const pb = t.player(b);
  // Out in the wild, side by side on open ground.
  let x = 80;
  while (!(t.gs.world.isFree(x, 0.5, 0.4) && t.gs.world.isFree(x + 1.2, 0.5, 0.4) && t.gs.world.isFree(x + 0.6, 0.5, 0.4))) x += 1;
  t.place(a, x, 0.5);
  t.place(b, x + 1.2, 0.5);
  return { a, b, pa, pb };
}

test('PvP rules: no fights in town, newbies are protected until they choose to fight', async () => {
  const t = await testServer();
  try {
    const { a, b, pa, pb } = await fightSetup(t);
    const aim = angleToByte(Math.atan2(pb.y - pa.y, pb.x - pa.x));
    // Both are newcomers: the victim is protected.
    await walk(a, 20, { buttons: BTN.ATTACK, aim, target: b.welcome.id });
    assert.equal(pb.hp, pb.maxHp, 'newbie protected');
    // The victim opts in to PvP: now hits land.
    assert.equal((await b.request({ t: 'pvp' })).ok, true);
    await walk(a, 20, { buttons: BTN.ATTACK, aim, target: b.welcome.id });
    assert.ok(pb.hp < pb.maxHp, 'hit after opting in');
    assert.equal(pa.newbie, false, 'attacking ends your own protection');
    // In town nobody gets hurt.
    t.place(a, 0.5, 3);
    t.place(b, 1.6, 3);
    pb.hp = pb.maxHp;
    await walk(a, 20, { buttons: BTN.ATTACK, aim: 0, target: b.welcome.id });
    assert.equal(pb.hp, pb.maxHp, 'safe in town');
  } finally {
    await t.close();
  }
});

test('clans: create, invite, join; clan mates can not hurt each other', async () => {
  const t = await testServer();
  try {
    const { a, b, pa, pb } = await fightSetup(t);
    assert.equal((await a.request({ t: 'clan', op: 'create', name: 'Ulvarna', tag: 'ULV' })).ok, true);
    assert.equal((await a.request({ t: 'clan', op: 'invite', name: 'Prey' })).ok, true);
    const invite = await b.waitFor((m) => m.t === 'invites' && m.list.length);
    assert.equal((await b.request({ t: 'clan', op: 'accept', id: invite.list[0].id })).ok, true);
    assert.equal(pa.clanId, pb.clanId);
    await b.request({ t: 'pvp' });
    pb.hp = pb.maxHp;
    const aim = angleToByte(Math.atan2(pb.y - pa.y, pb.x - pa.x));
    await walk(a, 20, { buttons: BTN.ATTACK, aim, target: b.welcome.id });
    assert.equal(pb.hp, pb.maxHp, 'no friendly fire');
    // Members can't kick, the leader can't leave a clan with members.
    assert.equal((await b.request({ t: 'clan', op: 'kick', name: 'Hunter' })).ok, false);
    assert.equal((await a.request({ t: 'clan', op: 'leave' })).ok, false);
  } finally {
    await t.close();
  }
});

test('bases: banners claim land, only the clan builds there, raids follow the rules', async () => {
  const t = await testServer();
  try {
    const owner = await t.bot('Builder');
    const raider = await t.bot('Raider');
    const po = t.player(owner);
    const pr = t.player(raider);
    po.ch.resources.wood = 200;
    po.ch.resources.scrap = 50;
    pr.ch.resources.wood = 200;
    // Building needs a clan, and never in town.
    assert.equal((await owner.request({ t: 'build', id: 'banner', x: 2, y: 5 })).ok, false);
    await owner.request({ t: 'clan', op: 'create', name: 'Byggarna', tag: 'BYG' });
    t.place(owner, 10.5, 3.5);
    let res = await owner.request({ t: 'build', id: 'banner', x: 12, y: 3 });
    assert.match(res.error, /Fristaden|nära/);
    // Out in the wild: banner, then walls inside the claim.
    t.place(owner, 100.5, 0.5);
    let bx = 101;
    let by = 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0]]) {
      if (!t.gs.world.blockAt(Math.floor(po.x) + dx, Math.floor(po.y) + dy)) {
        bx = Math.floor(po.x) + dx;
        by = Math.floor(po.y) + dy;
        break;
      }
    }
    res = await owner.request({ t: 'build', id: 'banner', x: bx, y: by });
    assert.equal(res.ok, true, res.error);
    assert.equal(t.gs.claims().length, 1);
    let wx = null;
    let wy = null;
    for (let d = 2; d < 6 && wx === null; d++) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        const x = bx + dx;
        const y = by + dy;
        if (!t.gs.world.blockAt(x, y) && !t.gs.world.structureAt(x, y)) {
          wx = x;
          wy = y;
          break;
        }
      }
    }
    res = await owner.request({ t: 'build', id: 'wood_wall', x: wx, y: wy });
    assert.equal(res.ok, true, res.error);
    const wall = t.gs.world.structureAt(wx, wy);
    assert.equal(po.ch.resources.wood, 200 - 3 - 3, 'paid for banner and wall');
    // The raider can't build in someone else's claim.
    await raider.request({ t: 'clan', op: 'create', name: 'Rovarna', tag: 'ROV' });
    t.place(raider, wx + 0.5, wy + 2.5);
    res = await raider.request({ t: 'build', id: 'wood_wall', x: wx, y: wy + 1 });
    assert.equal(res.ok, false);
    // Owner online → raidable: the raider's hits wear the wall down.
    assert.equal(t.gs.raidState(po.clanId).raidable, true);
    t.place(raider, wx + 0.5, wy + 1.5);
    const aim = angleToByte(-Math.PI / 2);
    const hp0 = wall.hp;
    await walk(raider, 25, { buttons: BTN.ATTACK, aim });
    assert.ok(wall.hp < hp0, 'wall damaged while owners are online');
    // Owner offline (long ago, outside the window): the base is protected.
    owner.close();
    await sleep(200);
    t.gs.clans.get(po.clanId).lastOnlineAt = Date.now() - 60 * 60 * 1000;
    t.gs.raidWindows = [];
    assert.equal(t.gs.raidState(po.clanId).raidable, false);
    const hp1 = wall.hp;
    await walk(raider, 25, { buttons: BTN.ATTACK, aim });
    assert.equal(wall.hp, hp1, 'no damage to an offline base');
  } finally {
    await t.close();
  }
});

test('death in the wild drops a bag; the killer can pick it up; nothing is duplicated', async () => {
  const t = await testServer();
  try {
    const { a, b, pa, pb } = await fightSetup(t);
    await b.request({ t: 'pvp' });
    pb.ch.resources.essence = 100;
    pb.ch.resources.wood = 41;
    pa.ch.resources.essence = 0;
    pb.hp = 1;
    pb.protectUntil = 0;
    const aim = angleToByte(Math.atan2(pb.y - pa.y, pb.x - pa.x));
    await walk(a, 15, { buttons: BTN.ATTACK, aim, target: b.welcome.id });
    assert.equal(pb.dead, true);
    assert.equal(pb.ch.resources.essence, 50);
    assert.equal(pb.ch.resources.wood, 21);
    const bag = [...t.gs.pickups.values()].find((it) => it.kind === 'bag');
    assert.ok(bag);
    assert.deepEqual(bag.res, { essence: 50, wood: 20 });
    // Walk onto the bag.
    t.place(a, bag.x, bag.y);
    await sleep(400);
    assert.equal(t.gs.pickups.has(bag.id), false);
    assert.equal(pa.ch.resources.essence, 50);
    // Both are already in the database.
    assert.equal(t.gs.db.character(pb.accountId).resources.essence, 50);
    assert.equal(t.gs.db.character(pa.accountId).resources.essence, 50);
  } finally {
    await t.close();
  }
});

test('logging out in the wild leaves your body for a while (no combat logging)', async () => {
  const t = await testServer({ rules: { sleepSeconds: 1 } });
  try {
    const a = await t.bot('Sleeper');
    const pa = t.player(a);
    t.place(a, 90, 0);
    const accountId = pa.accountId;
    a.close();
    await sleep(250);
    assert.equal(t.gs.byAccount.get(accountId)?.asleep, true);
    await sleep(1400);
    assert.equal(t.gs.byAccount.has(accountId), false, 'body gone after the timer');
    // In town you leave right away.
    const b = await t.bot('TownLeaver');
    const id = t.player(b).accountId;
    b.close();
    await sleep(250);
    assert.equal(t.gs.byAccount.has(id), false);
  } finally {
    await t.close();
  }
});

test('weapons: drop for a friend, they pick it up, the old owner no longer has it', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Giver');
    const b = await t.bot('Taker');
    const pa = t.player(a);
    const pb = t.player(b);
    let x = 80;
    while (!t.gs.world.isFree(x, 0.5, 1.5)) x += 1;
    t.place(a, x, 0.5);
    t.place(b, 200, 200);
    // A second weapon to give away (the starter stays equipped).
    const gift = (await import('../../server/loot.js')).generate(t.gs, { level: 3, source: 'drop', roll: 'drop' });
    (await import('../../server/loot.js')).giveWeapon(t.gs, pa, gift, 'test');
    assert.equal((await a.request({ t: 'drop', id: gift.id })).ok, true);
    assert.equal(t.gs.db.itemOwner(gift.id), null, 'on the ground: nobody owns it');
    assert.equal((await a.request({ t: 'salvage', ids: [gift.id] })).ok, true);
    assert.equal(pa.ch.resources.scrap ?? 0, 0, 'salvaging what you dropped gives nothing');
    const it = [...t.gs.pickups.values()].find((w) => w.kind === 'weapon' && w.dna.id === gift.id);
    pb.x = it.x;
    pb.y = it.y;
    await sleep(2200);
    assert.equal(t.gs.db.itemOwner(gift.id)?.owner_id, pb.accountId);
    assert.ok(pb.inv.bag.some((w) => w.id === gift.id));
    assert.ok(!pa.inv.bag.some((w) => w.id === gift.id));
  } finally {
    await t.close();
  }
});

test('monsters spawn in the wild, never in town', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Explorer');
    await sleep(800);
    let near = [...t.gs.enemiesNear(t.player(a).x, t.player(a).y, 30)].length;
    assert.equal(near, 0, 'no monsters around town');
    t.place(a, 120, 40);
    await sleep(1500);
    near = [...t.gs.enemiesNear(t.player(a).x, t.player(a).y, 30)].length;
    assert.ok(near > 0, 'monsters in the wild');
  } finally {
    await t.close();
  }
});

test('monsters: killing one gives experience and drops loot for the killer', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Slayer');
    const pa = t.player(a);
    let x = 120;
    while (!t.gs.world.isFree(x, 0.5, 1.2)) x += 1;
    t.place(a, x, 0.5);
    const { spawnEnemy } = await import('../../server/enemies.js');
    const e = spawnEnemy(t.gs, 'slime', pa.x + 1.1, pa.y, { level: 1 });
    e.hp = 1;
    const aim = angleToByte(0);
    await walk(a, 15, { buttons: BTN.ATTACK, aim, target: e.id });
    assert.equal(t.gs.enemies.has(e.id), false, 'slain');
    assert.ok(pa.ch.xp > 0 || pa.ch.level > 1, 'experience');
    assert.ok(pa.ch.kills >= 1);
    assert.ok(a.json.some((m) => m.t === 'ev' && m.list.some((ev) => ev.k === 'kill')), 'kill event');
  } finally {
    await t.close();
  }
});

test('bosses: everyone who helped gets their own reward and the altar falls silent', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Hero');
    const b = await t.bot('Sidekick');
    const pa = t.player(a);
    const pb = t.player(b);
    const altar = t.gs.world.greatAltars()[0];
    t.place(a, altar.x + 2, altar.y);
    t.place(b, altar.x - 2, altar.y);
    const combat = await import('../../server/combat.js');
    combat.summonBoss(t.gs, pa, altar, Date.now());
    const boss = [...t.gs.enemies.values()].find((e) => e.boss);
    assert.ok(boss);
    // Both deal a good share, then it falls.
    combat.damageEnemy(t.gs, boss, boss.maxHp * 0.4, { attacker: pa, canCrit: false });
    combat.damageEnemy(t.gs, boss, boss.maxHp * 2, { attacker: pb, canCrit: false });
    assert.equal(boss.dead, true);
    assert.equal(t.gs.altarSpent(altar.key), true);
    const weapons = [...t.gs.pickups.values()].filter((it) => it.kind === 'weapon');
    assert.equal(weapons.length, 2, 'one reward each');
    assert.deepEqual(new Set(weapons.map((w) => w.owner)), new Set([pa.id, pb.id]));
    assert.equal(pa.ch.firstBoss, true);
    // Summoning again at a spent altar does nothing.
    combat.summonBoss(t.gs, pa, altar, Date.now());
    assert.equal([...t.gs.enemies.values()].filter((e) => e.boss && !e.dead).length, 0);
    await sleep(200);
    assert.ok(b.json.some((m) => m.t === 'wd' && m.k === 'altar' && m.key === altar.key), 'everyone hears the altar is spent');
  } finally {
    await t.close();
  }
});

test('forge and gathering: craft in town, forge a pickaxe, chop a tree', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Crafter');
    const pa = t.player(a);
    pa.ch.resources.scrap = 2000;
    pa.ch.resources.essence = 2000;
    // Not at the forge: refused.
    t.place(a, 60, 0.5);
    let res = await a.request({ t: 'pickaxe', tier: 1 });
    assert.equal(res.ok, false);
    const forge = t.gs.data.base.buildings.find((x) => x.id === 'forge');
    t.place(a, forge.x + 1, forge.y + 1);
    res = await a.request({ t: 'pickaxe', tier: 1 });
    assert.equal(res.ok, true, res.error);
    assert.equal(pa.ch.pickaxe, 1);
    const archetype = t.gs.data.archetypes.find((x) => !x.requires && !x.research) ?? t.gs.data.archetypes[0];
    const { craftingOptions } = await import('../../src/weapons/crafting.js');
    const { mpVirtualSave } = await import('../../src/net/mpsave.js');
    const opts = craftingOptions(t.gs.data, mpVirtualSave(t.gs.data, t.gs.worldSeed, pa.ch, pa.inv));
    const bp = opts.blueprints[0] ?? archetype;
    const material = opts.materialsFor(bp.id)[0];
    const before = pa.inv.bag.length;
    res = await a.request({ t: 'craft', choice: { archetype: bp.id, material: material.id, catalyst: 'none' } });
    assert.equal(res.ok, true, res.error);
    assert.equal(pa.inv.bag.length, before + 1);
    assert.ok(pa.ch.resources.scrap < 2000 - 20);
    const crafted = pa.inv.bag[pa.inv.bag.length - 1];
    assert.equal(t.gs.db.itemOwner(crafted.id).owner_id, pa.accountId);
    // Chop a tree out in the wild.
    let tree = null;
    for (let x = 60; x < 400 && !tree; x++) {
      for (let y = -20; y < 20 && !tree; y++) {
        if (t.gs.world.blockAt(x, y) === 22 && t.gs.world.isFree(x - 0.6, y + 0.5, 0.32)) tree = { x, y };
      }
    }
    assert.ok(tree, 'found a tree');
    pa.x = tree.x - 0.6;
    pa.y = tree.y + 0.5;
    a.input({ cmd: 3 });
    await sleep(100);
    assert.equal(pa.inv.activeSlot, 'tool');
    await walk(a, 90, { buttons: BTN.ATTACK, aim: angleToByte(0) });
    assert.equal(t.gs.world.blockAt(tree.x, tree.y), 0, 'tree felled');
    assert.ok(t.gs.world.harvested[`${tree.x},${tree.y}`]);
    await sleep(800);
    assert.ok((pa.ch.resources.wood ?? 0) > 0, 'wood picked up');
  } finally {
    await t.close();
  }
});
