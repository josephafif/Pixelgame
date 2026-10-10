// Small things to find while exploring. None of them change the game much,
// but they make wandering (and sailing) worth it:
//   bones      – an adventurer's remains: a few coins, scraps and a note
//   signpost   – points to the nearest boss arena or market
//   mushrooms  – a ring of glowcaps: a little healing and a burst of speed
//   camp       – an abandoned campsite: rest (full heal) and a small stash
//   bottle     – a message in a bottle on a beach: a treasure map (pinned)
//   wreck      – a shipwreck: wood, scrap and coins
//   idol       – an island idol: +2 max health, once per idol
//   treasure   – buried treasure on an island: dig it up (needs a pickaxe);
//                sometimes a pal egg is buried with it
// And bigger sites, one in most corners of the world (world.siteForCell):
//   tower      – a watchtower: climb it and the land around shows on your map
//   ruins      – old ruins: rich loot, but their guardians wake up
//   mine       – an old mine: ore, stone and now and then a Star Shard
//   runestone  – runes that strengthen you and tell of a place nearby
// Plus a rare find anywhere: an old map that shows a new part of the world.

import { hashInts } from '../core/rng.js';
import { CHUNK } from './world.js';
import { openChestLoot, addPickup } from './loot.js';
import { currentPickaxe } from './gathering.js';
import { spawnEnemy } from './enemies.js';

export const POI = {
  bones: { label: 'Search the remains', once: true },
  signpost: { label: 'Read the signpost', once: false },
  mushrooms: { label: 'Eat a glowcap', once: true },
  camp: { label: 'Rest at the old campsite', once: true },
  bottle: { label: 'Open the bottle', once: true },
  wreck: { label: 'Search the wreck', once: true },
  idol: { label: 'Touch the idol', once: true },
  treasure: { label: 'Dig up the treasure', once: true },
  tower: { label: 'Climb the watchtower', once: true },
  ruins: { label: 'Search the ruins', once: true },
  mine: { label: 'Dig in the old mine', once: true },
  runestone: { label: 'Read the runestone', once: true },
};

export const SITE_NAMES = { tower: 'A watchtower', ruins: 'Ruins', mine: 'An old mine', runestone: 'A runestone' };
export const SITE_NAMES_SV = { tower: 'Ett utsiktstorn', ruins: 'Ruiner', mine: 'En gammal gruva', runestone: 'En runsten' };

/** How far (in chunks) a watchtower, an old map or a runestone shows the land. */
export const REVEAL = { tower: 7, map: 5, mapHere: 2, runestone: 3 };

/** Chunk keys ("cx,cy") within r chunks of (x, y), in a circle. */
export function chunksAround(x, y, r) {
  const cx = Math.floor(x / CHUNK);
  const cy = Math.floor(y / CHUNK);
  const out = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) out.push(`${cx + dx},${cy + dy}`);
  }
  return out;
}

