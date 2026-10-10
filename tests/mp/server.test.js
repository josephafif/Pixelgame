// End-to-end tests of the authoritative server with headless bots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { BTN, ET, angleToByte } from '../../src/net/protocol.js';

/** An x out in the wild (on the y = 0.5 line) with no market nearby (nobody builds at markets). */
function wildX(gs, from = 100) {
  let x = from;
  while (gs.world.marketAt(x, 0.5, 20)) x += 25;
  return x;
}

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

test('a new player may take their time picking a name (the login timeout only covers the login)', async () => {
  const t = await testServer({ authTimeoutMs: 300 });
  try {
    const slow = await t.bot('Funderaren', { nameDelay: 1000, password: 'hemligt1' });
    assert.equal(slow.welcome.name, 'Funderaren');
    assert.ok(!slow.kicked, slow.kicked);
    // A connection that never logs in is still closed.
    const { Bot } = await import('./bot.js');
    const idle = new Bot(t.url, { token: 'guest' });
    idle.connect = function connectSilently() {
      return new Promise((resolve) => {
        import('ws').then(({ default: WebSocket }) => {
          const ws = new WebSocket(t.url);
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.t === 'kick') idle.kicked = msg.reason;
          });
          ws.on('close', () => resolve());
        });
      });
    };
    await idle.connect();
    assert.match(idle.kicked ?? '', /för lång tid/);
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
    // Clanmates see each other wherever they are (the map and the edge arrows).
    const far = t.place(b, 300.5, -200.5);
    const mates = await a.waitFor((m) => m.t === 'mates' && m.list.some((x) => x.n === 'Prey' && Math.hypot(x.x - far.x, x.y - far.y) < 1), 8000);
    assert.equal(mates.list.length, 1, 'only the others');
    // Leaving the clan clears them.
    assert.equal((await b.request({ t: 'clan', op: 'leave' })).ok, true);
    await b.waitFor((m) => m.t === 'mates' && m.list.length === 0);
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
    t.place(owner, wildX(t.gs) + 0.5, 0.5);
    let bx = Math.floor(t.player(owner).x) + 1;
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
    const cost = (id) => t.gs.data.building.structures.find((d) => d.id === id).cost.wood;
    assert.equal(po.ch.resources.wood, 200 - cost('banner') - cost('wood_wall'), 'paid for banner and wall');
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

/** A free tile (no block, no structure) near (x, y), not in `taken`. */
function freeTile(gs, x, y, taken = []) {
  for (let d = 1; d < 8; d++) {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) {
        const tx = Math.floor(x) + dx;
        const ty = Math.floor(y) + dy;
        if (gs.world.blockAt(tx, ty) || gs.world.structureAt(tx, ty)) continue;
        if (taken.some(([a, b]) => a === tx && b === ty)) continue;
        if ((tx + 0.5 - x) ** 2 + (ty + 0.5 - y) ** 2 < 1) continue; // not where the builder stands
        return [tx, ty];
      }
    }
  }
  return null;
}

