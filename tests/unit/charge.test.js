import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FULL_AT, swingGap, chargeOf, chargeMult, maySwing } from '../../src/game/charge.js';

test('melee charge: spam a weak blow, wait for a full one (as in Minecraft)', () => {
  const full = 0.6;
  // Fully wound up: all the damage.
  assert.equal(chargeOf(full, full), 1);
  assert.equal(chargeMult(1), 1);
  // A quick second swing is allowed, but hits softly.
  assert.ok(maySwing(swingGap(full), full, true), 'a fresh press swings after the short gap');
  assert.ok(!maySwing(swingGap(full) - 0.01, full, true), 'not before it');
  assert.ok(!maySwing(full * 0.5, full, false), 'a held button waits for the full charge');
  assert.ok(maySwing(full, full, false));
  const f = chargeOf(swingGap(full), full);
  assert.ok(f < FULL_AT && chargeMult(f) < 0.4, `weak (${chargeMult(f).toFixed(2)})`);
  // Spamming never beats waiting: damage per second is lower for every weapon speed.
  for (const fullTime of [0.25, 0.4, 0.6, 1, 1.6]) {
    const gap = swingGap(fullTime);
    const spam = chargeMult(chargeOf(gap, fullTime)) / gap;
    assert.ok(spam < 1 / fullTime, `spam ${spam.toFixed(2)}/s < full ${(1 / fullTime).toFixed(2)}/s at ${fullTime}s`);
  }
});
