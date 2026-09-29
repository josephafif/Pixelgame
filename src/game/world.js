// Procedural, chunked, effectively infinite world. Chunks are generated on
// demand from the world seed and dropped again when far away, so memory use
// stays flat no matter how far the player walks.

import { hashInts } from '../core/rng.js';
import { fbm, tileHash } from './noise.js';

export const CHUNK = 16;
const SAFE_RADIUS = 14;
const CAMP_RADIUS = 3;
const LANDMARK_RADIUS = 22;
const MAX_CHUNKS = 160;

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
        const detail = fbm(s ^ 0x4444, x / 6, y / 6);
        ground[i] = GROUND_BY_NAME[detail > this.q.detail ? b.alt : b.ground] ?? T.GRASS;
        if (d2 < 36) continue; // keep the camp surroundings open
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
      if (!chunk.block[i]) return { x: chunk.cx * CHUNK + lx + 0.5, y: chunk.cy * CHUNK + ly + 0.5 };
    }
    return null;
  }

  #placeObjects(chunk) {
    const { cx, cy } = chunk;
    const key = `${cx},${cy}`;
    const r = hashInts(this.seed, cx, cy, 0xb0b) / 4294967296;
    const far = cx * cx + cy * cy > 1;
    if (cx === 0 && cy === 0) {
      chunk.objects.push({ type: 'camp', key: 'camp', x: 0.5, y: 0.5 });
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

  isSolid(tx, ty) {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    const chunk = this.getChunk(cx, cy);
    return chunk.block[(ty - cy * CHUNK) * CHUNK + (tx - cx * CHUNK)] !== 0;
  }

  /** True if a circle of radius r at (x, y) overlaps no solid tile. */
  isFree(x, y, r) {
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r);
    const y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.isSolid(tx, ty)) return false;
      }
    }
    return true;
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
  findFreeSpot(x, y, r = 0.4) {
    if (this.isFree(x, y, r)) return { x, y };
    for (let ring = 1; ring < 12; ring++) {
      for (let i = 0; i < 8 * ring; i++) {
        const [dx, dy] = COMPASS[i % 8];
        const px = x + dx * ring + (i >> 3) * 0.3;
        const py = y + dy * ring;
        if (this.isFree(px, py, r)) return { x: px, y: py };
      }
    }
    return { x: 0.5, y: 0.5 };
  }
}