test('turrets shoot monsters, over the clan walls next to them', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Tornbyggare');
    const p = t.player(a);
    p.ch.level = 40;
    p.ch.resources = { wood: 500, stone: 500, scrap: 500, essence: 500 };
    await a.request({ t: 'clan', op: 'create', name: 'Tornen', tag: 'TRN' });
    let x = wildX(t.gs);
    while (!t.gs.world.isFree(x, 0.5, 1.2)) x += 1;
    t.place(a, x, 0.5);
    const banner = freeTile(t.gs, p.x, p.y);
    let res = await a.request({ t: 'build', id: 'banner', x: banner[0], y: banner[1] });
    assert.equal(res.ok, true, res.error);
    const turret = freeTile(t.gs, p.x, p.y, [banner]);
    res = await a.request({ t: 'build', id: 'arrow_turret', x: turret[0], y: turret[1] });
    assert.equal(res.ok, true, res.error);
    const st = t.gs.world.structureAt(turret[0], turret[1]);
    // A wall right next to the turret, between it and the monster.
    const [wx, wy] = [turret[0] + 1, turret[1]];
    if (!t.gs.world.blockAt(wx, wy) && !t.gs.world.structureAt(wx, wy)) {
      res = await a.request({ t: 'build', id: 'wood_wall', x: wx, y: wy });
      assert.equal(res.ok, true, res.error);
    }
    // Only our monster (the turret shoots the nearest one), in plain sight.
    t.gs.config.maxEnemies = 0;
    for (const o of t.gs.enemies.values()) o.dead = true;
    const { spawnEnemy } = await import('../../server/enemies.js');
    const { _test: { shotBlocked } } = await import('../../server/combat.js');
    const [cx, cy] = [turret[0] + 0.5, turret[1] + 0.3];
    const clear = (x, y) => {
      for (let k = 1; k < 20; k++) {
        const b = shotBlocked(t.gs, cx + ((x - cx) * k) / 20, cy + ((y - cy) * k) / 20);
        if (b && !(b.st && b.st.clanId === p.clanId)) return false;
      }
      return t.gs.world.isFree(x, y, 0.45, 'enemy');
    };
    let spot = null;
    for (const [dx, dy] of [[4, 0], [0, 4], [-4, 0], [0, -4], [3, 3], [-3, 3], [3, -3], [-3, -3], [3, 0], [0, 3]]) {
      if (clear(cx + dx, cy + dy)) {
        spot = { x: cx + dx, y: cy + dy };
        break;
      }
    }
    assert.ok(spot, 'a spot in plain sight of the turret');
    const e = spawnEnemy(t.gs, 'slime', spot.x, spot.y, { level: 1 });
    e.hp = e.maxHp = 5000;
    await sleep(3000);
    assert.ok(e.hp < 5000, `the turret hit the monster (hp ${e.hp})`);
    assert.ok(st && !st.dead, 'the turret still stands');
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

test('monsters stop at arm\'s length: they never stand inside a player', async () => {
  const t = await testServer();
  try {
    const a = await t.bot('Vaggen');
    const pa = t.player(a);
    let x = 120;
    while (!t.gs.world.isFree(x, 0.5, 2.5)) x += 1;
    t.place(a, x, 0.5);
    pa.protectUntil = Date.now() + 60000;
    const { spawnEnemy } = await import('../../server/enemies.js');
    const foes = [spawnEnemy(t.gs, 'slime', pa.x + 0.05, pa.y, { level: 1 }), spawnEnemy(t.gs, 'slime', pa.x - 2, pa.y + 0.3, { level: 1 })];
    for (const e of foes) e.hp = e.maxHp = 5000;
    await sleep(1500);
    for (const e of foes) {
      const d = Math.hypot(e.x - pa.x, e.y - pa.y);
      assert.ok(d >= e.r + pa.r - 0.02, `monster ${e.id} at ${d.toFixed(2)} (contact ${(e.r + pa.r).toFixed(2)})`);
      assert.ok(d < e.r + pa.r + 1.2, 'but close enough to bite');
    }
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

test('name + password: a guest gets their character back on a new link or device', async () => {
  const t = await testServer();
  const { Bot } = await import('./bot.js');
  const base = t.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const login = (body) => fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  try {
    // Too short a password: asked again.
    const short = new Bot(t.url, { name: 'Dora', password: 'abc' });
    short.connect().catch(() => {});
    const again = await short.waitFor((m) => m.t === 'need-name' && m.error);
    assert.match(again.error, /minst 4/);
    short.close();
    const a = await t.bot('Dora', { password: 'hemligt' });
    assert.deepEqual(a.welcome.account, { guest: true, password: true });
    const item = a.json.find((m) => m.t === 'inv').bag[0].id;
    a.close();
    await sleep(100);
    // A new browser (no guest token): log in with name + password.
    assert.equal((await login({ name: 'dora', password: 'fel' })).status, 401);
    assert.equal((await login({ name: 'Ingen', password: 'hemligt' })).status, 401);
    const ok = await login({ name: 'dora', password: 'hemligt' });
    assert.equal(ok.status, 200);
    assert.equal(ok.name, 'Dora');
    const back = await t.bot(null, { token: ok.token });
    assert.equal(back.welcome.name, 'Dora');
    assert.equal(back.welcome.id, t.player(back).id);
    assert.equal(back.json.find((m) => m.t === 'inv').bag[0].id, item, 'same character, same sword');
    // A guest without a password can set one in the game.
    const b = await t.bot('Erik');
    assert.equal(b.welcome.account.password, false);
    assert.equal((await b.request({ t: 'password', password: 'x' })).ok, false);
    assert.equal((await b.request({ t: 'password', password: 'svärdfisk' })).ok, true);
    assert.equal((await login({ name: 'Erik', password: 'svärdfisk' })).status, 200);
    // Guessing: a few wrong tries and that name pauses.
    for (let i = 0; i < 6; i++) await login({ name: 'Erik', password: `fel${i}` });
    const paused = await login({ name: 'Erik', password: 'svärdfisk' });
    assert.equal(paused.status, 429);
    assert.match(paused.error, /För många/);
  } finally {
    await t.close();
  }
});

test('share mode: whoever plays at the server computer is admin, visitors through the tunnel are not', async () => {
  const t = await testServer({ localAdmin: true, trustProxy: true });
  try {
    const port = t.srv.port;
    const host = await t.bot('Värden', { headers: { host: `localhost:${port}` } });
    assert.equal(t.player(host).isAdmin, true);
    const visitor = await t.bot('Gästen', { headers: { host: 'brave-otter-quiet-river.trycloudflare.com', 'cf-ray': '8a1b2c', 'cf-connecting-ip': '203.0.113.7' } });
    assert.equal(t.player(visitor).isAdmin, false);
    assert.equal(t.player(visitor).conn.ip, '203.0.113.7', 'the real address, for the per-address limits');
    const before = t.player(visitor).ch.resources.scrap ?? 0;
    const res = await visitor.request({ t: 'chat', text: '/give scrap 500' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Okänt kommando/);
    assert.equal(t.player(visitor).ch.resources.scrap ?? 0, before);
    assert.equal((await host.request({ t: 'chat', text: '/give scrap 500' })).ok, true);
    // A friend forgot their password: the host sets a new one.
    assert.equal((await host.request({ t: 'chat', text: '/password Gästen ny' })).ok, false, 'too short');
    assert.equal((await host.request({ t: 'chat', text: '/password Gästen nyttlösen' })).ok, true);
    const base = t.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
    const res2 = await fetch(`${base}/login`, { method: 'POST', body: JSON.stringify({ name: 'gästen', password: 'nyttlösen' }) });
    assert.equal(res2.status, 200);
  } finally {
    await t.close();
  }
});

test('admins can be listed by player name', async () => {
  const t = await testServer({ admins: ['Chefen'] });
  try {
    const boss = await t.bot('chefen');
    const other = await t.bot('Annan');
    assert.equal(t.player(boss).isAdmin, true);
    assert.equal(t.player(other).isAdmin, false);
  } finally {
    await t.close();
  }
});

test('inputs sent in pairs (Cloudflare) still move you smoothly, one step every tick', async () => {
  const t = await testServer({ inputEvery: 2 });
  try {
    const a = await t.bot('Paret');
    assert.equal(a.welcome.inputEvery, 2);
    const p = t.player(a);
    const xs = [];
    const step = t.gs.step.bind(t.gs);
    t.gs.step = () => {
      step();
      xs.push(p.x);
    };
    // Two frames per message, a message every other tick (with real timer jitter).
    for (let i = 0; i < 15; i++) {
      a.input({ mx: 127, my: 0 });
      a.input({ mx: 127, my: 0 });
      await sleep(66);
    }
    await sleep(200);
    t.gs.step = step;
    const moves = xs.slice(5, -8).map((x, i, arr) => (i ? x - arr[i - 1] : 0)).slice(1);
    const still = moves.filter((d) => d < 1e-6).length;
    assert.ok(moves.length > 20, `ticks ${moves.length}`);
    assert.ok(still <= Math.ceil(moves.length * 0.15), `stood still on ${still} of ${moves.length} ticks`);
    assert.ok(Math.max(...moves) < p.speed * 1.6 / 30 + 1e-6, 'never more than a step (plus a little catch-up) per tick');
  } finally {
    await t.close();
  }
});

test('Cloudflare: base upkeep is charged for the hours the world slept', async () => {
  const t = await testServer({ upkeepCatchUp: true });
  try {
    const gs = t.gs;
    const a = await t.bot('Valvet');
    const p = t.player(a);
    p.ch.resources.wood = 200;
    p.ch.resources.scrap = 50;
    assert.equal((await a.request({ t: 'clan', op: 'create', name: 'Sovarna', tag: 'SOV' })).ok, true);
    t.place(a, wildX(t.gs) + 0.5, 0.5);
    let built = false;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2]]) {
      const res = await a.request({ t: 'build', id: 'banner', x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy });
      if (res.ok) {
        built = true;
        break;
      }
    }
    assert.ok(built, 'a banner in the wild');
    const clan = gs.clans.get(p.clanId);
    clan.vault = {};
    clan.upkeep = {};
    // The world slept for five and a half hours: five hours of upkeep are due.
    gs.upkeepAt = Date.now() - 5.5 * 60 * 60 * 1000;
    gs.stop();
    gs.start();
    const per = gs.rules.upkeepPerStructure;
    const n = [...gs.structures.values()].filter((st) => st.clanId === clan.id).length;
    for (const [k, v] of Object.entries(per)) {
      const owed = (clan.upkeep[k] ?? 0);
      assert.ok(Math.abs(owed - (5 * n * v) / 168) < 1e-9, `${k}: owes ${owed}`);
    }
    assert.ok(Date.now() - gs.upkeepAt < 60 * 60 * 1000, 'caught up to the last whole hour');
    assert.ok(Number(gs.db.meta('upkeepAt')) > 0, 'remembered across restarts');
  } finally {
    await t.close();
  }
});
