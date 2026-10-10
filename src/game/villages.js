// Villages: bigger settlements here and there in the world. Every house is
// built from the same blocks as your camp (walls, floors, a doorway, beds,
// tables, barrels and torches), dirt paths run from each door to the green
// in the middle (a well, two traders' stalls and a pair of watch turrets),
// and lots of villagers walk between the houses along the paths.
//
// A village is a market of a kind (see markets.js): it stands in a market
// cell, its people sync like market people in multiplayer, its traders trade
// and its turrets turn on you if you hurt anyone. Everything here is pure
// and deterministic, so the server and every client build the same village.

import { createRng } from '../core/rng.js';

export const VILLAGE_RADIUS = 17;
const PLAZA = 2; // the green: |x| ≤ 2 and |y| ≤ 2

export const VILLAGE_NAMES = [
  'Birchby', 'Oakdale', 'Lindholm', 'Granvik', 'Stonebeck', 'Elvsby', 'Hagaby', 'Tallmoor', 'Sjoberga',
  'Raby', 'Mossbacka', 'Vallby', 'Meadowick', 'Fellbo', 'Brookhollow', 'Ashford', 'Thornby', 'Kettlewick',
];
const NAMES = [
  'Ada', 'Bo', 'Cilla', 'Dino', 'Elsa', 'Finn', 'Greta', 'Harald', 'Iris', 'Jens', 'Kaj', 'Lisa', 'Maja',
  'Nils', 'Oskar', 'Petra', 'Ragnar', 'Saga', 'Tilda', 'Ulf', 'Vilma', 'Wilhelm', 'Axel', 'Ebba', 'Hugo',
  'Klara', 'Lukas', 'Moa', 'Noah', 'Selma', 'Theo', 'Wilma',
];
const CLOAKS = ['#c8364a', '#e0a030', '#4fb04f', '#9a5cff', '#e86a2a', '#3fb0b0', '#b07a48', '#8d8a9e', '#5a8ad8', '#d87aa8'];

/** Solid things in a village that block walking (the rest — floors, crops — are walked on). */
const SOLID = new Set(['wood_wall', 'stone_wall', 'village_well', 'stall', 'arrow_turret', 'torch', 'bed', 'table', 'barrel', 'crate']);

const key = (x, y) => `${x},${y}`;

/**
 * Plans a village: { structs: [{ id, x, y }], npcs, paths: Set of "x,y"
 * (dirt path tiles), houses, grid } with coordinates relative to its centre.
 */
