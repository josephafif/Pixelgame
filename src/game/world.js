// Procedural, chunked, effectively infinite world. Chunks are generated on
// demand from the world seed and dropped again when far away, so memory use
// stays flat no matter how far the player walks.

import { hashInts } from '../core/rng.js';
import { fbm, tileHash } from './noise.js';

export const CHUNK = 16;
const SAFE_RADIUS = 16;
// The camp plaza (stone floor) and the open ground around it where the
// base buildings stand.
const CAMP_RADIUS = 6.5;
const CAMP_CLEAR = 9;
const LANDMARK_RADIUS = 22;
const MAX_CHUNKS = 160;
// Markets: at most one per big cell of the world, and only in some cells.
export const MARKET_CELL = 112;
const MARKET_CHANCE = 0.1; // ~1 market per 10 cells (plus the guaranteed first one)
const MARKET_NAMES = [
  'Copperwind Bazaar', 'Lanternrest Market', 'Saltroad Post', 'Gilded Gate Exchange', 'Mossy Mile Post',
  "Crow's Rest Market", 'Emberline Bazaar', 'Stonebridge Exchange', "Wanderer's Rest", 'Duskhollow Market',
  'Brightwater Post', 'Ironvale Exchange', 'Tinker Hollow', 'Sunward Bazaar', 'Old Mill Market',
];
const MARKET_COLORS = ['#c8364a', '#3f9ad8', '#e0a030', '#4fb04f', '#9a5cff', '#e86a2a'];
const MARKET_LAYOUTS = ['bazaar', 'fort', 'palisade', 'oasis'];

// Tile ids. Ground tiles are walkable; blockers sit on top of ground.
export const T = {
  GRASS: 1, FLOWERS: 2, MOSS: 3, SAND: 4, SAND2: 5, SNOW: 6, ICE: 7, ASH: 8, BASALT: 9,
  ROCKGRASS: 10, VOIDSTONE: 11, VOIDMOSS: 12, CAMP: 13, PATH: 14,
  WATER: 20, LAVA: 21, TREE: 22, PINE: 23, ROCK: 24, CACTUS: 25, CRYSTAL: 26,
};

const GROUND_BY_NAME = {
  grass: T.GRASS, flowers: T.FLOWERS, moss: T.MOSS, sand: T.SAND, sand2: T.SAND2, snow: T.SNOW,
  ice: T.ICE, ash: T.ASH, basalt: T.BASALT, rockgrass: T.ROCKGRASS, voidstone: T.VOIDSTONE,
  voidmoss: T.VOIDMOSS,
};
const BLOCKER_BY_NAME = { tree: T.TREE, pine: T.PINE, rock: T.ROCK, cactus: T.CACTUS, crystal: T.CRYSTAL };
/** Blocker tile id → name used by game data (gathering.harvest). */
export const BLOCKER_NAME = Object.fromEntries(Object.entries(BLOCKER_BY_NAME).map(([k, v]) => [v, k]));
const LIQUID = new Set([T.WATER, T.LAVA]);

/** Numeric key for a tile (fast Map lookups for structures). */
export function tileKey(tx, ty) {
  return tx * 100003 + ty;
}

// Inverse CDF of fbm() (measured), so data can say "10% water" directly.
const QUANTILES = [
  [0, 0], [0.02, 0.185], [0.05, 0.238], [0.1, 0.288], [0.25, 0.383], [0.5, 0.498],
  [0.75, 0.615], [0.9, 0.712], [0.95, 0.763], [0.98, 0.815], [1, 1],
];
export function noiseThreshold(fraction) {
  for (let i = 1; i < QUANTILES.length; i++) {
    const [p1, v1] = QUANTILES[i];
    if (fraction <= p1) {
      const [p0, v0] = QUANTILES[i - 1];
      return v0 + ((v1 - v0) * (fraction - p0)) / (p1 - p0);
    }
  }
  return 1;
}

const COMPASS = [[1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7]];

