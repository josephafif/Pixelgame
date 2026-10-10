// Procedural, chunked, effectively infinite world. Chunks are generated on
// demand from the world seed and dropped again when far away, so memory use
// stays flat no matter how far the player walks.

import { hashInts } from '../core/rng.js';
import { fbm, tileHash, valueNoise } from './noise.js';
import { villageLayout, VILLAGE_RADIUS, VILLAGE_NAMES } from './villages.js';

export const CHUNK = 16;
const SAFE_RADIUS = 16;
// The camp plaza (stone floor) and the open ground around it where the
// base buildings stand.
const CAMP_RADIUS = 8.75; // (room on the plaza for the Workers' Lodge too)
const CAMP_CLEAR = 12;
const LANDMARK_RADIUS = 22;
// Lesser altars: one more boss to find in about half of the big world cells.
// Every altar can be beaten once; after that you look for a new one.
export const ALTAR_CELL = 200;
const ALTAR_CHANCE = 0.55;
// Sites to explore (watchtowers, ruins, old mines, runestones): one per cell, often.
const SITE_CELL = 72;
const SITE_CHANCE = 0.6;
export const SITE_KINDS = ['tower', 'ruins', 'mine', 'runestone'];
const ALTAR_CLEAR = 5;
const MAX_CHUNKS = 160;
// Markets: at most one per big cell of the world, and only in some cells.
export const MARKET_CELL = 112;
// (Fristaden's traders in multiplayer; the same number as TOWN_CELL in markets.js.)
const TOWN_MARKET_CELL = 1 << 20;
const MARKET_CHANCE = 0.1; // ~1 market per 10 cells (plus the guaranteed first one)
// Villages share the market cells: about one cell in six has one (plus a first one near camp).
const VILLAGE_CHANCE = 0.17;
const VILLAGE_COLORS = ['#7aa84a', '#c8963a', '#5a8ad8', '#b07a48'];
const MARKET_NAMES = [
  'Copperwind Bazaar', 'Lanternrest Market', 'Saltroad Post', 'Gilded Gate Exchange', 'Mossy Mile Post',
  "Crow's Rest Market", 'Emberline Bazaar', 'Stonebridge Exchange', "Wanderer's Rest", 'Duskhollow Market',
  'Brightwater Post', 'Ironvale Exchange', 'Tinker Hollow', 'Sunward Bazaar', 'Old Mill Market',
];
const MARKET_COLORS = ['#c8364a', '#3f9ad8', '#e0a030', '#4fb04f', '#9a5cff', '#e86a2a'];
const MARKET_LAYOUTS = ['bazaar', 'fort', 'palisade', 'oasis'];
// Seas: big oceans far from camp, with shallow coasts, deep open water and
// islands. Everything within LAND_SAFE of the camp is always dry land.
const LAND_SAFE = 170;
const LAND_FADE = 220;
/** What a spot is, seen from the sea. */
export const SEA = { LAND: 0, BEACH: 1, ISLE: 2, ISLE_BEACH: 3, SHALLOW: 4, DEEP: 5 };
// Great boss altars at growing distances (the first is always reachable on foot).
const BOSS_DISTANCES = [150, 270, 390, 510, 630, 750, 870, 990];

// Tile ids. Ground tiles are walkable; blockers sit on top of ground.
export const T = {
  GRASS: 1, FLOWERS: 2, MOSS: 3, SAND: 4, SAND2: 5, SNOW: 6, ICE: 7, ASH: 8, BASALT: 9,
  ROCKGRASS: 10, VOIDSTONE: 11, VOIDMOSS: 12, CAMP: 13, PATH: 14,
  // Prism Barrens (far lands): pale crystal sand and glassy flats.
  PRISMSAND: 15, PRISMGLASS: 16,
  WATER: 20, LAVA: 21, TREE: 22, PINE: 23, ROCK: 24, CACTUS: 25, CRYSTAL: 26,
  SEA: 27, DEEP: 28, PALM: 29, OBSIDIAN: 30, ORE: 31, STARSTONE: 32,
  // Prism Barrens: crystal formations, and mirror crystals that bounce shots.
  PRISM: 33, MIRROR: 34,
};

/**
 * World generation version. 1: the original world. 2: the far lands (new
 * biomes far out, see #farBiome). Old worlds are upgraded, but the places
 * you had already seen keep their old land (World#legacy).
 */
export const WORLD_GEN = 2;
/** The far lands begin this far from the camp. */
export const FAR_MIN = 280;

/**
 * Single player: which explored chunks keep the land of an older world
 * version (chunk key → version), from the save's explored list and its
 * marks ([[version, n]]: the first n entries were seen in that version).
 */
export function legacyFromExplored(explored = [], marks = []) {
  const out = new Map();
  let from = 0;
  for (const [gen, n] of marks) {
    for (let i = from; i < Math.min(n, explored.length); i++) if (!out.has(explored[i])) out.set(explored[i], gen);
    from = Math.max(from, n);
  }
  return out;
}