export function villageLayout(m) {
  const rng = createRng(m.seed ^ 0x7111a6e);
  const r = m.r ?? VILLAGE_RADIUS;
  const wall = m.material === 'stone' ? 'stone_wall' : 'wood_wall';
  const floor = m.material === 'stone' ? 'stone_floor' : 'wood_floor';
  const structs = new Map(); // what stands on a tile (walls, furniture, the well …)
  const floors = new Map(); // what lies under it (house floors, vegetable patches)
  const put = (id, x, y) => structs.set(key(x, y), { id, x, y });
  const lay = (id, x, y) => floors.set(key(x, y), { id, x, y });
  const paths = new Set();

  // The green: a well in the middle, stalls on its south side, watch turrets on the north corners.
  for (let y = -PLAZA; y <= PLAZA; y++) for (let x = -PLAZA; x <= PLAZA; x++) paths.add(key(x, y));
  put('village_well', 0, 0);
  const stalls = [];
  for (const sx of [-2, 1]) {
    put('stall', sx, PLAZA);
    put('stall', sx + 1, PLAZA);
    stalls.push({ x: sx + (sx < 0 ? 0 : 1), y: PLAZA - 1 });
  }
  put('arrow_turret', -PLAZA - 1, -PLAZA - 1);
  put('arrow_turret', PLAZA + 1, -PLAZA - 1);
  put('torch', -PLAZA - 1, PLAZA + 1);
  put('torch', PLAZA + 1, PLAZA + 1);

  // Houses around the green, each with its door facing it.
  const houses = [];
  const count = 8 + Math.floor(rng.next() * 3);
  const turn = rng.next() * Math.PI * 2;
  const taken = (x0, y0, x1, y1) => {
    if (Math.max(Math.abs(x0), Math.abs(x1)) <= PLAZA + 2 && Math.max(Math.abs(y0), Math.abs(y1)) <= PLAZA + 2) return true;
    for (const h of houses) if (x0 <= h.x1 + 2 && x1 >= h.x0 - 2 && y0 <= h.y1 + 2 && y1 >= h.y0 - 2) return true;
    return [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].some(([x, y]) => Math.hypot(x, y) > r - 0.8);
  };
  // An inner ring round the green, then an outer ring in the gaps.
  for (let i = 0; i < count * 2 && houses.length < count; i++) {
    const outer = i >= count;
    const a = turn + ((i % count) + (outer ? 0.5 : 0)) / count * Math.PI * 2 + (rng.next() - 0.5) * 0.4;
    const w = 5 + Math.floor(rng.next() * 3); // outer width 5–7
    const hgt = 4 + Math.floor(rng.next() * 2); // outer height 4–5
    for (const d of outer ? [13.5, 12.5, 14.5, 11.5] : [9, 8, 10, 11]) {
      const cx = Math.round(Math.cos(a) * d);
      const cy = Math.round(Math.sin(a) * d);
      const x0 = cx - (w >> 1);
      const y0 = cy - (hgt >> 1);
      const x1 = x0 + w - 1;
      const y1 = y0 + hgt - 1;
      if (taken(x0, y0, x1, y1)) continue;
      // The door: in the middle of the wall that faces the green.
      let door;
      if (Math.abs(cx) > Math.abs(cy)) door = cx > 0 ? { x: x0, y: cy, dx: -1, dy: 0 } : { x: x1, y: cy, dx: 1, dy: 0 };
      else door = cy > 0 ? { x: cx, y: y0, dx: 0, dy: -1 } : { x: cx, y: y1, dx: 0, dy: 1 };
      houses.push({ x0, y0, x1, y1, door, out: { x: door.x + door.dx, y: door.y + door.dy } });
      break;
    }
  }
  for (const hs of houses) {
    for (let y = hs.y0; y <= hs.y1; y++) {
      for (let x = hs.x0; x <= hs.x1; x++) {
        const edge = x === hs.x0 || x === hs.x1 || y === hs.y0 || y === hs.y1;
        if (!edge || (x === hs.door.x && y === hs.door.y)) lay(floor, x, y);
        else put(wall, x, y);
      }
    }
    // Furniture in the corners away from the door: a bed, a table, a barrel (or a crate).
    const corners = [[hs.x0 + 1, hs.y0 + 1], [hs.x1 - 1, hs.y0 + 1], [hs.x0 + 1, hs.y1 - 1], [hs.x1 - 1, hs.y1 - 1]]
      .filter(([x, y]) => Math.abs(x - hs.door.x) + Math.abs(y - hs.door.y) > 2);
    const things = ['bed', 'table', rng.next() < 0.5 ? 'barrel' : 'crate'];
    corners.forEach(([x, y], k) => {
      if (k < things.length) put(things[k], x, y);
    });
    hs.inside = { x: Math.round((hs.x0 + hs.x1) / 2), y: Math.round((hs.y0 + hs.y1) / 2) };
    // Keep the middle of the room and the way to the door free.
    for (const s of [hs.inside, { x: hs.door.x - hs.door.dx, y: hs.door.y - hs.door.dy }]) {
      if (structs.get(key(s.x, s.y))?.id !== wall) structs.delete(key(s.x, s.y));
    }
  }

  // A vegetable patch beside some of the houses (never in front of the door).
  for (const hs of houses) {
    if (rng.next() < 0.4) continue;
    const sides = [
      [hs.x0 - 4, hs.y0, -1, 0], [hs.x1 + 2, hs.y0, 1, 0], [hs.x0, hs.y0 - 4, 0, -1], [hs.x0, hs.y1 + 2, 0, 1],
    ].filter(([, , dx, dy]) => dx !== hs.door.dx || dy !== hs.door.dy);
    for (const [gx0, gy0] of sides) {
      const gx1 = gx0 + 2;
      const gy1 = gy0 + 2;
      let free = true;
      for (let y = gy0 - 1; y <= gy1 + 1 && free; y++) {
        for (let x = gx0 - 1; x <= gx1 + 1 && free; x++) {
          if (structs.has(key(x, y)) || floors.has(key(x, y)) || Math.hypot(x, y) > r - 1.5 || (Math.abs(x) <= PLAZA + 1 && Math.abs(y) <= PLAZA + 1)) free = false;
        }
      }
      if (!free) continue;
      for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) lay('crops', x, y);
      hs.garden = { x: gx0 + 1, y: gy1 + 1 };
      break;
    }
  }

  // Dirt paths from each door to the green, around houses and gardens (few turns).
  const blocked = (x, y) => Boolean(floors.has(key(x, y)) || SOLID.has(structs.get(key(x, y))?.id));
  for (const hs of houses) {
    const route = pathTiles(hs.out, r, blocked, (x, y) => Math.abs(x) <= PLAZA && Math.abs(y) <= PLAZA && !blocked(x, y), paths);
    for (const t of route) paths.add(key(t.x, t.y));
  }


  // People: two traders behind the stalls, and about two villagers per house.
  const npcs = stalls.map((s, i) => ({
    x: s.x, y: s.y, role: 'merchant',
    name: NAMES[(m.seed + i * 7) % NAMES.length], cloak: CLOAKS[(m.seed + i * 3) % CLOAKS.length],
  }));
  houses.forEach((hs, i) => {
    for (let k = 0; k < 2; k++) {
      const n = npcs.length;
      npcs.push({
        x: k === 0 ? hs.inside.x : hs.out.x, y: k === 0 ? hs.inside.y : hs.out.y, role: 'villager', home: i,
        name: NAMES[(m.seed + 11 + n * 5) % NAMES.length], cloak: CLOAKS[(m.seed + 5 + n * 3) % CLOAKS.length],
      });
    }
  });

  const layout = { structs: [...floors.values(), ...structs.values()], npcs, paths, houses, stalls, r };
  layout.grid = walkGrid(layout, structs, floors);
  return layout;
}