const chunkKey = (x, y) => `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;

/**
 * Something worth going to that you haven't seen yet: a site (or a great
 * altar) in an unexplored part of the world, not too close. `explored` is
 * a Set of chunk keys, `found` the keys of what you have used.
 */
export function unseenPlaces(world, explored, found, x, y, { min = 40, max = 700 } = {}) {
  const done = new Set(found ?? []);
  const out = [];
  for (const s of world.sitesNear(x, y, max)) {
    if (done.has(s.key) || explored.has(chunkKey(s.x, s.y))) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d >= min) out.push({ ...s, d });
  }
  for (const a of world.greatAltars()) {
    if (explored.has(chunkKey(a.x, a.y))) continue;
    const d = Math.hypot(a.x - x, a.y - y);
    if (d >= min && d <= max) out.push({ type: 'altar', key: a.key, x: a.x, y: a.y, bossId: a.bossId, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** Where an old map leads: one of the three nearest unseen places (or null). */
export function mapTarget(world, explored, found, x, y, rnd = Math.random) {
  const list = unseenPlaces(world, explored, found, x, y);
  if (!list.length) return null;
  return list[Math.floor(rnd() * Math.min(3, list.length))];
}

/** Label for a place on the map. */
export function placeName(data, t, sv = false) {
  if (t.type === 'altar') return sv ? `${data.byId.bosses.get(t.bossId)?.name ?? 'Bossens'} altare` : `The altar of the ${data.byId.bosses.get(t.bossId)?.name ?? 'boss'}`;
  return (sv ? SITE_NAMES_SV : SITE_NAMES)[t.type] ?? t.type;
}

/** The guardians that wake when ruins are searched: two elites of the land. */
export function guardianKinds(data, biome, rnd = Math.random) {
  const list = (biome.enemies ?? []).map((id) => data.byId.enemies.get(id)).filter((d) => d && !d.sea);
  if (!list.length) return [];
  return [list[Math.floor(rnd() * list.length)].id, list[Math.floor(rnd() * list.length)].id];
}

/** What the old mine gives: { stone, scrap, essence, shard, map } (scaled by how far out it is). */
export function mineHaul(level, rnd = Math.random) {
  const k = 1 + level * 0.15;
  const n = (a, b) => Math.round((a + rnd() * (b - a)) * k);
  return { stone: n(14, 26), scrap: n(5, 10), essence: n(4, 9), gold: n(4, 12), shard: rnd() < 0.06, map: rnd() < 0.15 };
}

const NOTES = [
  "A crumpled note: 'Bosses leave their arenas if you run far enough. Cowards live longer.'",
  "A diary page: 'Rafts are fine on the coast. Out where the water turns dark, you need a real sail.'",
  "Scratched into a shield: 'The Frost Warden breathes cold. Stay out of the cone.'",
  "A letter: 'Traders pay well for legendaries. I never found one. Maybe you will.'",
  "A torn map corner, with an X somewhere out at sea.",
  "A note: 'The Storm Colossus calls lightning where you stand. Keep moving!'",
  "A merchant's receipt: '1 Star Shard — 4 000 gold. Robbery.'",
  "A journal: 'The island idols are warm to the touch. I felt stronger after.'",
  "A love letter, never sent. You put it back.",
  "A note: 'The Void Herald is never alone. Find the real one.'",
];

export function isPoi(type) {
  return Object.hasOwn(POI, type);
}

export function poiFound(save, o) {
  return save.world.found?.includes(o.key) ?? false;
}

/** The nearest treasure not dug up yet, searching outward (up to ~50 chunks). */
export function nearestTreasure(world, save, x, y) {
  const ccx = Math.floor(x / CHUNK);
  const ccy = Math.floor(y / CHUNK);
  for (let r = 1; r <= 50; r++) {
    let best = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const t = world.treasureAt(ccx + dx, ccy + dy);
        if (!t || save.world.found?.includes(t.key)) continue;
        const d = (t.x - x) ** 2 + (t.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

const DIRS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

export function direction(fromX, fromY, toX, toY) {
  const a = Math.atan2(toY - fromY, toX - fromX);
  return DIRS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

function markFound(game, o) {
  game.save.world.found ??= [];
  if (!game.save.world.found.includes(o.key)) game.save.world.found.push(o.key);
}

/** Interacting with a point of interest. Returns true when handled. */
export function interactPoi(game, o) {
  const def = POI[o.type];
  if (!def) return false;
  const p = game.player;
  const fx = game.fx;
  const bits = (n0, n1) => n0 + ((Math.random() * (n1 - n0 + 1)) | 0);
  switch (o.type) {
    case 'bones': {
      for (let i = 0; i < bits(2, 4); i++) addPickup(game, 'scrap', o.x, o.y, { value: 1, color: '#b8bcc8' });
      addPickup(game, 'gold', o.x, o.y, { value: bits(2, 8), color: '#ffd24a' });
      if (Math.random() < 0.4) addPickup(game, 'essence', o.x, o.y, { value: 2, color: '#7ae0ff' });
      if (Math.random() < 0.06) addPickup(game, 'mapscroll', o.x, o.y, { color: '#ecdcb0' });
      game.toast(NOTES[hashInts(game.world.seed, Math.floor(o.x), Math.floor(o.y)) % NOTES.length]);
      game.audio.play('chest');
      break;
    }
    case 'signpost': {
      const targets = [];
      for (const a of game.world.allAltarsNear(o.x, o.y, 900)) {
        if (game.altarSpent(a)) continue;
        targets.push({ x: a.x, y: a.y, name: `The altar of the ${game.data.byId.bosses.get(a.bossId)?.name ?? 'boss'}` });
      }
      for (const m of game.world.marketsNear(o.x, o.y, 500)) targets.push({ x: m.x, y: m.y, name: m.name });
      targets.sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y));
      const t = targets[0];
      game.toast(t
        ? `The signpost reads: "${t.name} — ${Math.round(Math.hypot(t.x - o.x, t.y - o.y))} m ${direction(o.x, o.y, t.x, t.y)}"`
        : 'The signpost is too weathered to read.');
      game.audio.play('ui');
      return true; // reusable
    }
    case 'mushrooms': {
      game.heal(Math.round(game.pstats.maxHp * 0.25));
      game.addBuff('moveSpeedPct', 25, 45);
      fx.emit('sparkle', o.x, o.y - 0.3, 14, 0.6, 1.5, ['#7affd0', '#ffffff']);
      game.toast('The glowcap tastes of rain. You feel light on your feet (+25% speed for 45s).', 'component');
      game.audio.play('levelup');
      break;
    }
    case 'camp': {
      p.hp = game.pstats.maxHp;
      for (let i = 0; i < bits(3, 6); i++) addPickup(game, 'essence', o.x, o.y + 0.4, { value: 2, color: '#7ae0ff' });
      addPickup(game, 'wood', o.x, o.y + 0.4, { value: bits(3, 6), color: '#b07a48' });
      fx.emit('ember', o.x, o.y - 0.2, 10, 0.4, 1);
      game.toast('You rest by the old fire (fully healed) and find a small stash.', 'component');
      game.audio.play('chest');
      break;
    }
    case 'bottle': {
      const t = nearestTreasure(game.world, game.save, o.x, o.y);
      if (t) {
        game.addPin(t.x, t.y, 'Treasure');
        const d = Math.round(Math.hypot(t.x - o.x, t.y - o.y));
        game.toast(`A treasure map! X marks a spot on an island ${d} m ${direction(o.x, o.y, t.x, t.y)} (pinned on your map).`, 'legendary');
      } else {
        game.toast('The note inside is washed out. Nothing to read.');
      }
      game.audio.play('chest');
      break;
    }
    case 'wreck': {
      addPickup(game, 'wood', o.x, o.y, { value: bits(8, 15), color: '#b07a48' });
      for (let i = 0; i < bits(4, 8); i++) addPickup(game, 'scrap', o.x, o.y, { value: 1, color: '#b8bcc8' });
      addPickup(game, 'gold', o.x, o.y, { value: bits(6, 18), color: '#ffd24a' });
      game.toast('You pick through the wreck: planks, nails and a few coins.');
      game.audio.play('chest');
      break;
    }
    case 'idol': {
      game.save.player.bonusHp = (game.save.player.bonusHp ?? 0) + 2;
      game.recomputeStats();
      p.hp = game.pstats.maxHp;
      fx.emit('holy', o.x, o.y - 0.6, 20, 0.6, 2);
      game.toast('The idol hums. +2 max health (permanent), fully healed.', 'level');
      game.audio.play('levelup');
      break;
    }
    case 'treasure': {
      if (!currentPickaxe(game.data, game.save)) {
        game.toast('Something is buried here. You need a pickaxe to dig it up.', 'warn');
        return true;
      }
      openChestLoot(game, o, { richness: 2.5, source: 'ruin' });
      if (Math.random() < 0.1) addPickup(game, 'shard', o.x, o.y, { value: 1, color: '#ffd24a' });
      game.dropEgg?.('treasure', o.x, o.y);
      fx.emit('sparkle', o.x, o.y, 24, 0.8, 3);
      game.shake = Math.max(game.shake, 0.2);
      game.toast('Buried treasure!', 'legendary');
      game.audio.play('chest');
      const pin = game.save.world.pins.findIndex((pp) => pp.label === 'Treasure' && Math.hypot(pp.x - o.x, pp.y - o.y) < 2);
      if (pin >= 0) game.removePin(pin);
      break;
    }
    case 'tower': {
      game.revealArea(o.x, o.y, REVEAL.tower);
      const near = unseenPlaces(game.world, game.explored, game.save.world.found, o.x, o.y, { min: 20, max: 260 }).slice(0, 2);
      for (const t of near) game.addPin(t.x, t.y, placeName(game.data, t));
      fx.emit('sparkle', o.x, o.y - 1.5, 16, 0.8, 2, ['#ffffff', '#ffe890']);
      game.toast(near.length
        ? `From the top you see far: the land around shows on your map, and ${near.length === 1 ? 'a place' : 'two places'} worth a visit (pinned).`
        : 'From the top you see far: the land around shows on your map.', 'component');
      game.audio.play('levelup');
      break;
    }
    case 'ruins': {
      openChestLoot(game, o, { richness: 2, source: 'ruin' });
      if (Math.random() < 0.35) addPickup(game, 'mapscroll', o.x, o.y + 0.5, { color: '#ecdcb0' });
      if (Math.random() < 0.08) addPickup(game, 'shard', o.x, o.y + 0.5, { value: 1, color: '#ffd24a' });
      const biome = game.world.biomeAt(Math.floor(o.x), Math.floor(o.y));
      const level = Math.max(game.world.worldLevel(o.x, o.y), game.save.player.level);
      guardianKinds(game.data, biome).forEach((id, i) => {
        const a = (i / 2) * Math.PI * 2 + Math.random();
        const x = o.x + Math.cos(a) * 2.5;
        const y = o.y + Math.sin(a) * 2.5;
        if (game.world.isFree(x, y, 0.45, 'enemy')) spawnEnemy(game, id, x, y, { level, elite: true, biome });
      });
      game.shake = Math.max(game.shake, 0.25);
      fx.emit('void', o.x, o.y - 0.4, 18, 0.8, 2);
      game.toast('You search the ruins and find old riches. Something stirs: the guardians are awake!', 'boss');
      game.audio.play('chest');
      break;
    }
    case 'mine': {
      if (!currentPickaxe(game.data, game.save)) {
        game.toast('The old mine still has ore. You need a pickaxe to dig.', 'warn');
        return true;
      }
      const haul = mineHaul(game.world.worldLevel(o.x, o.y));
      addPickup(game, 'stone', o.x, o.y + 0.6, { value: haul.stone, color: '#b8bcc8' });
      for (let i = 0; i < haul.scrap; i++) addPickup(game, 'scrap', o.x, o.y + 0.6, { value: 1, color: '#b8bcc8' });
      for (let i = 0; i < Math.ceil(haul.essence / 2); i++) addPickup(game, 'essence', o.x, o.y + 0.6, { value: 2, color: '#7ae0ff' });
      addPickup(game, 'gold', o.x, o.y + 0.6, { value: haul.gold, color: '#ffd24a' });
      if (haul.shard) addPickup(game, 'shard', o.x, o.y + 0.6, { value: 1, color: '#ffd24a' });
      if (haul.map) addPickup(game, 'mapscroll', o.x, o.y + 0.6, { color: '#ecdcb0' });
      game.shake = Math.max(game.shake, 0.15);
      fx.emit('dust', o.x, o.y, 14, 0.6, 1.2);
      game.toast(haul.shard ? 'Deep in the mine something glitters: a Star Shard!' : 'You dig out what the miners left behind.', haul.shard ? 'legendary' : 'component');
      game.audio.play('chest');
      break;
    }
    case 'runestone': {
      game.addBuff('attackPower', 15, 300);
      game.revealArea(o.x, o.y, REVEAL.runestone);
      const t = unseenPlaces(game.world, game.explored, game.save.world.found, o.x, o.y, { min: 30, max: 400 })[0];
      if (t) game.addPin(t.x, t.y, placeName(game.data, t));
      fx.emit('arcane', o.x, o.y - 0.6, 20, 0.6, 2);
      game.toast(t
        ? `The runes glow under your hand (+15% damage for 5 min). They tell of ${placeName(game.data, t).toLowerCase()} ${Math.round(t.d)} m ${direction(o.x, o.y, t.x, t.y)} (pinned).`
        : 'The runes glow under your hand (+15% damage for 5 min).', 'component');
      game.audio.play('levelup');
      break;
    }
    default:
      return false;
  }
  if (def.once) markFound(game, o);
  game.requestSave();
  return true;
}

/** An old map was picked up: a new part of the world shows on yours. */
export function readOldMap(game) {
  const p = game.player;
  const t = mapTarget(game.world, game.explored, game.save.world.found, p.x, p.y);
  game.revealArea(p.x, p.y, REVEAL.mapHere);
  if (!t) {
    game.toast('An old map, but it only shows land you already know.');
    return;
  }
  game.revealArea(t.x, t.y, REVEAL.map);
  game.addPin(t.x, t.y, placeName(game.data, t));
  game.flash('#ecdcb0', 0.25);
  game.toast(`An old map! It shows ${placeName(game.data, t).toLowerCase()} ${Math.round(t.d)} m ${direction(p.x, p.y, t.x, t.y)}, and the land around it (open the map: M).`, 'legendary');
}
