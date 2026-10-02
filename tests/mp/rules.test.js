import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RULES, parseRaidWindow, inRaidWindow, raidState, pvpBlock, canDo, playerNameProblem, clanTagProblem,
  bannerProblem, claimAt, isNewbie, localTimeParts,
} from '../../src/net/rules.js';

const rules = { ...DEFAULT_RULES };

test('raid windows parse and follow the Swedish clock', () => {
  const w = parseRaidWindow('sat 18:00-21:00, sun 12:00-14:30');
  assert.deepEqual(w, [{ day: 6, start: 1080, end: 1260 }, { day: 0, start: 720, end: 870 }]);
  assert.deepEqual(parseRaidWindow('off'), []);
  assert.throws(() => parseRaidWindow('saturday evening'));
  assert.throws(() => parseRaidWindow('sat 21:00-18:00'));
  // Saturday 4 Oct 2025, 19:30 in Stockholm (summer time, UTC+2) = 17:30 UTC.
  const inside = new Date(Date.UTC(2025, 9, 4, 17, 30));
  assert.deepEqual(localTimeParts(inside, 'Europe/Stockholm'), { day: 6, minutes: 19 * 60 + 30 });
  assert.equal(inRaidWindow(w, inside, 'Europe/Stockholm'), true);
  assert.equal(inRaidWindow(w, new Date(Date.UTC(2025, 9, 4, 20, 0)), 'Europe/Stockholm'), false); // 22:00 local
});

test('a base is raidable while its clan is online, shortly after, or in the window', () => {
  const now = Date.UTC(2025, 9, 1, 10, 0); // a Wednesday
  const w = parseRaidWindow(rules.raidWindow);
  assert.equal(raidState(rules, { online: 1, lastOnlineAt: 0 }, now, w).raidable, true);
  assert.equal(raidState(rules, { online: 0, lastOnlineAt: now - 5 * 60000 }, now, w).reason, 'grace');
  assert.equal(raidState(rules, { online: 0, lastOnlineAt: now - 20 * 60000 }, now, w).raidable, false);
  const sat = Date.UTC(2025, 9, 4, 17, 0); // Saturday 19:00 Stockholm
  assert.equal(raidState(rules, { online: 0, lastOnlineAt: 0 }, sat, w).reason, 'window');
});

test('PvP: town, clan mates, spawn and newbie protection', () => {
  const now = 1000;
  const a = { x: 100, y: 0, clanId: 1, dead: false, newbie: false, protectUntil: 0 };
  const b = { x: 101, y: 0, clanId: 2, dead: false, newbie: false, protectUntil: 0 };
  assert.equal(pvpBlock(rules, a, b, now), null);
  assert.equal(pvpBlock(rules, a, { ...b, clanId: 1 }, now), 'clan');
  assert.equal(pvpBlock(rules, a, { ...b, x: 3 }, now), 'safe');
  assert.equal(pvpBlock(rules, { ...a, x: 2 }, b, now), 'safe');
  assert.equal(pvpBlock(rules, a, { ...b, protectUntil: now + 5 }, now), 'spawn');
  assert.equal(pvpBlock(rules, a, { ...b, newbie: true }, now), 'newbie');
  assert.equal(pvpBlock(rules, a, { ...b, newbie: true, asleep: true }, now), null);
  assert.equal(isNewbie(rules, { playSeconds: 100 }), true);
  assert.equal(isNewbie(rules, { playSeconds: 100, firstBoss: true }), false);
  assert.equal(isNewbie(rules, { playSeconds: 3 * 3600 }), false);
});

test('clan roles and names', () => {
  assert.equal(canDo('member', 'build'), true);
  assert.equal(canDo('member', 'withdraw'), false);
  assert.equal(canDo('officer', 'invite'), true);
  assert.equal(canDo('officer', 'disband'), false);
  assert.equal(canDo('leader', 'disband'), true);
  assert.equal(playerNameProblem('Åsa'), null);
  assert.ok(playerNameProblem('a'));
  assert.ok(playerNameProblem('<script>'));
  assert.equal(clanTagProblem('ULV'), null);
  assert.ok(clanTagProblem('ulv!'));
});

test('banners keep their distance and claims cover a circle', () => {
  const claims = [{ clanId: 1, x: 100.5, y: 0.5 }];
  assert.ok(bannerProblem(rules, 10, 0, 2, []));
  assert.ok(bannerProblem(rules, 110, 0, 2, claims));
  assert.equal(bannerProblem(rules, 160, 0, 2, claims), null);
  assert.equal(bannerProblem(rules, 110, 0, 1, claims), null);
  assert.equal(claimAt(rules, claims, 110, 0)?.clanId, 1);
  assert.equal(claimAt(rules, claims, 130, 0), null);
});
