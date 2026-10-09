// Horses: small wild herds here and there in the world (not easy to find:
// a few in each big region). Walk up to one and press Use to ride it. On
// horseback you are much faster and you jump over trees and rocks (not over
// water or walls). Press Use again to get off. Leave a horse in your camp
// (single player) or your clan's base (multiplayer) and it stays there for
// good; left anywhere else, it wanders off after a while if you go away.
//
// Pure rules shared by single player, the server and the client.

import { hashInts, createRng } from '../core/rng.js';
import { SEA } from './world.js';

/**
 * Breeds, from common to rare. speed: tiles per second at a trot; gallop:
 * how much faster when you sprint; hp: extra health while you ride (a sturdy
 * horse takes some of the blows).
 */
export const BREEDS = [
  { id: 'pony', name: 'Pony', sv: 'Ponny', speed: 6.0, gallop: 1.25, hp: 10, coat: '#c8945a', mane: '#5b3a21', biomes: ['plains', 'forest', 'highlands'], weight: 40 },
  { id: 'fjord', name: 'Fjord Horse', sv: 'Fjordhäst', speed: 6.6, gallop: 1.3, hp: 30, coat: '#dcc596', mane: '#3a3020', biomes: ['plains', 'highlands', 'snow', 'forest'], weight: 30 },
  { id: 'courser', name: 'Courser', sv: 'Fullblod', speed: 7.8, gallop: 1.4, hp: 5, coat: '#8a4f2a', mane: '#2a1a10', biomes: ['plains', 'desert', 'volcanic'], weight: 18 },
  { id: 'snow', name: 'Snow Mare', sv: 'Snösto', speed: 7.2, gallop: 1.35, hp: 25, coat: '#ece8de', mane: '#9ad0f0', biomes: ['snow'], weight: 8 },
  { id: 'shadow', name: 'Shadow Stallion', sv: 'Skugghingst', speed: 8.4, gallop: 1.4, hp: 35, coat: '#2c2640', mane: '#9a5cff', biomes: ['void', 'volcanic'], weight: 4 },
];
export const BREED_BY_ID = new Map(BREEDS.map((b) => [b.id, b]));

/** Movement mode on horseback (world.blockedFor): over trees and rocks, never over water or walls. */
export const HORSE_MODE = 'horse';
export const HORSE_RADIUS = 0.36;
export const MAX_HORSES = 6;
/** A horse left outside your camp or base runs off when you are this far away for this long. */
export const STRAY_RANGE = 70;
export const STRAY_SECONDS = 180;
/** A herd that lost a horse to a rider grows it back after this long. */
export const REGROW_MS = 45 * 60 * 1000;

const HERD_CELL = 150;
const HERD_CHANCE = 0.45;

const NAMES = ['Blixt', 'Stjärna', 'Molly', 'Freja', 'Saga', 'Storm', 'Pärla', 'Ronja', 'Tor', 'Vinter', 'Kanel', 'Skugga', 'Dimma', 'Siri', 'Bamse', 'Lotta', 'Viking', 'Ylva'];

/** A herd in a world cell, or null: { key, x, y, size, breeds: [breed ids] } (deterministic). */
export function herdForCell(world, hx, hy) {
  world.herdCache ??= new Map();
  const key = `${hx},${hy}`;
  if (world.herdCache.has(key)) return world.herdCache.get(key);
  let herd = null;
  const h = hashInts(world.objSeed ?? world.seed, hx, hy, 0x40125);
  if ((h % 1000) / 1000 < HERD_CHANCE) {
    const x = hx * HERD_CELL + 20 + ((h >>> 10) % (HERD_CELL - 40)) + 0.5;
    const y = hy * HERD_CELL + 20 + ((h >>> 20) % (HERD_CELL - 40)) + 0.5;
    const far = x * x + y * y > 90 * 90;
    if (far && world.seaAt(x, y) === SEA.LAND && !world.marketAt(x, y, 12)) {
      const biome = world.biomeAt(Math.floor(x), Math.floor(y)).id;
      const local = BREEDS.filter((b) => b.biomes.includes(biome));
      if (local.length) {
        const rng = createRng(h);
        const size = 1 + Math.floor(rng.next() * 3);
        const total = local.reduce((s, b) => s + b.weight, 0);
        const breeds = [];
        for (let i = 0; i < size; i++) {
          let r = rng.next() * total;
          let pick = local[0];
          for (const b of local) {
            if (r < b.weight) {
              pick = b;
              break;
            }
            r -= b.weight;
          }
          breeds.push(pick.id);
        }
        herd = { key: `herd:${key}`, x, y, size, breeds, biome };
      }
    }
  }
  world.herdCache.set(key, herd);
  return herd;
}

/** Herds within `range` tiles of (x, y). */
export function herdsNear(world, x, y, range) {
  const out = [];
  for (let hy = Math.floor((y - range) / HERD_CELL); hy <= Math.floor((y + range) / HERD_CELL); hy++) {
    for (let hx = Math.floor((x - range) / HERD_CELL); hx <= Math.floor((x + range) / HERD_CELL); hx++) {
      const herd = herdForCell(world, hx, hy);
      if (herd && (herd.x - x) ** 2 + (herd.y - y) ** 2 <= range * range) out.push(herd);
    }
  }
  return out;
}

/**
 * One horse: its breed's numbers with a little of its own (±8 % speed,
 * ±10 health), and a name. The same seed always gives the same horse.
 */
export function horseStats(breedId, seed) {
  const b = BREED_BY_ID.get(breedId) ?? BREEDS[0];
  const rng = createRng(seed >>> 0);
  const speed = Math.round(b.speed * (0.92 + rng.next() * 0.16) * 100) / 100;
  const hp = Math.max(0, b.hp + Math.round((rng.next() - 0.5) * 20));
  const name = NAMES[Math.floor(rng.next() * NAMES.length)];
  return { breed: b.id, speed, gallop: b.gallop, hp, name };
}

/** The seed of horse `i` of a herd. */
export function herdHorseSeed(world, herd, i) {
  return hashInts(world.objSeed ?? world.seed, Math.floor(herd.x), Math.floor(herd.y), i, 0x405e);
}

/** Speed, gallop and health in words (for the UI). */
export function describeHorse(h, sv = false) {
  const breed = BREED_BY_ID.get(h.breed);
  return sv
    ? `${breed?.sv ?? h.breed} · fart ${h.speed.toFixed(1)} · galopp ×${h.gallop} · +${h.hp} hälsa`
    : `${breed?.name ?? h.breed} · speed ${h.speed.toFixed(1)} · gallop ×${h.gallop} · +${h.hp} health`;
}

/** Where a herd's horse grazes: a few tiles around the herd's spot. */
export function grazeSpot(herd, i, t) {
  const a = i * 2.1 + t * 0.07;
  return { x: herd.x + Math.cos(a) * (1.5 + i), y: herd.y + Math.sin(a * 0.8) * (1.2 + i * 0.6) };
}
