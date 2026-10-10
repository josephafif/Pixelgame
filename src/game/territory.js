// Territories: the world is cut into squares (data.army.territory.size
// tiles across, centred so the camp sits in the middle of its own). Every
// square with dry land has an outpost on a fixed spot: a palisade with a
// gap to walk in and a flag in the middle. Beat its defenders and hold the
// flag to take it; it pays a little every hour and your squads can hold it.
// A long front is harder to hold. Pure functions, shared by single player
// and the server.

import { hashInts } from '../core/rng.js';
import { LIQUID, T, SEA, LANDMARK_RADIUS, tileKey } from './world.js';
import { structureDef } from './construction.js';

export const TERRITORY_DEFAULTS = {
  size: 96, captureSeconds: 20, captureRadius: 4.5, incomePerTier: { scrap: 5, essence: 3 }, frontierPenaltyPct: 6,
  raidEveryMinutes: 20, maxOwned: 16,
};

/** The palisade, its flag: structures only outposts have (never in the build menu). */
export const OUTPOST_DEFS = {
  palisade: { id: 'palisade', name: 'Palisade', kind: 'wall', hp: 999 },
  outpost_flag: { id: 'outpost_flag', name: 'Outpost flag', kind: 'decor', hp: 999 },
};

const HALF = 4; // the palisade runs 4 tiles out from the flag (a 9 × 9 square)
const SEARCH = 30; // how far from a square's middle its outpost may stand

export function territoryConfig(data) {
  return { ...TERRITORY_DEFAULTS, ...(data?.army?.territory ?? {}) };
}

export function territoryKey(tx, ty) {
  return `${tx},${ty}`;
}

export function parseKey(key) {
  const [tx, ty] = String(key).split(',').map(Number);
  return { tx, ty };
}

/** The square (tx, ty) a tile lies in. */
export function territoryAt(data, x, y) {
  const size = territoryConfig(data).size;
  return { tx: Math.floor((x + size / 2) / size), ty: Math.floor((y + size / 2) / size) };
}

/** Squares sharing a side with (tx, ty). */
export function neighbours(tx, ty) {
  return [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]];
}

/** 1 (close to the camp) … 5 (far out): stronger defenders, more income. */
export function tierAt(x, y) {
  const level = 1 + Math.floor(Math.sqrt(x * x + y * y) / 40);
  return Math.max(1, Math.min(5, 1 + Math.floor((level - 1) / 3)));
}

const siteCache = new WeakMap();

function badTile(world, x, y) {
  const b = world.blockAt(x, y);
  return LIQUID.has(b) || b === T.SKY || world.seaAt(x, y) !== SEA.LAND;
}

/** Can an outpost stand with its flag on tile (fx, fy)? */
function siteOk(world, fx, fy) {
  if (fx * fx + fy * fy < 70 * 70) return false; // never by the camp or the town
  for (const lm of world.landmarks ?? []) {
    if ((lm.x - fx) ** 2 + (lm.y - fy) ** 2 < (LANDMARK_RADIUS + 12) ** 2) return false;
  }
  if (world.marketsNear?.(fx, fy, 22)?.length) return false;
  if (world.altarsNear?.(fx, fy, 12)?.length) return false;
  // Dry ground everywhere inside, and under the palisade.
  for (let dy = -HALF; dy <= HALF; dy++) {
    for (let dx = -HALF; dx <= HALF; dx++) if (badTile(world, fx + dx, fy + dy)) return false;
  }
  return true;
}

/**
 * The outpost of square (tx, ty): { key, tx, ty, fx, fy (the flag's tile),
 * x, y (its centre), tier, biome }, or null (the camp's own square, open
 * sea, or nowhere dry enough). The same for everyone with the same world.
 */