const GROUND_BY_NAME = {
  grass: T.GRASS, flowers: T.FLOWERS, moss: T.MOSS, sand: T.SAND, sand2: T.SAND2, snow: T.SNOW,
  ice: T.ICE, ash: T.ASH, basalt: T.BASALT, rockgrass: T.ROCKGRASS, voidstone: T.VOIDSTONE,
  voidmoss: T.VOIDMOSS, prismsand: T.PRISMSAND, prismglass: T.PRISMGLASS,
};
const BLOCKER_BY_NAME = {
  tree: T.TREE, pine: T.PINE, rock: T.ROCK, cactus: T.CACTUS, crystal: T.CRYSTAL, palm: T.PALM,
  obsidian: T.OBSIDIAN, ore: T.ORE, starstone: T.STARSTONE, prism: T.PRISM, mirror: T.MIRROR,
};
/** Crystals that send shots off in a new direction instead of stopping them. */
export const REFLECTS = new Set([T.MIRROR]);
/** Blocker tile id → name used by game data (gathering.harvest). */
export const BLOCKER_NAME = Object.fromEntries(Object.entries(BLOCKER_BY_NAME).map(([k, v]) => [v, k]));
export const LIQUID = new Set([T.WATER, T.LAVA, T.SEA, T.DEEP]);
/** Water a boat can float on (lakes, coastal sea, open sea). */
export const SAILABLE = new Set([T.WATER, T.SEA, T.DEEP]);
// Shallow water (lakes, rivers, the coast) takes a floor: a bridge or a dock
// you can walk on and build on. Deep sea and lava don't.
export const BRIDGEABLE = new Set([T.WATER, T.SEA]);
/**
 * Trees, rocks and the like only block where they stand: a circle around
 * the trunk or the foot of the stone ([radius, centre height in the tile]),
 * not their whole tile. You can walk close by, slip between trees that
 * stand diagonally, and the art still looks solid.
 */
