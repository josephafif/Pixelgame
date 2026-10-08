// HD pixel art: Scale2x/Scale3x smoothing keeps the art's own colours and
// fills in diagonal steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scale2xPixels, scale3xPixels } from '../../src/render/hd.js';

const R = [255, 0, 0, 255];
const _ = [0, 0, 0, 0];
const img = (rows) => new Uint8ClampedArray(rows.flat(2));
const at = (px, w, x, y) => Array.from(px.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
const colours = (px) => new Set(Array.from({ length: px.length / 4 }, (_v, i) => px.slice(i * 4, i * 4 + 4).join(',')));

test('Scale2x smooths a diagonal and adds no new colours', () => {
  // A 3×3 staircase.
  const src = img([
    [R, _, _],
    [R, R, _],
    [R, R, R],
  ]);
  const out = scale2xPixels(src, 3, 3);
  assert.equal(out.length, 6 * 6 * 4);
  // The empty pixel in the step, (1,0), gets its lower-left quarter filled…
  assert.deepEqual(at(out, 6, 2, 1), R, 'the step is smoothed');
  assert.deepEqual(at(out, 6, 3, 0), _);
  // …and the corners away from the diagonal stay as they were.
  assert.deepEqual(at(out, 6, 5, 0), _);
  assert.deepEqual(at(out, 6, 0, 5), R);
  for (const c of colours(out)) assert.ok([R.join(','), _.join(',')].includes(c), c);
});

test('Scale2x and Scale3x leave flat areas and single pixels alone', () => {
  const flat = img([[R, R], [R, R]]);
  assert.ok(scale2xPixels(flat, 2, 2).every((v, i) => v === R[i % 4]));
  assert.ok(scale3xPixels(flat, 2, 2).every((v, i) => v === R[i % 4]));
  // A lone pixel stays a 2×2 / 3×3 block.
  const dot = img([[_, _, _], [_, R, _], [_, _, _]]);
  const two = scale2xPixels(dot, 3, 3);
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) assert.deepEqual(at(two, 6, x, y), R);
  assert.deepEqual(at(two, 6, 1, 1), _);
  const three = scale3xPixels(dot, 3, 3);
  for (let y = 3; y < 6; y++) for (let x = 3; x < 6; x++) assert.deepEqual(at(three, 9, x, y), R);
});

test('Scale3x smooths a diagonal too', () => {
  const src = img([
    [R, _],
    [R, R],
  ]);
  const out = scale3xPixels(src, 2, 2);
  assert.equal(out.length, 6 * 6 * 4);
  // The empty top-right pixel's lower-left corner is pulled in by the diagonal.
  assert.deepEqual(at(out, 6, 3, 2), R);
  assert.deepEqual(at(out, 6, 5, 0), _);
});
