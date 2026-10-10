// Finding the way over the tile grid (A*), for walkers that must get round
// walls: workers leaving a walled base go out through the gate instead of
// walking into the wall. Pure: single player and the server share it.

const SQRT2 = Math.SQRT2;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * A route from (sx, sy) to (gx, gy): the points to walk between, the last
 * one the goal itself, or null when there is no way (within `limit` tiles
 * searched, in a box `margin` tiles around start and goal).
 *
 * `blocked(tx, ty)` says which tiles can't be entered; `clear(ax, ay, bx,
 * by)`, when given, says whether the straight line between two points is
 * free, and is used to cut the corners of the tile path (so the walker goes
 * straight where it can, not tile by tile).
 */
export function findRoute(sx, sy, gx, gy, blocked, { clear = null, limit = 5000, margin = 14 } = {}) {
  const ax = Math.floor(sx);
  const ay = Math.floor(sy);
  const bx = Math.floor(gx);
  const by = Math.floor(gy);
  if (ax === bx && ay === by) return [{ x: gx, y: gy }];
  if (blocked(bx, by)) return null;
  const x0 = Math.min(ax, bx) - margin;
  const y0 = Math.min(ay, by) - margin;
  const W = Math.max(ax, bx) + margin - x0 + 1;
  const H = Math.max(ay, by) + margin - y0 + 1;
  const n = W * H;
  const cost = new Float32Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  // 0 unknown, 1 free, 2 blocked, 3 done.
  const state = new Uint8Array(n);
  const free = (x, y) => {
    if (x < x0 || y < y0 || x >= x0 + W || y >= y0 + H) return false;
    const i = (y - y0) * W + (x - x0);
    if (!state[i]) state[i] = blocked(x, y) ? 2 : 1;
    return state[i] !== 2;
  };
  const h = (x, y) => {
    const dx = Math.abs(x - bx);
    const dy = Math.abs(y - by);
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
  };
  const heap = new Heap();
  const start = (ay - y0) * W + (ax - x0);
  const goal = (by - y0) * W + (bx - x0);
  cost[start] = 0;
  state[start] = 1; // wherever the walker stands, it can leave
  heap.push(start, h(ax, ay));
  let searched = 0;
  while (heap.size) {
    const i = heap.pop();
    if (state[i] === 3) continue;
    state[i] = 3;
    if (i === goal) break;
    if (++searched > limit) return null;
    const x = x0 + (i % W);
    const y = y0 + Math.floor(i / W);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!free(nx, ny)) continue;
      // Diagonally only past two open sides (never squeezing past a corner).
      if (dx && dy && (!free(x + dx, y) || !free(x, y + dy))) continue;
      const j = (ny - y0) * W + (nx - x0);
      if (state[j] === 3) continue;
      const c = cost[i] + (dx && dy ? SQRT2 : 1);
      if (c >= cost[j]) continue;
      cost[j] = c;
      from[j] = i;
      heap.push(j, c + h(nx, ny));
    }
  }
  if (state[goal] !== 3) return null;
  const tiles = [];
  for (let i = goal; i !== start; i = from[i]) tiles.push(i);
  tiles.reverse();
  const points = tiles.map((i) => ({ x: x0 + (i % W) + 0.5, y: y0 + Math.floor(i / W) + 0.5 }));
  points[points.length - 1] = { x: gx, y: gy };
  return clear ? straighten(sx, sy, points, clear) : points;
}

/** Drops the points the walker can skip, going straight from one to a later one. */
function straighten(sx, sy, points, clear, reach = 12) {
  const out = [];
  let px = sx;
  let py = sy;
  for (let i = 0; i < points.length - 1; i++) {
    const next = points[i + 1];
    // Long straight stretches are checked in parts (each check costs its length).
    const far = (next.x - px) ** 2 + (next.y - py) ** 2 > reach * reach;
    if (!far && clear(px, py, next.x, next.y)) continue;
    out.push(points[i]);
    px = points[i].x;
    py = points[i].y;
  }
  out.push(points[points.length - 1]);
  return out;
}

/** A binary min-heap of indices by priority. */
class Heap {
  constructor() {
    this.items = [];
    this.prio = [];
  }

  get size() {
    return this.items.length;
  }

  push(item, p) {
    const { items, prio } = this;
    let k = items.length;
    items.push(item);
    prio.push(p);
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (prio[up] <= p) break;
      items[k] = items[up];
      prio[k] = prio[up];
      k = up;
    }
    items[k] = item;
    prio[k] = p;
  }

  pop() {
    const { items, prio } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastP = prio.pop();
    const n = items.length;
    if (n) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && prio[c + 1] < prio[c]) c++;
        if (prio[c] >= lastP) break;
        items[k] = items[c];
        prio[k] = prio[c];
        k = c;
      }
      items[k] = lastItem;
      prio[k] = lastP;
    }
    return top;
  }
}