/** A tiny binary min-heap of [cost, value] pairs. */
function minHeap() {
  const heap = [];
  return {
    get size() {
      return heap.length;
    },
    push(cost, v) {
      heap.push([cost, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    },
    pop() {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const rr = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    },
  };
}

/**
 * Tiles of a dirt path from `from` to the nearest tile where `goal` holds,
 * preferring straight runs and existing paths (Dijkstra with a turn cost).
 */
function pathTiles(from, r, blocked, goal, existing) {
  const size = 2 * r + 1;
  const idx = (x, y) => (y + r) * size + (x + r);
  const best = new Float64Array(size * size * 4).fill(Infinity);
  const prev = new Int32Array(size * size * 4).fill(-1);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const heap = minHeap();
  const push = (cost, st) => heap.push(cost, st);
  const pop = () => heap.pop();
  for (let d = 0; d < 4; d++) {
    const s = idx(from.x, from.y) * 4 + d;
    best[s] = 0;
    push(0, s);
  }
  while (heap.size) {
    const [cost, s] = pop();
    if (cost > best[s]) continue;
    const cell = s >> 2;
    const dir = s & 3;
    const x = (cell % size) - r;
    const y = Math.floor(cell / size) - r;
    if (goal(x, y)) {
      const out = [];
      for (let t = s; t !== -1; t = prev[t]) {
        const c = t >> 2;
        out.push({ x: (c % size) - r, y: Math.floor(c / size) - r });
      }
      return out.reverse();
    }
    DIRS.forEach(([dx, dy], d) => {
      const nx = x + dx;
      const ny = y + dy;
      if (Math.hypot(nx, ny) > r - 0.5 || blocked(nx, ny)) return;
      const step = (existing.has(key(nx, ny)) ? 0.6 : 1) + (d === dir || cost === 0 ? 0 : 2.5);
      const ns = idx(nx, ny) * 4 + d;
      if (cost + step < best[ns]) {
        best[ns] = cost + step;
        prev[ns] = s;
        push(cost + step, ns);
      }
    });
  }
  return [];
}

/**
 * Where people can walk, and how much they like to: 0 = blocked, 1 = a path
 * or a floor, 3 = grass. Villagers route over this grid.
 */
function walkGrid(layout, structs, floors) {
  const r = layout.r;
  const size = 2 * r + 1;
  const cost = new Uint8Array(size * size);
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const i = (y + r) * size + (x + r);
      if (Math.hypot(x, y) > r + 0.5) continue;
      if (SOLID.has(structs.get(key(x, y))?.id)) continue;
      const under = floors.get(key(x, y))?.id;
      cost[i] = layout.paths.has(key(x, y)) || (under && under !== 'crops') ? 1 : under === 'crops' ? 6 : 3;
    }
  }
  return { r, size, cost };
}