export function outpostFor(world, data, tx, ty) {
  let cache = siteCache.get(world);
  if (!cache) siteCache.set(world, (cache = new Map()));
  const key = territoryKey(tx, ty);
  if (cache.has(key)) return cache.get(key);
  let site = null;
  if (tx !== 0 || ty !== 0) {
    const size = territoryConfig(data).size;
    const cx = tx * size;
    const cy = ty * size;
    for (let i = 0; i < 48 && !site; i++) {
      const h = hashInts(world.seed ?? 0, tx, ty, i, 0x7e2);
      const r = i === 0 ? 0 : 4 + (h % (SEARCH - 3));
      const a = ((h >>> 8) % 360) * (Math.PI / 180);
      const fx = Math.round(cx + Math.cos(a) * r);
      const fy = Math.round(cy + Math.sin(a) * r);
      if (siteOk(world, fx, fy)) {
        site = { key, tx, ty, fx, fy, x: fx + 0.5, y: fy + 0.5, tier: tierAt(fx, fy), biome: world.biomeAt(fx, fy)?.id ?? 'plains' };
      }
    }
  }
  cache.set(key, site);
  return site;
}

/**
 * The outpost's structures, relative to the flag: a palisade around a 9 × 9
 * square with a three-tile gap on the south side, torches inside and the
 * flag in the middle.
 */
export function outpostLayout() {
  const out = [{ id: 'outpost_flag', x: 0, y: 0 }];
  for (let i = -HALF; i <= HALF; i++) {
    out.push({ id: 'palisade', x: i, y: -HALF });
    if (Math.abs(i) > 1) out.push({ id: 'palisade', x: i, y: HALF });
    if (Math.abs(i) < HALF) {
      out.push({ id: 'palisade', x: -HALF, y: i });
      out.push({ id: 'palisade', x: HALF, y: i });
    }
  }
  for (const [x, y] of [[-3, -3], [3, -3]]) out.push({ id: 'torch', x, y });
  return out;
}

const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });

/**
 * Puts an outpost's palisade, torches and flag into the world (never on a
 * tree or a rock, never over something already there). Returns the
 * structures placed. Single player, the server and the multiplayer client
 * all place them the same way.
 */
export function placeOutpost(world, data, site, color) {
  const out = [];
  for (const s of outpostLayout()) {
    const def = OUTPOST_DEFS[s.id] ?? structureDef(data, s.id);
    if (!def) continue;
    const x = site.fx + s.x;
    const y = site.fy + s.y;
    if (world.blockAt(x, y)) continue;
    const layer = def.kind === 'floor' ? world.floors : world.structures;
    if (layer.has(tileKey(x, y))) continue;
    const st = { id: s.id, x, y, hp: def.hp, owner: 'outpost', outpost: site.key, color };
    hidden(st, 'def', def);
    hidden(st, 'rt', { cd: 0, aim: 0, flash: 0, trig: -9, open: 0 });
    layer.set(tileKey(x, y), st);
    out.push(st);
  }
  return out;
}

/** Takes an outpost's structures out of the world again. */
export function removeOutpost(world, structures) {
  for (const st of structures) {
    const layer = st.def.kind === 'floor' ? world.floors : world.structures;
    if (layer.get(tileKey(st.x, st.y)) === st) layer.delete(tileKey(st.x, st.y));
  }
}

/** An outpost in (or right by) a clan's claim lies dormant: no palisade, no guards, nothing to take. */
export function outpostDormant(site, claims, claimRadius) {
  const r = claimRadius + HALF + 3;
  return (claims ?? []).some((c) => (c.x - site.x) ** 2 + (c.y - site.y) ** 2 < r * r);
}

/** The monsters guarding a neutral outpost: [{ kind, elite }] (more and tougher further out). */
export function defendersFor(data, site) {
  const biome = data.byId.biomes.get(site.biome) ?? data.biomes[0];
  const kinds = biome.enemies.filter((id) => !data.byId.enemies.get(id)?.sea);
  const n = Math.min(7, 2 + site.tier);
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = hashInts(site.fx, site.fy, i, 0xd3f);
    out.push({ kind: kinds[h % kinds.length], elite: i === 0 && site.tier >= 2 });
  }
  return out;
}