export class World {
  constructor(data, seed) {
    this.data = data;
    this.seed = seed >>> 0;
    this.chunks = new Map();
    // Player-built structures by tileKey (filled by the build system) and
    // harvested blockers ("x,y" → [time, tileId]) from the save.
    this.structures = new Map();
    this.harvested = {};
    this.biomes = data.biomes;
    this.biomeById = data.byId.biomes;
    this.q = {
      void: noiseThreshold(0.92),
      snow: noiseThreshold(0.15),
      hot: noiseThreshold(0.9),
      warm: noiseThreshold(0.7),
      dryish: noiseThreshold(0.45),
      volcanicWet: noiseThreshold(0.6),
      wet: noiseThreshold(0.75),
      dry: noiseThreshold(0.18),
      detail: noiseThreshold(0.7),
    };
    // One guaranteed boss arena per boss, in different compass directions at
    // growing distances, so every boss can be found.
    const start = hashInts(this.seed, 71) % 8;
    this.landmarks = data.bosses.map((boss, i) => {
      const [dx, dy] = COMPASS[(start + i * 2 + (i >= 2 ? 1 : 0)) % 8];
      const dist = 70 + 50 * i;
      return { bossId: boss.id, biome: boss.biome, x: Math.round(dx * dist) + 0.5, y: Math.round(dy * dist) + 0.5 };
    });
    // One market is guaranteed within reach, in a direction no boss uses.
    this.marketCache = new Map();
    const [fx, fy] = COMPASS[(start + 1) % 8];
    this.firstMarket = this.#makeMarket('m:first', Math.round(fx * 100), Math.round(fy * 100), hashInts(this.seed, 0xf125));
  }

  // --- Markets ----------------------------------------------------------------------

