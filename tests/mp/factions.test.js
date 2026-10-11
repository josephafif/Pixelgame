// NPC factions in multiplayer: the server makes them once for the world,
// saves them and tells everyone who holds what. Their bases stand with
// their troops; a clan takes one by beating them and holding the flag.
// Their armies march as a whole far from everyone, and close to a player
// they walk the land for real and fight for the flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';
import * as army from '../../server/army.js';

async function clanBot(t, name, tag) {
  const bot = await t.bot(name);
  const { clan } = await t.clanBase(bot, { lodge: 1 }, { name: `${name}s`, tag, near: [130, 40] });
  return { bot, p: t.player(bot), clan };
}

/** A faction's camp (or any of its land) and its outpost. */
function factionCamp(gs) {
  const st = army.factions(gs);
  const keys = Object.keys(st.owned);
  const key = keys.find((k) => st.owned[k].tier === 'camp') ?? keys[0];
  return { st, key, fid: st.owned[key].faction, site: army.site(gs, key) };
}

test('factions: made once for the world and saved; their bases stand with their troops; a clan beats them and takes the flag', async () => {
  const t = await testServer({ worldSeed: 7, outposts: true });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    gs.data.army.territory.captureSeconds = 2;
    const { bot, clan } = await clanBot(t, 'Erövraren', 'ERÖ');
    const { st, key, fid, site } = factionCamp(gs);
    assert.ok(st.list.length >= 3 && st.list.length <= 5);
    // (Their AI waits: no armies setting out from this camp while we look.)
    st.aiT = 1e9;
    st.armies.length = 0;
    const f = st.list.find((x) => x.id === fid);
    // Everyone hears who holds it.
    army.update(gs, 1.1);
    await sleep(300);
    const terr = bot.json.filter((m) => m.t === 'terr').at(-1);
    assert.ok(terr.list.some((e) => e.key === key && e.owner === `f:${fid}` && e.color === f.color && e.base), 'their land on everyone\'s map');
    assert.ok(terr.factions.some((x) => x.id === fid && x.name === f.sv && x.at), 'the factions too');
    // By the base: its garrison (their own troops) and a flag in their colour.
    t.place(bot, site.x + 1, site.y + 12);
    await sleep(900);
    const troops = [...gs.enemies.values()].filter((e) => !e.dead && e.outpost === key && e.faction === fid);
    assert.ok(troops.length >= 1, 'its garrison stands');
    assert.ok(troops.every((e) => gs.data.byId.enemies.get(e.kind)?.faction === fid));
    const flag = gs.terr.active.get(key).structures.find((s) => s.id === 'outpost_flag');
    assert.equal(flag.color, f.color);
    // Beat them and stand at the flag.
    for (const e of troops) e.dead = true;
    await sleep(200);
    t.place(bot, site.x + 0.5, site.y + 1.5);
    for (let i = 0; i < 24 && !army.ownedBy(gs, clan.id).includes(key); i++) await sleep(250);
    assert.equal(st.owned[key], undefined, 'not theirs any more');
    assert.ok(bot.json.some((m) => m.t === 'toast' && m.text.includes(f.sv)), 'the clan hears whose it was');
    // Saved: a fresh server state reads the same factions back.
    army.update(gs, 25);
    const saved = JSON.parse(gs.db.meta('factions'));
    assert.equal(saved.list.length, st.list.length);
    assert.equal(saved.owned[key], undefined);
    gs.factions = null;
    gs.fctx = null;
    assert.deepEqual(Object.keys(army.factions(gs).owned).sort(), Object.keys(saved.owned).sort());
  } finally {
    await t.close();
  }
});

test('a faction\'s army close to a player walks for real; at a clan\'s outpost its troops fight for the flag and take it', async () => {
  const t = await testServer({ worldSeed: 7, outposts: true });
  try {
    const gs = t.gs;
    gs.config.maxEnemies = 0;
    gs.data.army.territory.captureSeconds = 2;
    const { bot, clan } = await clanBot(t, 'Försvararen', 'FÖR');
    const { st, fid } = factionCamp(gs);
    const f = st.list.find((x) => x.id === fid);
    st.aiT = 1e9; // (only the army we send)
    // The clan holds an outpost (no faction's, not by anyone's base); its member stands nearby.
    let mine = null;
    for (let tx = -3; tx <= 3 && !mine; tx++) {
      for (let ty = -3; ty <= 3 && !mine; ty++) {
        const s = army.site(gs, `${tx},${ty}`);
        if (s && !st.owned[s.key] && Math.hypot(s.x - 130, s.y - 40) > 60) mine = s;
      }
    }
    assert.ok(mine);
    gs.terr.map.set(mine.key, { owner: clan.id, since: Date.now(), capture: 1, cleared: Date.now() + 60e3, by: null, attackedUntil: 0 });
    t.place(bot, mine.x + 1, mine.y + 20);
    await sleep(800);
    assert.ok(gs.terr.active.has(mine.key), 'the outpost stands');
    // An army of four comes, near the player: its troops stand in the world and march.
    const host = { id: 900, faction: fid, kind: 'attack', from: f.hq, to: mine.key, troops: 4, x: mine.x + 30, y: mine.y + 20 };
    st.armies.push(host);
    await sleep(900);
    const marching = () => [...gs.enemies.values()].filter((e) => !e.dead && e.army === 900);
    assert.equal(marching().length, 4, 'its troops are in the world');
    assert.ok(marching().every((e) => e.faction === fid && e.march));
    assert.ok(bot.json.some((m) => m.t === 'toast' && /marscherar mot er utpost/.test(m.text)), 'the clan is warned');
    await sleep(1300);
    const terr = bot.json.filter((m) => m.t === 'terr').at(-1);
    assert.ok(terr.armies.some((a) => a.id === 900 && a.to === mine.key), 'on everyone\'s map');
    // They reach the flag: now they come for it (no garrison holds it).
    for (const e of marching()) Object.assign(e, { x: mine.x + (Math.random() - 0.5) * 2, y: mine.y + 6 });
    await sleep(900);
    const raiders = [...gs.enemies.values()].filter((e) => !e.dead && e.raid === mine.key && e.faction === fid);
    assert.ok(raiders.length >= 1, 'they attack the outpost');
    assert.ok(!st.armies.includes(host), 'no longer an army on the march');
    for (const e of raiders) Object.assign(e, { x: mine.x + 0.5, y: mine.y + 1 });
    for (let i = 0; i < 40 && st.owned[mine.key]?.faction !== fid; i++) await sleep(250);
    assert.equal(st.owned[mine.key]?.faction, fid, 'the faction holds it now');
    assert.ok(!army.ownedBy(gs, clan.id).includes(mine.key));
    assert.ok(bot.json.some((m) => m.t === 'toast' && /tog en av era utposter/.test(m.text)));
  } finally {
    await t.close();
  }
});
