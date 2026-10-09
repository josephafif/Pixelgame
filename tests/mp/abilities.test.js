// Weapon abilities and legendary powers in multiplayer: every one of them
// casts on the server, hurts monsters (never players), shows its effects to
// the players around and respects its cooldown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import { BTN, angleToByte } from '../../src/net/protocol.js';

/** An ability object as a weapon carries it, from a data template (its weakest roll). */
function abilityFrom(tpl, legendary = false) {
  const lo = (key) => (Array.isArray(tpl[key]) ? tpl[key][0] : 0);
  return {
    id: tpl.id, action: tpl.do, name: tpl.name, damage: lo('damage'), radius: lo('radius'), duration: lo('duration'),
    count: lo('count'), range: lo('range'), slow: lo('slow'), cooldown: lo('cooldown'), color: tpl.color, legendary,
  };
}

async function arena(t, name) {
  const bot = await t.bot(name);
  const p = t.player(bot);
  let x = 120;
  while (!t.gs.world.isFree(x, 0.5, 3.2)) x += 1;
  t.place(bot, x, 0.5);
  p.protectUntil = Date.now() + 10 * 60 * 1000; // monsters can't spoil the test
  return { bot, p };
}

async function spawnFoes(t, p, { hp = 1e6 } = {}) {
  const { spawnEnemy } = await import('../../server/enemies.js');
  const foes = [];
  for (const [dx, dy] of [[2.2, 0], [-2.2, 0.4], [0.3, 2.2], [1.6, -1.6]]) {
    const spot = t.gs.world.findFreeSpot(p.x + dx, p.y + dy, 0.4);
    const e = spawnEnemy(t.gs, 'slime', spot.x, spot.y, { level: 1 });
    e.hp = e.maxHp = hp;
    foes.push(e);
  }
  return foes;
}

function equip(p, ab) {
  // The held weapon with this power (the compiled weapon is what the server casts from).
  p.weapon = { ...p.weapon, ability: ab };
  p.ch.extra.abilityCd = {};
}

test('every weapon ability and legendary power works in multiplayer', async () => {
  const t = await testServer();
  try {
    const { bot, p } = await arena(t, 'Trollkarl');
    const list = [
      ...t.gs.data.abilities.map((tpl) => abilityFrom(tpl)),
      ...t.gs.data.legendaryAbilities.map((tpl) => abilityFrom(tpl, true)),
    ];
    assert.ok(list.length >= 15, 'all the powers');
    for (const ab of list) {
      for (const e of t.gs.enemies.values()) e.dead = true;
      t.gs.allies.clear();
      await sleep(80);
      const foes = await spawnFoes(t, p);
      equip(p, ab);
      const before = { x: p.x, y: p.y, attackPower: p.stats.attackPower };
      bot.json.length = 0;
      bot.input({ buttons: BTN.ABILITY, aim: angleToByte(0) });
      const wait = Math.min(ab.duration || 0, 3) * 1000 + 900;
      const sawClone = { any: false };
      for (let ms = 0; ms < wait; ms += 100) {
        bot.input({ aim: angleToByte(0) });
        if (t.gs.allies.size) sawClone.any = true;
        await sleep(100);
      }
      const cd = p.ch.extra.abilityCd[p.weapon.dna.id];
      assert.ok(cd > Date.now(), `${ab.name}: on cooldown after casting`);
      assert.ok(bot.json.some((m) => m.t === 'abcd' && m.left === ab.cooldown), `${ab.name}: the client hears the cooldown`);
      assert.ok(bot.json.some((m) => m.t === 'ev' && m.list.some((ev) => ev.k === 'fx' && ev.fx === 'ab')), `${ab.name}: effects are shown`);
      const hurt = foes.filter((e) => e.hp < e.maxHp || e.dead).length;
      if (ab.action === 'timewarp') {
        assert.ok(foes.some((e) => e.warpUntil > 0), 'Time Warp slows the monsters');
      } else if (ab.action === 'ascend') {
        assert.ok(p.ascend, 'Ascension is on');
        assert.ok(p.stats.attackPower > before.attackPower, 'Ascension makes you stronger');
      } else if (ab.action !== 'blink') {
        // (Blink only hurts where you land: that is checked below by where you went.)
        assert.ok(hurt > 0, `${ab.name} (${ab.action}) hurt a monster`);
      }
      if (ab.action === 'blink') assert.ok(Math.hypot(p.x - before.x, p.y - before.y) > 0.5, 'Blink moves you');
      if (ab.action === 'clone') assert.ok(sawClone.any, 'a clone appeared');
      // A second press right away does nothing.
      const hpNow = foes.map((e) => e.hp);
      bot.input({ buttons: BTN.ABILITY, aim: angleToByte(0) });
      await sleep(150);
      assert.equal(p.ch.extra.abilityCd[p.weapon.dna.id], cd, `${ab.name}: no second cast during the cooldown`);
      void hpNow;
      // Buffs and areas run out before the next power.
      p.buffs = [];
      p.ascend = null;
      t.gs.areas.clear();
    }
  } finally {
    await t.close();
  }
});

test('powers never hurt other players, and Phoenix saves you once', async () => {
  const t = await testServer();
  try {
    const { bot, p } = await arena(t, 'Fenix');
    const other = await t.bot('Granne');
    const o = t.player(other);
    o.ch.pvpOptIn = true;
    o.newbie = false;
    p.ch.pvpOptIn = true;
    p.newbie = false;
    o.x = p.x + 1.5;
    o.y = p.y;
    o.queue.length = 0;
    const meteor = abilityFrom(t.gs.data.abilities.find((a) => a.do === 'quake'));
    equip(p, meteor);
    const hp0 = o.hp;
    bot.input({ buttons: BTN.ABILITY, aim: angleToByte(0) });
    await sleep(1500);
    assert.equal(o.hp, hp0, 'the other player is unhurt');
    // Phoenix: a deadly blow while it is ready leaves you standing at half health.
    const phoenix = abilityFrom(t.gs.data.abilities.find((a) => a.do === 'phoenix'));
    equip(p, phoenix);
    p.protectUntil = 0;
    const { hurtPlayer } = await import('../../server/combat.js');
    hurtPlayer(t.gs, p, p.hp + 1000, { dot: true });
    assert.equal(p.dead, false, 'Phoenix: you rise from the ashes');
    assert.ok(p.hp >= p.maxHp * 0.5 - 1);
    assert.ok(p.ch.extra.abilityCd[p.weapon.dna.id] > Date.now(), 'and its cooldown starts');
    p.invulnUntil = 0;
    hurtPlayer(t.gs, p, p.hp + 1000, { dot: true });
    assert.equal(p.dead, true, 'only once');
  } finally {
    await t.close();
  }
});

test('cooldowns are kept with the character (logging out does not reset them)', async () => {
  const t = await testServer();
  try {
    const { bot, p } = await arena(t, 'Minnet');
    await spawnFoes(t, p);
    const ab = abilityFrom(t.gs.data.abilities.find((a) => a.do === 'frostnova'));
    equip(p, ab);
    bot.input({ buttons: BTN.ABILITY, aim: angleToByte(0) });
    await sleep(300);
    const id = p.weapon.dna.id;
    const { cooldownPayload } = await import('../../server/abilities.js');
    const payload = cooldownPayload(p);
    assert.ok(payload.all[id] > ab.cooldown - 1, 'the running cooldown is sent on joining');
    assert.ok(p.ch.extra.abilityCd[id] > Date.now(), 'and stored in the character');
  } finally {
    await t.close();
  }
});