/**
 * The way from (fx, fy) to (tx, ty) (tile coordinates relative to the
 * village), as tile-centre waypoints at every turn. Prefers paths and floors.
 */
export function villageRoute(layout, fx, fy, tx, ty) {
  const { r, size, cost } = layout.grid;
  const inside = (x, y) => x >= -r && y >= -r && x <= r && y <= r;
  const idx = (x, y) => (y + r) * size + (x + r);
  if (!inside(fx, fy) || !inside(tx, ty) || !cost[idx(tx, ty)]) return null;
  const dist = new Float64Array(size * size).fill(Infinity);
  const prev = new Int32Array(size * size).fill(-1);
  const start = idx(fx, fy);
  const goal = idx(tx, ty);
  dist[start] = 0;
  const open = minHeap();
  open.push(0, start);
  while (open.size) {
    const [cd, cur] = open.pop();
    if (cd > dist[cur]) continue;
    if (cur === goal) break;
    const x = (cur % size) - r;
    const y = Math.floor(cur / size) - r;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny)) continue;
      const n = idx(nx, ny);
      if (!cost[n]) continue;
      const nd = cd + cost[n];
      if (nd < dist[n]) {
        dist[n] = nd;
        prev[n] = cur;
        open.push(nd, n);
      }
    }
  }
  if (!Number.isFinite(dist[goal])) return null;
  const cells = [];
  for (let c = goal; c !== -1; c = prev[c]) cells.push({ x: (c % size) - r, y: Math.floor(c / size) - r });
  cells.reverse();
  // Keep only the turns (and the end).
  const out = [];
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const c = cells[i + 1];
    if (!c || c.x - b.x !== b.x - a.x || c.y - b.y !== b.y - a.y) out.push(b);
  }
  return out;
}

/**
 * Where a villager goes next: home, the green, a neighbour's door or a
 * garden. Returns a tile (relative to the village).
 */
export function villagerDestination(layout, n, rng = Math.random) {
  const houses = layout.houses;
  const own = houses[n.home] ?? houses[0];
  const roll = rng();
  if (!own) return { x: 0, y: -1 };
  if (roll < 0.35) return own.inside;
  if (roll < 0.45) return own.out;
  if (roll < 0.75) {
    // Somewhere on the green, round the well.
    const spots = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1], [-2, -1], [2, -1], [-2, 0], [2, 0]];
    const [x, y] = spots[Math.floor(rng() * spots.length)];
    return { x, y };
  }
  const other = houses[Math.floor(rng() * houses.length)] ?? own;
  if (roll < 0.9 && other.garden) return other.garden;
  return rng() < 0.5 ? other.out : other.inside;
}

/**
 * One villager's step: walks its route (planning a new one when it arrives
 * and has rested), and returns the point to walk towards, or null to stand.
 * `n` keeps { route, wait, tx, ty }; m is the village (its centre).
 */
export function villagerTarget(layout, m, n, dt, rng = Math.random) {
  if (n.wait > 0) {
    n.wait -= dt;
    return null;
  }
  const ox = m.x + 0.5;
  const oy = m.y + 0.5;
  if (!n.route?.length) {
    const fx = Math.floor(n.x - m.x);
    const fy = Math.floor(n.y - m.y);
    const to = villagerDestination(layout, n, rng);
    n.route = villageRoute(layout, fx, fy, to.x, to.y) ?? [];
    if (!n.route.length) {
      n.wait = 1 + rng() * 2;
      return null;
    }
  }
  const wp = n.route[0];
  const wx = ox + wp.x;
  const wy = oy + wp.y;
  if ((wx - n.x) ** 2 + (wy - n.y) ** 2 < 0.04) {
    n.route.shift();
    if (!n.route.length) n.wait = 2 + rng() * 6; // arrived: stay a while
    return null;
  }
  return { x: wx, y: wy };
}