export const PROP_SHAPE = new Map([
  [T.TREE, [0.3, 0.68]], [T.PINE, [0.28, 0.7]], [T.PALM, [0.26, 0.72]], [T.CACTUS, [0.3, 0.6]],
  [T.ROCK, [0.36, 0.58]], [T.ORE, [0.36, 0.58]], [T.OBSIDIAN, [0.36, 0.58]],
  [T.CRYSTAL, [0.34, 0.6]], [T.STARSTONE, [0.34, 0.6]], [T.PRISM, [0.34, 0.6]], [T.MIRROR, [0.36, 0.58]],
]);

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
  /**
   * @param {object} data game data
   * @param {number} seed terrain seed
   * @param {object} [opts] multiplayer options:
   *   secretSeed — places chests, shrines, curiosities and treasure (the
   *     server keeps it to itself, so nobody can map the loot offline);
   *   hideObjects — leave those objects out (clients get them from the server);
   *   maxChunks — how many chunks stay cached;
   *   gen — the world's generation version (WORLD_GEN for a new world);
   *   legacy — chunk key → the version it was first seen in: newer far lands
   *     never grow there (old saves and clan bases keep their land).
   */
  constructor(data, seed, opts = {}) {
    this.data = data;
    this.seed = seed >>> 0;
    this.objSeed = (opts.secretSeed ?? seed) >>> 0;
    this.gen = opts.gen ?? WORLD_GEN;
    this.legacy = opts.legacy ?? new Map();
    this.hideObjects = Boolean(opts.hideObjects);
    // In multiplayer nothing hidden may change the terrain (clients must
    // predict collisions without knowing the secret seed).
    this.sharedTerrain = opts.secretSeed !== undefined || this.hideObjects;
    this.maxChunks = opts.maxChunks ?? MAX_CHUNKS;
    // Multiplayer: only these camp buildings stand in the town (null = all of them).
    this.townBuildings = opts.townBuildings ?? null;
    // Multiplayer: Fristaden's traders (src/game/markets.js), found by id and cell only.
    this.town = opts.townMarket ?? null;
    // Multiplayer: which gates let the moving player through (null = all).
    this.gateFilter = null;
    this.chunks = new Map();
    // Player-built structures by tileKey (filled by the build system):
    // floors lie in their own layer, so walls and turrets can stand on them.
    // Plus harvested blockers ("x,y" → [time, tileId]) from the save.
    this.structures = new Map();
    this.floors = new Map();
    this.harvested = {};
    // Where cut trees and rocks never grow back (the camp, a clan's claim):
    // (tx, ty) → true. Saplings aren't drawn there either.
    this.noRegrow = null;
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
      ocean: noiseThreshold(0.4),
      deep: noiseThreshold(0.22),
      isle: noiseThreshold(0.92),
      // The far lands: about one part in seven of the land out there, split
      // between the three kinds by a slower noise.
      far: noiseThreshold(0.82),
      farA: noiseThreshold(1 / 3),
      farB: noiseThreshold(2 / 3),
    };
    // One great altar per boss, spread around the compass and far apart:
    // the first a good walk away, the rest deeper and deeper into the world.
    // The island boss may end up out at sea (its arena becomes an island).
    const start = hashInts(this.seed, 71) % 8;
    // (The far lands' bosses have no great altar: they rise at the lesser
    // altars of their own lands, so no old arena ever moves.)
    this.landmarks = data.bosses.filter((boss) => !boss.far).map((boss, i) => {
      const jitter = ((hashInts(this.seed, 72, i) % 1000) / 1000 - 0.5) * 0.5;
      const angle0 = ((start + i * 2 + (i >= 2 ? 1 : 0)) % 8) * (Math.PI / 4) + jitter;
      const dist = BOSS_DISTANCES[i] ?? 150 + 140 * i;
      // Arenas stand on the mainland: nudge each around the circle (and a
      // little in or out) until it is on dry ground. Islanders may stay at sea.
      let angle = angle0;
      let r = dist;
      if (boss.biome !== 'isles' && !this.#dryArena(Math.cos(angle) * r, Math.sin(angle) * r)) {
        search: for (const dd of [0, 30, -30, 60]) {
          for (let k = 1; k < 50; k++) {
            const a = angle0 + Math.ceil(k / 2) * 0.13 * (k % 2 ? 1 : -1);
            if (this.#dryArena(Math.cos(a) * (dist + dd), Math.sin(a) * (dist + dd))) {
              angle = a;
              r = dist + dd;
              break search;
            }
          }
        }
      }
      return {
        bossId: boss.id, biome: boss.biome,
        x: Math.round(Math.cos(angle) * r) + 0.5, y: Math.round(Math.sin(angle) * r) + 0.5,
      };
    });
    // One sure region of each far land, in its own direction a long walk
    // out (more grow here and there beyond it).
    this.farRegions = this.#placeFarRegions(start);
    this.altarCache = new Map();
    this.siteCache = new Map();
    // One market is guaranteed within reach, in a direction no boss uses.
    this.marketCache = new Map();
    const [fx, fy] = COMPASS[(start + 1) % 8];
    this.firstMarket = this.#makeMarket('m:first', Math.round(fx * 100), Math.round(fy * 100), hashInts(this.seed, 0xf125));
    // And a first village a short walk away, in a cell of its own.
    this.villageLayouts = new Map();
    const marketCell = `${Math.floor(this.firstMarket.x / MARKET_CELL)},${Math.floor(this.firstMarket.y / MARKET_CELL)}`;
    for (let k = 0; k < 8 && !this.firstVillage; k++) {
      const [vx, vy] = COMPASS[(start + 4 + k) % 8];
      const x = Math.round(vx * 78);
      const y = Math.round(vy * 78);
      const cell = `${Math.floor(x / MARKET_CELL)},${Math.floor(y / MARKET_CELL)}`;
      if (cell === marketCell || this.#nearLandmark(x, y, LANDMARK_RADIUS + VILLAGE_RADIUS + 4)) continue;
      this.firstVillage = this.#makeVillage('v:first', x, y, hashInts(this.seed, 0x7111));
    }
  }

  #makeVillage(id, x, y, h) {
    const biome = this.biomeAt(x, y);
    const stone = ['highlands', 'snow', 'void', 'volcanic'].includes(biome.id) || ((h >>> 5) & 3) === 0;
    return {
      id, x, y, seed: h, village: true, layout: 'village', r: VILLAGE_RADIUS,
      material: stone ? 'stone' : 'wood',
      color: VILLAGE_COLORS[(h >>> 8) % VILLAGE_COLORS.length],
      name: VILLAGE_NAMES[(h >>> 12) % VILLAGE_NAMES.length],
      biome: biome.id,
    };
  }

  /** A village's plan (houses, paths, people), worked out once. */
  villageLayout(m) {
    let layout = this.villageLayouts.get(m.id);
    if (!layout) {
      layout = villageLayout(m);
      this.villageLayouts.set(m.id, layout);
    }
    return layout;
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
    if (this.town && mx === TOWN_MARKET_CELL && my === TOWN_MARKET_CELL) return this.town;
    const key = `${mx},${my}`;
    if (this.marketCache.has(key)) return this.marketCache.get(key);
    let m = null;
    const f = this.firstMarket;
    const v = this.firstVillage;
    if (Math.floor(f.x / MARKET_CELL) === mx && Math.floor(f.y / MARKET_CELL) === my) {
      m = f;
    } else if (v && Math.floor(v.x / MARKET_CELL) === mx && Math.floor(v.y / MARKET_CELL) === my) {
      m = v;
    } else {
      const h = hashInts(this.seed, mx, my, 0x3a7e7);
      const roll = (h % 1000) / 1000;
      if (roll < MARKET_CHANCE + VILLAGE_CHANCE) {
        const village = roll >= MARKET_CHANCE;
        // (Markets keep the spots they always had; villages, bigger, stay further from the cell's edges.)
        const edge = village ? 24 : 20;
        const x = mx * MARKET_CELL + edge + ((h >>> 10) % (MARKET_CELL - edge * 2));
        const y = my * MARKET_CELL + edge + ((h >>> 20) % (MARKET_CELL - edge * 2));
        const farFromCamp = x * x + y * y > (village ? 120 : 150) ** 2;
        const clear = !this.landmarks.some((lm) => (lm.x - x) ** 2 + (lm.y - y) ** 2 < 50 * 50);
        // Markets and villages stand on solid ground, never on a beach or an island.
        const dry = clear && (village
          ? [0, 10, VILLAGE_RADIUS + 4].every((rr) => Array.from({ length: rr ? 16 : 1 }, (_, k) => k).every((k) => {
            const a = (k / 16) * Math.PI * 2;
            return this.seaAt(x + Math.cos(a) * rr, y + Math.sin(a) * rr) === SEA.LAND;
          }))
          : [[0, 0], ...COMPASS].every(([dx, dy]) => this.seaAt(x + dx * 12, y + dy * 12) === SEA.LAND));
        if (farFromCamp && dry) m = village ? this.#makeVillage(`m:${key}`, x, y, h) : this.#makeMarket(`m:${key}`, x, y, h);
      }
    }
    this.marketCache.set(key, m);
    return m;
  }

  // --- Lesser altars ------------------------------------------------------------------

  /** The lesser altar in a world cell, or null (deterministic per seed). */
  altarForCell(ax, ay) {
    const key = `${ax},${ay}`;
    if (this.altarCache.has(key)) return this.altarCache.get(key);
    let altar = null;
    const h = hashInts(this.seed, ax, ay, 0xa17a2);
    if ((h % 1000) / 1000 < ALTAR_CHANCE) {
      const x = ax * ALTAR_CELL + 30 + ((h >>> 10) % (ALTAR_CELL - 60)) + 0.5;
      const y = ay * ALTAR_CELL + 30 + ((h >>> 20) % (ALTAR_CELL - 60)) + 0.5;
      const far = x * x + y * y > 210 * 210;
      const clear = far && !this.landmarks.some((lm) => (lm.x - x) ** 2 + (lm.y - y) ** 2 < 70 * 70);
      // On dry ground (mainland or a big enough island), away from markets.
      const dry = clear && [[0, 0], ...COMPASS].every(([dx, dy]) => this.seaAt(x + dx * 7, y + dy * 7) < SEA.SHALLOW);
      if (dry && !this.marketAt(x, y, 14)) {
        // The guardian belongs to the land around it.
        const biome = this.biomeAt(Math.floor(x), Math.floor(y));
        const local = this.data.bosses.filter((b) => b.biome === biome.id);
        const list = local.length ? local : this.data.bosses.filter((b) => !b.far);
        altar = { key: `a:c${key}`, x, y, bossId: list[(h >>> 4) % list.length].id, lesser: true };
      }
    }
    this.altarCache.set(key, altar);
    return altar;
  }

  // --- Sites to explore ------------------------------------------------------------------

  /**
   * The site in a world cell, or null: a watchtower, ruins, an old mine or a
   * runestone (deterministic per world, cheap: no terrain is generated).
   * The object itself stands on the nearest open tile when its chunk is made.
   */
  siteForCell(sx, sy) {
    const key = `${sx},${sy}`;
    if (this.siteCache.has(key)) return this.siteCache.get(key);
    let site = null;
    const h = hashInts(this.objSeed, sx, sy, 0x5173);
    if ((h % 1000) / 1000 < SITE_CHANCE) {
      const x = sx * SITE_CELL + 10 + ((h >>> 10) % (SITE_CELL - 20)) + 0.5;
      const y = sy * SITE_CELL + 10 + ((h >>> 20) % (SITE_CELL - 20)) + 0.5;
      const far = x * x + y * y > 70 * 70;
      const land = far && this.seaAt(x, y) <= SEA.ISLE && !this.#nearLandmark(x, y, LANDMARK_RADIUS + 6);
      if (land && !this.marketAt(x, y, 8) && !this.altarsNear(x, y, 14).length) {
        const roll = (h >>> 4) % 100;
        const type = roll < 28 ? 'runestone' : roll < 54 ? 'tower' : roll < 80 ? 'ruins' : 'mine';
        site = { type, key: `site:${key}`, x, y, site: true };
      }
    }
    this.siteCache.set(key, site);
    return site;
  }

  /** Sites within `range` tiles of (x, y) (where the cells say they are). */
  sitesNear(x, y, range) {
    const out = [];
    for (let sy = Math.floor((y - range) / SITE_CELL); sy <= Math.floor((y + range) / SITE_CELL); sy++) {
      for (let sx = Math.floor((x - range) / SITE_CELL); sx <= Math.floor((x + range) / SITE_CELL); sx++) {
        const s = this.siteForCell(sx, sy);
        if (s && (s.x - x) ** 2 + (s.y - y) ** 2 <= range * range) out.push(s);
      }
    }
    return out;
  }

  /** Lesser altars within `range` tiles of (x, y). */
  altarsNear(x, y, range) {
    const out = [];
    for (let ay = Math.floor((y - range) / ALTAR_CELL); ay <= Math.floor((y + range) / ALTAR_CELL); ay++) {
      for (let ax = Math.floor((x - range) / ALTAR_CELL); ax <= Math.floor((x + range) / ALTAR_CELL); ax++) {
        const a = this.altarForCell(ax, ay);
        if (a && (a.x - x) ** 2 + (a.y - y) ** 2 <= range * range) out.push(a);
      }
    }
    return out;
  }

  /** The great altars, one per boss, as altar objects. */
  greatAltars() {
    return this.landmarks.map((lm) => ({ key: `a:${lm.bossId}`, x: lm.x, y: lm.y, bossId: lm.bossId, lesser: false }));
  }

  /** Every altar (great and lesser) within `range` tiles. */
  allAltarsNear(x, y, range) {
    const great = this.greatAltars().filter((a) => (a.x - x) ** 2 + (a.y - y) ** 2 <= range * range);
    return [...great, ...this.altarsNear(x, y, range)];
  }

  /** Markets whose area comes within `range` tiles of (x, y). */
  marketsNear(x, y, range) {
    const out = [];
    // A village's grounds can reach past its own cell (the first one sits on a cell's edge).
    const reach = range + VILLAGE_RADIUS + 3;
    const m0x = Math.floor((x - reach) / MARKET_CELL);
    const m1x = Math.floor((x + reach) / MARKET_CELL);
    const m0y = Math.floor((y - reach) / MARKET_CELL);
    const m1y = Math.floor((y + reach) / MARKET_CELL);
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
    if (id === 'v:first') return this.firstVillage ?? null;
    if (id === 'town') return this.town;
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
    const sea = this.seaAt(Math.floor(x) + 0.5, Math.floor(y) + 0.5);
    if (sea === SEA.ISLE || sea === SEA.ISLE_BEACH) return this.biomeById.get('isles') ?? this.biomes[0];
    if (this.gen >= 2 && d2 > FAR_MIN * FAR_MIN) {
      const far = this.#farBiome(x, y, Math.sqrt(d2));
      if (far) return far;
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

  /**
   * The far lands: Prism Barrens, Mireglass Fen and Skyreach grow in big
   * regions far from the camp (null elsewhere). A kind that is newer than
   * the world, or newer than where it would grow was first seen, doesn't.
   */
  #farBiome(x, y, dist) {
    const s = this.seed;
    const q = this.q;
    let id = null;
    for (const r of this.farRegions) {
      const dx = x - r.x;
      const dy = y - r.y;
      const edge = r.r + (valueNoise(s ^ 0x6e72, x / 14, y / 14) - 0.5) * 18;
      if (dx * dx + dy * dy < edge * edge) {
        id = r.id;
        break;
      }
    }
    if (!id) {
      const e = fbm(s ^ 0x6e6e, x / 170, y / 170) + Math.min(0.05, (dist - FAR_MIN) / 4000);
      if (e < q.far) return null;
      const k = fbm(s ^ 0x6e70, x / 360, y / 360);
      id = k < q.farA ? 'prism' : k < q.farB ? 'fen' : 'skyreach';
    }
    const b = this.biomeById.get(id);
    if (!b || (b.gen ?? 2) > this.gen) return null;
    if (this.legacy.size) {
      const seenIn = this.legacy.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
      if (seenIn !== undefined && seenIn < (b.gen ?? 2)) return null;
    }
    return b;
  }

  /** The sure far-land regions: one of each kind, in directions of their own, on the mainland. */
  #placeFarRegions(start) {
    const out = [];
    const kinds = ['prism', 'fen', 'skyreach'];
    kinds.forEach((id, i) => {
      const angle0 = ((start + 3 + i * 3) % 8) * (Math.PI / 4) + (((hashInts(this.seed, 0x6a1, i) % 1000) / 1000) - 0.5) * 0.4;
      const dist = 350 + (hashInts(this.seed, 0x6a2, i) % 60);
      let best = null;
      for (let k = 0; k < 24 && !best; k++) {
        const a = angle0 + Math.ceil(k / 2) * 0.12 * (k % 2 ? 1 : -1);
        const x = Math.round(Math.cos(a) * dist);
        const y = Math.round(Math.sin(a) * dist);
        const clear = this.landmarks.every((lm) => (lm.x - x) ** 2 + (lm.y - y) ** 2 > (LANDMARK_RADIUS + 70) ** 2);
        if (clear && this.#oceanValue(x, y) >= this.q.ocean + 0.03) best = { id, x, y, r: 46 };
      }
      if (best) out.push(best);
    });
    return out;
  }

  /**
   * Land or sea at (x, y): see SEA. Oceans are low-frequency blobs that
   * fade in beyond LAND_SAFE; islands dot the water; boss arenas stay dry.
   */
  seaAt(x, y) {
    const d2 = x * x + y * y;
    if (d2 < LAND_SAFE * LAND_SAFE) return SEA.LAND;
    let arena = Infinity;
    for (const lm of this.landmarks) arena = Math.min(arena, (x - lm.x) ** 2 + (y - lm.y) ** 2);
    if (arena < (LANDMARK_RADIUS - 3) ** 2) return SEA.LAND;
    const v = this.#oceanValue(x, y);
    const q = this.q;
    if (v >= q.ocean + 0.018) return SEA.LAND;
    if (v >= q.ocean) return SEA.BEACH;
    if (arena < LANDMARK_RADIUS * LANDMARK_RADIUS) return SEA.ISLE_BEACH; // an arena island's shore
    const iv = fbm(this.seed ^ 0x151a, x / 42, y / 42);
    if (iv > q.isle + 0.035) return SEA.ISLE;
    if (iv > q.isle) return SEA.ISLE_BEACH;
    // Deep water needs a real ship; the band along coasts, islands and
    // island arenas stays shallow enough for a raft.
    const nearShore = iv > q.isle - 0.07 || arena < (LANDMARK_RADIUS + 8) ** 2;
    return v < q.deep && !nearShore ? SEA.DEEP : SEA.SHALLOW;
  }

  /** Continent noise: below q.ocean is sea. Land is guaranteed near camp. */
  #oceanValue(x, y) {
    const s = this.seed;
    // The dry zone around camp has a ragged, noisy edge (never a circle).
    const d = Math.sqrt(x * x + y * y) - valueNoise(s ^ 0x0cee, x / 90, y / 90) * 110;
    const bias = Math.min(1, Math.max(0, (LAND_SAFE + LAND_FADE - d) / LAND_FADE)) * 0.5;
    return fbm(s ^ 0x0cea, x / 380, y / 380) * 0.8 + fbm(s ^ 0x0ced, x / 1400, y / 1400) * 0.2
      + (valueNoise(s ^ 0x0ceb, x / 15, y / 15) - 0.5) * 0.06 + bias;
  }

  /** A whole boss arena (and a margin) on the mainland? */
  #dryArena(x, y) {
    const q = this.q;
    if (this.#oceanValue(x, y) < q.ocean + 0.03) return false;
    for (const rr of [LANDMARK_RADIUS - 2, LANDMARK_RADIUS + 6]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        if (this.#oceanValue(x + Math.cos(a) * rr, y + Math.sin(a) * rr) < q.ocean + 0.03) return false;
      }
    }
    return true;
  }

  /** True for sea water (not lakes) on the tile containing (x, y). */
  isSea(x, y) {
    return this.seaAt(Math.floor(x) + 0.5, Math.floor(y) + 0.5) >= SEA.SHALLOW;
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
    const altars = this.altarsNear(cx * CHUNK + CHUNK / 2, cy * CHUNK + CHUNK / 2, CHUNK + ALTAR_CLEAR + 2);
    const nearAltar = (x, y) => altars.some((a) => (a.x - x) ** 2 + (a.y - y) ** 2 < ALTAR_CLEAR * ALTAR_CLEAR);
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
        // A dirt road leads south out of the camp's open side.
        if (Math.abs(x) <= 1 && y > 0 && y < CAMP_CLEAR + 6) {
          ground[i] = T.PATH;
          continue;
        }
        // Tiles are classified at their centre (the same point every other check uses).
        const sea = d2 < LAND_SAFE * LAND_SAFE ? SEA.LAND : this.seaAt(x + 0.5, y + 0.5);
        if (sea >= SEA.SHALLOW) {
          ground[i] = T.SAND;
          block[i] = sea === SEA.DEEP ? T.DEEP : T.SEA;
          continue;
        }
        if (sea === SEA.BEACH || sea === SEA.ISLE_BEACH) {
          ground[i] = tileHash(s, x, y, 91) < 0.3 ? T.SAND2 : T.SAND;
          // A few palms lean over island beaches.
          if (sea === SEA.ISLE_BEACH && tileHash(s, x, y, 92) < 0.05 && !this.#nearLandmark(x, y, 6)) block[i] = T.PALM;
          continue;
        }
        // Market grounds: paved inside, cleared around the walls. A village keeps
        // its grass, with dirt paths between the houses and the green.
        const market = markets.find((m) => (m.x - x) ** 2 + (m.y - y) ** 2 <= (m.r + 3) ** 2);
        if (market?.village) {
          const paths = this.villageLayout(market).paths;
          const detail = fbm(s ^ 0x4444, x / 6, y / 6);
          ground[i] = paths.has(`${x - market.x},${y - market.y}`) ? T.PATH : GROUND_BY_NAME[detail > this.q.detail ? b.alt : b.ground] ?? T.GRASS;
          continue;
        }
        if (market) {
          const inner = (market.x - x) ** 2 + (market.y - y) ** 2 <= (market.r - 0.5) ** 2;
          ground[i] = inner ? (market.material === 'stone' ? T.CAMP : T.PATH) : GROUND_BY_NAME[b.ground] ?? T.GRASS;
          continue;
        }
        const detail = fbm(s ^ 0x4444, x / 6, y / 6);
        ground[i] = GROUND_BY_NAME[detail > this.q.detail ? b.alt : b.ground] ?? T.GRASS;
        if (d2 < CAMP_CLEAR * CAMP_CLEAR) continue; // keep the camp surroundings open
        if (this.#nearLandmark(x, y, 4) || nearAltar(x + 0.5, y + 0.5)) continue; // keep arenas open
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
    // cut: trees and rocks cut down here (tile index → [time, tile id]), drawn growing back.
    const chunk = { cx, cy, ground, block, biomeIdx, objects: [], canvas: null, cut: new Map(), grown: '' };
    // Trees and rocks the player has cut down stay gone (until they regrow).
    for (let i = 0; i < block.length; i++) {
      if (!block[i] || LIQUID.has(block[i])) continue;
      const x = cx * CHUNK + (i % CHUNK);
      const y = cy * CHUNK + ((i / CHUNK) | 0);
      const entry = this.harvested[`${x},${y}`];
      if (entry) {
        block[i] = 0;
        chunk.cut.set(i, entry);
      }
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
      const h = hashInts(this.objSeed, chunk.cx, chunk.cy, salt, attempt);
      const lx = 1 + (h % (CHUNK - 2));
      const ly = 1 + ((h >>> 8) % (CHUNK - 2));
      const i = ly * CHUNK + lx;
      const x = chunk.cx * CHUNK + lx + 0.5;
      const y = chunk.cy * CHUNK + ly + 0.5;
      // Nothing spawns inside a market's walls or on the camp grounds.
      if (x * x + y * y < CAMP_CLEAR * CAMP_CLEAR) continue;
      if (!chunk.block[i] && !this.marketAt(x, y, 2)) return { x, y };
    }
    return null;
  }

  #placeObjects(chunk) {
    const { cx, cy } = chunk;
    const key = `${cx},${cy}`;
    const r = hashInts(this.objSeed, cx, cy, 0xb0b) / 4294967296;
    const far = cx * cx + cy * cy > 1 && !this.hideObjects;
    for (const b of this.data.base?.buildings ?? []) {
      if (this.townBuildings && !this.townBuildings.includes(b.id)) continue;
      if (Math.floor(b.x / CHUNK) === cx && Math.floor(b.y / CHUNK) === cy) {
        chunk.objects.push({ type: 'building', key: `b:${b.id}`, buildingId: b.id, x: b.x, y: b.y });
      }
    }
    for (const lm of this.landmarks) {
      if (Math.floor(lm.x / CHUNK) === cx && Math.floor(lm.y / CHUNK) === cy) {
        chunk.objects.push({ type: 'altar', key: `a:${lm.bossId}`, x: lm.x, y: lm.y, bossId: lm.bossId, lesser: false });
      }
    }
    for (const a of this.altarsNear(cx * CHUNK + CHUNK / 2, cy * CHUNK + CHUNK / 2, CHUNK)) {
      if (Math.floor(a.x / CHUNK) === cx && Math.floor(a.y / CHUNK) === cy) chunk.objects.push({ type: 'altar', ...a });
    }
    if (far && r < 0.3) {
      const p = this.#freeTileIn(chunk, 1);
      if (p) chunk.objects.push({ type: 'chest', key: `c:${key}`, ...p });
    }
    if (far && r > 0.93) {
      const p = this.#freeTileIn(chunk, 2);
      if (p) chunk.objects.push({ type: 'shrine', key: `s:${key}`, ...p });
    }
    if (far) this.#placeSites(chunk);
    if (far) this.#placeCuriosities(chunk);
  }

  /** A site whose cell puts it in this chunk stands on the nearest open tile. */
  #placeSites(chunk) {
    const { cx, cy } = chunk;
    for (const s of this.sitesNear(cx * CHUNK + CHUNK / 2, cy * CHUNK + CHUNK / 2, CHUNK)) {
      if (Math.floor(s.x / CHUNK) !== cx || Math.floor(s.y / CHUNK) !== cy) continue;
      const lx0 = Math.floor(s.x) - cx * CHUNK;
      const ly0 = Math.floor(s.y) - cy * CHUNK;
      let spot = null;
      for (let r = 0; r <= 3 && !spot; r++) {
        for (let dy = -r; dy <= r && !spot; dy++) {
          for (let dx = -r; dx <= r && !spot; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const lx = lx0 + dx;
            const ly = ly0 + dy;
            if (lx < 1 || ly < 1 || lx >= CHUNK - 1 || ly >= CHUNK - 1) continue;
            if (!chunk.block[ly * CHUNK + lx]) spot = { x: cx * CHUNK + lx + 0.5, y: cy * CHUNK + ly + 0.5 };
          }
        }
      }
      if (spot) chunk.objects.push({ ...s, ...spot });
    }
  }

  /** Small points of interest (see discoveries.js) and island content. */
  #placeCuriosities(chunk) {
    const { cx, cy } = chunk;
    const roll = (salt) => hashInts(this.objSeed, cx, cy, salt) / 4294967296;
    const put = (type, p, extra = {}) => p && chunk.objects.push({ type, key: `poi:${type}:${cx},${cy}`, ...p, ...extra });
    const tileSea = (i) => this.seaAt(cx * CHUNK + (i % CHUNK) + 0.5, cy * CHUNK + ((i / CHUNK) | 0) + 0.5);
    const where = (salt, pred) => this.#freeTileWhere(chunk, salt, pred);
    const island = [[4, 4], [12, 4], [8, 8], [4, 12], [12, 12]].some(([lx, ly]) => this.seaAt(cx * CHUNK + lx, cy * CHUNK + ly) === SEA.ISLE);
    if (island) {
      // Island chests are richer.
      for (const o of chunk.objects) if (o.type === 'chest') o.rich = true;
      // Treasure first (its spot is fixed), so nothing else lands on it.
      const t = this.treasureAt(cx, cy);
      const ti = t ? (t.ty - cy * CHUNK) * CHUNK + (t.tx - cx * CHUNK) : -1;
      if (t && this.sharedTerrain) {
        // Multiplayer: buried only where the ground is already open.
        if (!chunk.block[ti]) chunk.objects.push(t);
      } else if (t) {
        chunk.block[ti] = 0;
        chunk.objects.push(t);
      }
      if (roll(0x1d0) < 0.3) put('idol', where(0x1d1, (i) => tileSea(i) === SEA.ISLE));
      if (roll(0x3ec) < 0.2) put('wreck', where(0x3ed, (i) => tileSea(i) === SEA.ISLE_BEACH));
      return;
    }
    const beach = (i) => tileSea(i) === SEA.BEACH;
    if (roll(0xb0e) < 0.06) put('bones', where(0xb0f, () => true));
    if (roll(0x519) < 0.035) put('signpost', where(0x51a, () => true));
    if (roll(0xc4a) < 0.03) put('camp', where(0xc4b, () => true));
    const biome = this.biomeAt(cx * CHUNK + 8, cy * CHUNK + 8).id;
    if (['forest', 'void', 'plains', 'snow'].includes(biome) && roll(0x3a5) < 0.04) put('mushrooms', where(0x3a6, () => true));
    if (roll(0xb07) < 0.25) put('bottle', where(0xb08, beach));
    if (roll(0x3e0) < 0.06) put('wreck', where(0x3e1, beach));
  }

  #freeTileWhere(chunk, salt, pred) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const h = hashInts(this.objSeed, chunk.cx, chunk.cy, salt, attempt);
      const lx = 1 + (h % (CHUNK - 2));
      const ly = 1 + ((h >>> 8) % (CHUNK - 2));
      const i = ly * CHUNK + lx;
      if (chunk.block[i] || !pred(i)) continue;
      const x = chunk.cx * CHUNK + lx + 0.5;
      const y = chunk.cy * CHUNK + ly + 0.5;
      if (this.marketAt(x, y, 2) || this.#nearLandmark(x, y, LANDMARK_RADIUS)) continue;
      if (chunk.objects.some((o) => Math.abs(o.x - x) < 2 && Math.abs(o.y - y) < 2)) continue;
      return { x, y };
    }
    return null;
  }

  /**
   * Buried treasure in chunk (cx, cy), or null. Analytic (no chunk needed),
   * so a message in a bottle can point at one far away.
   */
  treasureAt(cx, cy) {
    const h = hashInts(this.objSeed, cx, cy, 0x7e5);
    if (h / 4294967296 >= 0.5) return null;
    const tx = cx * CHUNK + 3 + ((h >>> 4) % 10);
    const ty = cy * CHUNK + 3 + ((h >>> 12) % 10);
    if (this.seaAt(tx + 0.5, ty + 0.5) !== SEA.ISLE) return null;
    return { type: 'treasure', key: `poi:treasure:${cx},${cy}`, x: tx + 0.5, y: ty + 0.5, tx, ty };
  }

  getChunk(cx, cy) {
    // Most lookups ask for the same chunk as the one before (collision
    // checks walk neighbouring tiles): skip building the key for those.
    const last = this.lastChunk;
    if (last && last.cx === cx && last.cy === cy) {
      last.lastUsed = this.frame ?? 0;
      return last;
    }
    const key = `${cx},${cy}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = this.#generateChunk(cx, cy);
      this.chunks.set(key, chunk);
    }
    chunk.lastUsed = this.frame ?? 0;
    this.lastChunk = chunk;
    return chunk;
  }

  /** Drops chunks that haven't been touched recently. */
  prune(frame) {
    this.frame = frame;
    if (this.chunks.size <= this.maxChunks) return;
    const sorted = [...this.chunks.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - this.maxChunks; i++) {
      if (sorted[i][1] === this.lastChunk) this.lastChunk = null;
      this.chunks.delete(sorted[i][0]);
    }
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

  groundAt(tx, ty) {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    const chunk = this.getChunk(cx, cy);
    return chunk.ground[(ty - cy * CHUNK) * CHUNK + (tx - cx * CHUNK)];
  }

  isSolid(tx, ty) {
    return this.blockAt(tx, ty) !== 0;
  }

  /** Does a tree, rock or the like stand at (x, y)? Only its trunk or stone (PROP_SHAPE), not its whole tile. */
  propAt(x, y) {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const shape = PROP_SHAPE.get(this.blockAt(tx, ty));
    if (!shape) return false;
    const dx = x - (tx + 0.5);
    const dy = y - (ty + shape[1]);
    return dx * dx + dy * dy < shape[0] * shape[0];
  }

  structureAt(tx, ty) {
    return this.structures.size ? this.structures.get(tileKey(tx, ty)) ?? null : null;
  }

  floorAt(tx, ty) {
    return this.floors.size ? this.floors.get(tileKey(tx, ty)) ?? null : null;
  }

  /**
   * Whether a tile blocks movement. Modes: 'player' (gates open for you),
   * 'enemy' (every solid structure blocks), 'fly' (flies over trees and
   * rocks, but never over water, lava or walls), 'boat' / 'raft'
   * (water only; rafts not on deep sea) and 'swim' / 'deepswim' (sea
   * creatures: the sea, or only the deep sea).
   */
  blockedFor(tx, ty, mode = 'player') {
    let b = this.blockAt(tx, ty);
    // A floor on shallow water is a bridge: walkers cross it, boats and fish don't.
    if (this.floors.size && BRIDGEABLE.has(b) && this.floors.has(tileKey(tx, ty))) {
      if (mode === 'boat' || mode === 'raft' || mode === 'swim' || mode === 'deepswim') return true;
      b = 0;
    }
    // Boats float on water only; a raft stays out of the deep sea.
    if (mode === 'boat') return !SAILABLE.has(b);
    if (mode === 'raft') return !SAILABLE.has(b) || b === T.DEEP;
    // Sea creatures: sharks swim anywhere in the sea, serpents only in the deep.
    if (mode === 'swim') return b !== T.SEA && b !== T.DEEP;
    if (mode === 'deepswim') return b !== T.DEEP;
    // Flyers (and pals, who slip through the undergrowth) pass trees and rocks;
    // so do horses, jumping them.
    if (b && ((mode !== 'fly' && mode !== 'pal' && mode !== 'horse') || LIQUID.has(b))) return true;
    if (!this.structures.size) return false;
    const st = this.structures.get(tileKey(tx, ty));
    if (!st || st.def.walkable) return false;
    if (st.def.kind === 'gate' && (mode === 'player' || mode === 'pal' || mode === 'horse')) {
      // Multiplayer: a clan's gates open only for its own members (a market's for everyone).
      return this.gateFilter && !st.marketId ? !this.gateFilter(st) : false;
    }
    return true;
  }

  /** True if a circle of radius r at (x, y) overlaps nothing that blocks `mode`. */
  isFree(x, y, r, mode = 'player') {
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r);
    const y1 = Math.floor(y + r);
    // Walkers only bump into the trunk or foot of a tree or rock (see
    // PROP_SHAPE); water, lava and walls block their whole tile. Only
    // +, * and comparisons: client and server agree bit for bit.
    const props = mode === 'player' || mode === 'enemy';
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.blockedFor(tx, ty, mode)) continue;
        const shape = props ? PROP_SHAPE.get(this.blockAt(tx, ty)) : undefined;
        if (shape) {
          const dx = x - (tx + 0.5);
          const dy = y - (ty + shape[1]);
          const rr = r + shape[0];
          if (dx * dx + dy * dy >= rr * rr) continue;
        }
        return false;
      }
    }
    return true;
  }

  // --- Harvesting ------------------------------------------------------------------

  #setBlock(tx, ty, id, cut = null) {
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    const chunk = this.getChunk(cx, cy);
    const i = (ty - cy * CHUNK) * CHUNK + (tx - cx * CHUNK);
    chunk.block[i] = id;
    if (cut) chunk.cut.set(i, cut);
    else chunk.cut.delete(i);
    chunk.canvas = null; // re-render
    // Crowns, shadows and shade reach across chunk edges (the rich style): the neighbours too.
    const lx = tx - cx * CHUNK;
    const ly = ty - cy * CHUNK;
    if (lx === 0 || ly === 0 || lx === CHUNK - 1 || ly === CHUNK - 1) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const n = this.chunks.get(`${cx + dx},${cy + dy}`);
          if (n) n.canvas = null;
        }
      }
    }
  }

  /** Removes a tree/rock and remembers it. Returns the removed tile id. */
  removeBlock(tx, ty, now = Date.now()) {
    const id = this.blockAt(tx, ty);
    if (!id || LIQUID.has(id)) return 0;
    const entry = [now, id];
    this.harvested[`${tx},${ty}`] = entry;
    this.#setBlock(tx, ty, 0, entry);
    return id;
  }

  /** Puts a harvested blocker back (regrowth). */
  restoreBlock(tx, ty) {
    const entry = this.harvested[`${tx},${ty}`];
    if (!entry) return;
    delete this.harvested[`${tx},${ty}`];
    if (this.chunks.has(`${Math.floor(tx / CHUNK)},${Math.floor(ty / CHUNK)}`)) this.#setBlock(tx, ty, entry[1]);
  }

  /**
   * How far a cut tree or rock has grown back: 0 (a stump or rubble) to 3
   * (nearly grown), or -1 where the ground stays cleared. It grows in four
   * steps over its regrow time (gathering.harvest → regrowMinutes).
   */
  growthStage(tx, ty, entry, now = Date.now()) {
    if (this.noRegrow?.(tx, ty)) return -1;
    const info = this.data.gathering?.harvest?.[BLOCKER_NAME[entry[1]]];
    const total = (info?.regrowMinutes ?? 20) * 60000;
    return Math.max(0, Math.min(3, Math.floor((4 * (now - entry[0])) / total)));
  }

  #growthSig(chunk, now, out = null) {
    let sig = '';
    for (const [i, entry] of chunk.cut) {
      const stage = this.growthStage(chunk.cx * CHUNK + (i % CHUNK), chunk.cy * CHUNK + ((i / CHUNK) | 0), entry, now);
      if (out && stage >= 0) out.push([i, entry[1], stage]);
      sig += stage + 1;
    }
    return sig;
  }

  /** What grows on a chunk's cut tiles, to draw: [[tile index, tile id, stage]]. */
  growthOf(chunk, now = Date.now()) {
    const out = [];
    chunk.grown = chunk.cut?.size ? this.#growthSig(chunk, now, out) : '';
    return out;
  }

  /** Redraws the chunks whose saplings grew a step since they were drawn (call every few seconds). */
  refreshGrowth(now = Date.now()) {
    for (const chunk of this.chunks.values()) {
      if (!chunk.canvas || !chunk.cut.size) continue;
      if (this.#growthSig(chunk, now) !== chunk.grown) chunk.canvas = null;
    }
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