  #makeMarket(id, x, y, h) {
    const layout = MARKET_LAYOUTS[h % MARKET_LAYOUTS.length];
    const biome = this.biomeAt(x, y);
    const stone = ['highlands', 'snow', 'void', 'volcanic'].includes(biome.id) || ((h >>> 4) & 1) === 1;
    return {
      id, x, y, seed: h, layout,
      r: layout === 'oasis' ? 8 : layout === 'fort' ? 8 : 7,
      material: stone ? 'stone' : 'wood',
      color: MARKET_COLORS[(h >>> 8) % MARKET_COLORS.length],
      name: MARKET_NAMES[(h >>> 12) % MARKET_NAMES.length],
      biome: biome.id,
    };
  }

  /** The market in a world cell, or null (deterministic per seed). */
  marketForCell(mx, my) {
    const key = `${mx},${my}`;
    if (this.marketCache.has(key)) return this.marketCache.get(key);
    let m = null;
    const f = this.firstMarket;
    if (Math.floor(f.x / MARKET_CELL) === mx && Math.floor(f.y / MARKET_CELL) === my) {
      m = f;
    } else {
      const h = hashInts(this.seed, mx, my, 0x3a7e7);
      if ((h % 1000) / 1000 < MARKET_CHANCE) {
        const x = mx * MARKET_CELL + 20 + ((h >>> 10) % (MARKET_CELL - 40));
        const y = my * MARKET_CELL + 20 + ((h >>> 20) % (MARKET_CELL - 40));
        const farFromCamp = x * x + y * y > 150 * 150;
        const clear = !this.landmarks.some((lm) => (lm.x - x) ** 2 + (lm.y - y) ** 2 < 50 * 50);
        if (farFromCamp && clear) m = this.#makeMarket(`m:${key}`, x, y, h);
      }
    }
    this.marketCache.set(key, m);
    return m;
  }

  /** Markets whose area comes within `range` tiles of (x, y). */
  marketsNear(x, y, range) {
    const out = [];
    const m0x = Math.floor((x - range) / MARKET_CELL);
    const m1x = Math.floor((x + range) / MARKET_CELL);
    const m0y = Math.floor((y - range) / MARKET_CELL);
    const m1y = Math.floor((y + range) / MARKET_CELL);
    for (let my = m0y; my <= m1y; my++) {
      for (let mx = m0x; mx <= m1x; mx++) {
        const m = this.marketForCell(mx, my);
        if (m && (m.x - x) ** 2 + (m.y - y) ** 2 <= (range + m.r) ** 2) out.push(m);
      }
    }
    return out;
  }

  /** The market whose grounds contain (x, y) (+ margin), or null. */
  marketAt(x, y, margin = 0) {
    return this.marketsNear(x, y, 2 + margin).find((m) => (m.x + 0.5 - x) ** 2 + (m.y + 0.5 - y) ** 2 <= (m.r + 1.5 + margin) ** 2) ?? null;
  }

  marketById(id) {
    if (id === 'm:first') return this.firstMarket;
    const [mx, my] = id.slice(2).split(',').map(Number);
    return Number.isFinite(mx) && Number.isFinite(my) ? this.marketForCell(mx, my) : null;
  }

  biomeAt(x, y) {
    const d2 = x * x + y * y;
    if (d2 < SAFE_RADIUS * SAFE_RADIUS) return this.biomeById.get('plains');
    for (const lm of this.landmarks) {
      const dx = x - lm.x;
      const dy = y - lm.y;
      if (dx * dx + dy * dy < LANDMARK_RADIUS * LANDMARK_RADIUS) return this.biomeById.get(lm.biome);
    }
    const s = this.seed;
    const t = fbm(s ^ 0x1111, x / 80, y / 80);
    const m = fbm(s ^ 0x2222, x / 70, y / 70);
    const dist = Math.sqrt(d2);
    // Corruption grows with distance; the Voidreach never borders the camp.
    const c = fbm(s ^ 0x3333, x / 110, y / 110) + Math.min(0.05, dist / 6000) - Math.max(0, 0.12 - dist / 500);
    const q = this.q;
    let id;
    if (c > q.void) id = 'void';
    else if (t < q.snow) id = 'snow';
    else if (t > q.hot) id = m < q.volcanicWet ? 'volcanic' : 'desert';
    else if (t > q.warm && m < q.dryish) id = 'desert';
    else if (m > q.wet) id = 'forest';
    else if (m < q.dry) id = 'highlands';
    else id = 'plains';
    return this.biomeById.get(id) ?? this.biomes[0];
  }

  worldLevel(x, y) {
    return 1 + Math.floor(Math.sqrt(x * x + y * y) / 40);
  }

  #generateChunk(cx, cy) {
    const ground = new Uint8Array(CHUNK * CHUNK);
    const block = new Uint8Array(CHUNK * CHUNK);
    const biomeIdx = new Uint8Array(CHUNK * CHUNK);
    const s = this.seed;
    const markets = this.marketsNear(cx * CHUNK + CHUNK / 2, cy * CHUNK + CHUNK / 2, CHUNK + 6);
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = cx * CHUNK + lx;
        const y = cy * CHUNK + ly;
        const i = ly * CHUNK + lx;
        const b = this.biomeAt(x, y);
        biomeIdx[i] = this.biomes.indexOf(b);
        const d2 = x * x + y * y;
        if (d2 <= CAMP_RADIUS * CAMP_RADIUS) {
          ground[i] = T.CAMP;
          continue;
        }
        // Market grounds: paved inside, cleared around the walls.
        const market = markets.find((m) => (m.x - x) ** 2 + (m.y - y) ** 2 <= (m.r + 3) ** 2);
        if (market) {
          const inner = (market.x - x) ** 2 + (market.y - y) ** 2 <= (market.r - 0.5) ** 2;
          ground[i] = inner ? (market.material === 'stone' ? T.CAMP : T.PATH) : GROUND_BY_NAME[b.ground] ?? T.GRASS;
          continue;
        }
        const detail = fbm(s ^ 0x4444, x / 6, y / 6);
        ground[i] = GROUND_BY_NAME[detail > this.q.detail ? b.alt : b.ground] ?? T.GRASS;
        if (d2 < CAMP_CLEAR * CAMP_CLEAR) continue; // keep the camp surroundings open
        if (this.#nearLandmark(x, y, 4)) continue; // keep arenas open
        const w = fbm(s ^ 0x5555, x / 9, y / 9);
        if (b.water && w < noiseThreshold(b.water)) {
          block[i] = T.WATER;
          continue;
        }
        if (b.lava && w > noiseThreshold(1 - b.lava)) {
          block[i] = T.LAVA;
          continue;
        }
        let salt = 1;
        for (const [name, chance] of Object.entries(b.blockers ?? {})) {
          if (tileHash(s, x, y, salt++) < chance) {
            block[i] = BLOCKER_BY_NAME[name] ?? T.ROCK;
            break;
          }
        }
      }
    }
    const chunk = { cx, cy, ground, block, biomeIdx, objects: [], canvas: null };
    // Trees and rocks the player has cut down stay gone (until they regrow).
    for (let i = 0; i < block.length; i++) {
      if (!block[i] || LIQUID.has(block[i])) continue;
      const x = cx * CHUNK + (i % CHUNK);
      const y = cy * CHUNK + ((i / CHUNK) | 0);
      if (this.harvested[`${x},${y}`]) block[i] = 0;
    }
    this.#placeObjects(chunk);
    return chunk;
  }

  #nearLandmark(x, y, r) {
    return this.landmarks.some((lm) => {
      const dx = x - lm.x;
      const dy = y - lm.y;
      return dx * dx + dy * dy < r * r;
    });
  }

  #freeTileIn(chunk, salt) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const h = hashInts(this.seed, chunk.cx, chunk.cy, salt, attempt);
      const lx = 1 + (h % (CHUNK - 2));
      const ly = 1 + ((h >>> 8) % (CHUNK - 2));
      const i = ly * CHUNK + lx;
      const x = chunk.cx * CHUNK + lx + 0.5;
      const y = chunk.cy * CHUNK + ly + 0.5;
      // Nothing spawns inside a market's walls.
      if (!chunk.block[i] && !this.marketAt(x, y, 2)) return { x, y };
    }
    return null;
  }

  #placeObjects(chunk) {
    const { cx, cy } = chunk;
    const key = `${cx},${cy}`;
    const r = hashInts(this.seed, cx, cy, 0xb0b) / 4294967296;
    const far = cx * cx + cy * cy > 1;
    for (const b of this.data.base?.buildings ?? []) {
      if (Math.floor(b.x / CHUNK) === cx && Math.floor(b.y / CHUNK) === cy) {
        chunk.objects.push({ type: 'building', key: `b:${b.id}`, buildingId: b.id, x: b.x, y: b.y });
      }
    }
    for (const lm of this.landmarks) {
      if (Math.floor(lm.x / CHUNK) === cx && Math.floor(lm.y / CHUNK) === cy) {
        chunk.objects.push({ type: 'altar', key: `a:${lm.bossId}`, x: lm.x, y: lm.y, bossId: lm.bossId });
      }
    }
    if (far && r < 0.3) {
      const p = this.#freeTileIn(chunk, 1);
      if (p) chunk.objects.push({ type: 'chest', key: `c:${key}`, ...p });
    }
    if (far && r > 0.93) {
      const p = this.#freeTileIn(chunk, 2);
      if (p) chunk.objects.push({ type: 'shrine', key: `s:${key}`, ...p });
    }
  }

  getChunk(cx, cy) {
    const key = `${cx},${cy}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = this.#generateChunk(cx, cy);
      this.chunks.set(key, chunk);
    }
    chunk.lastUsed = this.frame ?? 0;
    return chunk;
  }

  /** Drops chunks that haven't been touched recently. */
  prune(frame) {
    this.frame = frame;
    if (this.chunks.size <= MAX_CHUNKS) return;
    const sorted = [...this.chunks.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - MAX_CHUNKS; i++) this.chunks.delete(sorted[i][0]);
  }

  tile(tx, ty) {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    const chunk = this.getChunk(cx, cy);
    const i = (ty - cy * CHUNK) * CHUNK + (tx - cx * CHUNK);
    return { ground: chunk.ground[i], block: chunk.block[i], biome: this.biomes[chunk.biomeIdx[i]] };
  }

  /** Blocker tile id at (tx, ty), 0 when open ground. */
  blockAt(tx, ty) {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    const chunk = this.getChunk(cx, cy);
    return chunk.block[(ty - cy * CHUNK) * CHUNK + (tx - cx * CHUNK)];
  }

  isSolid(tx, ty) {
    return this.blockAt(tx, ty) !== 0;
  }

  structureAt(tx, ty) {
    return this.structures.size ? this.structures.get(tileKey(tx, ty)) ?? null : null;
  }

  /**
   * Whether a tile blocks movement. Modes: 'player' (gates open for you),
   * 'enemy' (every solid structure blocks) and 'fly' (flies over trees and
   * rocks, but never over water, lava or walls).
   */
  blockedFor(tx, ty, mode = 'player') {
    const b = this.blockAt(tx, ty);
    if (b && (mode !== 'fly' || LIQUID.has(b))) return true;
    if (!this.structures.size) return false;
    const st = this.structures.get(tileKey(tx, ty));
    if (!st || st.def.walkable) return false;
    return !(mode === 'player' && st.def.kind === 'gate');
  }

  /** True if a circle of radius r at (x, y) overlaps nothing that blocks `mode`. */
  isFree(x, y, r, mode = 'player') {
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r);
    const y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.blockedFor(tx, ty, mode)) return false;
      }
    }
    return true;
  }

  // --- Harvesting ------------------------------------------------------------------

  #setBlock(tx, ty, id) {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    const chunk = this.getChunk(cx, cy);
    chunk.block[(ty - cy * CHUNK) * CHUNK + (tx - cx * CHUNK)] = id;
    chunk.canvas = null; // re-render
  }

  /** Removes a tree/rock and remembers it. Returns the removed tile id. */
  removeBlock(tx, ty, now = Date.now()) {
    const id = this.blockAt(tx, ty);
    if (!id || LIQUID.has(id)) return 0;
    this.#setBlock(tx, ty, 0);
    this.harvested[`${tx},${ty}`] = [now, id];
    return id;
  }

  /** Puts a harvested blocker back (regrowth). */
  restoreBlock(tx, ty) {
    const entry = this.harvested[`${tx},${ty}`];
    if (!entry) return;
    delete this.harvested[`${tx},${ty}`];
    if (this.chunks.has(`${Math.floor(tx / CHUNK)},${Math.floor(ty / CHUNK)}`)) this.#setBlock(tx, ty, entry[1]);
  }

  /** Objects (chests, shrines, altars, camp) in chunks around a point. */
  objectsNear(x, y, radiusChunks = 1) {
    const out = [];
    const ccx = Math.floor(x / CHUNK);
    const ccy = Math.floor(y / CHUNK);
    for (let cy = ccy - radiusChunks; cy <= ccy + radiusChunks; cy++) {
      for (let cx = ccx - radiusChunks; cx <= ccx + radiusChunks; cx++) {
        for (const o of this.getChunk(cx, cy).objects) out.push(o);
      }
    }
    return out;
  }

  /** Finds a walkable spot near (x, y), searching outward. */
  findFreeSpot(x, y, r = 0.4, mode = 'player', fallback = { x: 0.5, y: 1.6 }) {
    if (this.isFree(x, y, r, mode)) return { x, y };
    for (let ring = 1; ring < 12; ring++) {
      for (let i = 0; i < 8 * ring; i++) {
        const [dx, dy] = COMPASS[i % 8];
        const px = x + dx * ring + (i >> 3) * 0.3;
        const py = y + dy * ring;
        if (this.isFree(px, py, r, mode)) return { x: px, y: py };
      }
    }
    return fallback;
  }
}
