import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, deriveSeed, hashString, hashInts, roundTo, formatSeed } from '../../src/core/rng.js';

test('same seed gives the same sequence', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('hashes are stable across runs and platforms (golden values)', () => {
  assert.equal(hashString('pixelgame'), 2802280467);
  assert.equal(hashInts(1, 2, 3), hashInts(1, 2, 3));
  assert.notEqual(hashInts(1, 2, 3), hashInts(3, 2, 1));
});

test('derived streams are independent of each other', () => {
  const a = createRng(deriveSeed(7, 'modifiers'));
  const b = createRng(deriveSeed(7, 'effects'));
  assert.notEqual(a.next(), b.next());
  assert.equal(deriveSeed(7, 'x'), deriveSeed(7, 'x'));
});

test('int() stays within inclusive bounds and hits both ends', () => {
  const r = createRng(1);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const v = r.int(3, 6);
    assert.ok(v >= 3 && v <= 6);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6]);
});

test('weighted() never picks zero-weight items', () => {
  const r = createRng(9);
  const items = [{ id: 'a', weight: 0 }, { id: 'b', weight: 1 }, { id: 'c', weight: 3 }];
  for (let i = 0; i < 500; i++) assert.notEqual(r.weighted(items).id, 'a');
});

test('roundTo and formatSeed', () => {
  assert.equal(roundTo(1.23456, 2), 1.23);
  assert.equal(roundTo(2.5, 0), 3);
  assert.equal(formatSeed(42), '00000042');
});
