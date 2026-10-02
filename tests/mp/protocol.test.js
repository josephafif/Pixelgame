import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader } from '../../src/net/codec.js';
import {
  encodeInput, decodeInput, encodeSnapshot, decodeSnapshot, ET, FIELDS, quantize, angleToByte, byteToAngle,
} from '../../src/net/protocol.js';

test('varints and zigzag round-trip', () => {
  const w = new Writer(4);
  const nums = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 40 + 7];
  const signed = [0, -1, 1, -64, 64, -100000, 123456789];
  for (const n of nums) w.uv(n);
  for (const n of signed) w.sv(n);
  w.str('Fristaden åäö');
  const r = new Reader(w.finish());
  for (const n of nums) assert.equal(r.uv(), n);
  for (const n of signed) assert.equal(r.sv(), n);
  assert.equal(r.str(), 'Fristaden åäö');
  assert.equal(r.left, 0);
});

test('input frames round-trip and junk is rejected', () => {
  const frames = [{ seq: 1, mx: 127, my: -127, buttons: 3, cmd: 2, aim: 200, target: 9001, view: 77 }];
  assert.deepEqual(decodeInput(encodeInput(frames)), frames);
  assert.throws(() => decodeInput(new Uint8Array([1, 0])));
  assert.throws(() => decodeInput(new Uint8Array([1, 1, 5])));
  assert.throws(() => decodeInput(new Uint8Array([9, 1])));
});

test('snapshots send only what changed and the client rebuilds full state', () => {
  const self = { x: 1.5, y: -2.25, kx: 0, ky: 0, speed: 4.4, sprint: 1.6, hp: 90, maxHp: 100, flags: 2 };
  const v1 = FIELDS[ET.PLAYER].map((_, i) => i * 3);
  v1[0] = quantize(10.5);
  v1[1] = quantize(-3.25);
  const full = encodeSnapshot({ tick: 5, ack: 2, self, removed: [], entities: [{ id: 42, type: ET.PLAYER, values: v1, prev: null }] });
  const known = new Map();
  const a = decodeSnapshot(full, known);
  assert.equal(a.tick, 5);
  assert.equal(a.self.x, 1.5);
  assert.equal(a.self.speed, 4.4);
  assert.deepEqual(known.get(42).values, v1);
  const v2 = v1.slice();
  v2[0] += 3;
  const delta = encodeSnapshot({ tick: 6, ack: 3, self, removed: [], entities: [{ id: 42, type: ET.PLAYER, values: v2, prev: v1 }] });
  assert.ok(delta.byteLength < full.byteLength);
  decodeSnapshot(delta, known);
  assert.deepEqual(known.get(42).values, v2);
  const gone = encodeSnapshot({ tick: 7, ack: 3, self, removed: [42], entities: [] });
  const c = decodeSnapshot(gone, known);
  assert.deepEqual(c.removed, [42]);
  assert.equal(known.has(42), false);
});

test('angles survive the byte encoding', () => {
  for (const a of [0, 1, -1, Math.PI, -Math.PI / 2, 3]) {
    const back = byteToAngle(angleToByte(a));
    const diff = Math.abs(Math.atan2(Math.sin(back - a), Math.cos(back - a)));
    assert.ok(diff < 0.03, `${a} → ${back}`);
  }
});