/** World level at the outpost (how strong its monsters are). */
export function outpostLevel(site) {
  return 1 + Math.floor(Math.sqrt(site.fx * site.fx + site.fy * site.fy) / 40);
}

// --- Strength (the same numbers decide fights up close and far away) ----------------------------

/** One fighter's weight in a battle: hp and damage per second together. */
export function unitPower(hp, dps) {
  return Math.sqrt(Math.max(0, hp) * Math.max(0, dps));
}

/** What a group of monsters weighs (the defenders of an outpost, a counterattack). */
export function monsterPower(data, list, level) {
  const hpK = 1 + 0.3 * (level - 1);
  const dmgK = 1 + 0.14 * (level - 1);
  let sum = 0;
  for (const m of list) {
    const def = data.byId.enemies.get(m.kind);
    if (!def) continue;
    const elite = m.elite || def.elite ? 2.4 : 1;
    sum += unitPower(def.hp * hpK * elite, ((def.damage * dmgK) / 1.2) * (m.elite ? 1.4 : 1));
  }
  return sum;
}

/** Owned squares with a neighbour that isn't yours: the front. */
export function frontier(owned) {
  const set = owned instanceof Set ? owned : new Set(owned);
  let n = 0;
  for (const k of set) {
    const { tx, ty } = parseKey(k);
    if (neighbours(tx, ty).some(([x, y]) => !set.has(territoryKey(x, y)) && !(x === 0 && y === 0))) n++;
  }
  return n;
}

/** Defence multiplier for a square's garrison: walls help, a long front hurts. */
export function defenseFactor(data, ownedCount, frontierCount) {
  const cfg = territoryConfig(data);
  const penalty = Math.min(60, Math.max(0, frontierCount - 1) * cfg.frontierPenaltyPct) / 100;
  return 1.25 * (1 - penalty) + (ownedCount <= 1 ? 0.1 : 0);
}

/**
 * A fight decided far from anyone: attacker against defender power (and a
 * little luck). Returns { win, attackerLoss, defenderLoss } (shares 0..1 of
 * each side that falls).
 */
export function abstractBattle(attack, defense, rng = Math.random) {
  if (defense <= 0) return { win: true, attackerLoss: 0, defenderLoss: 1 };
  if (attack <= 0) return { win: false, attackerLoss: 1, defenderLoss: 0 };
  const roll = 0.85 + rng() * 0.3;
  const ratio = (attack * roll) / defense;
  const win = ratio >= 1;
  // The stronger side loses less; a close fight costs both sides a lot.
  const attackerLoss = win ? Math.min(0.9, 0.55 / ratio) : 1;
  const defenderLoss = win ? 1 : Math.min(0.9, 0.55 * ratio);
  return { win, attackerLoss, defenderLoss };
}

/** Capture progress for one step: friends at the flag and no foes fill it; foes drain it. */
export function stepCapture(progress, { friendly, hostile, dt, seconds }) {
  if (hostile && !friendly) return Math.max(0, progress - dt / seconds);
  if (friendly && !hostile) return Math.min(1, progress + dt / seconds);
  if (!friendly && !hostile) return Math.max(0, progress - dt / (seconds * 3));
  return progress; // contested: held where it is
}

/** What a square pays every hour. */
export function incomeFor(data, tier) {
  const per = territoryConfig(data).incomePerTier;
  const out = {};
  for (const [k, n] of Object.entries(per)) out[k] = Math.round(n * tier);
  return out;
}

/** The status of a square for the map: 'own', 'neutral', 'foreign', 'contested', 'attacked'. */
export function territoryStatus(entry, mine) {
  if (!entry?.owner) return entry?.capture > 0 ? 'contested' : 'neutral';
  if (entry.attackedUntil > (entry.now ?? 0)) return 'attacked';
  return entry.owner === mine ? 'own' : 'foreign';
}
