// Small things to find while exploring. None of them change the game much,
// but they make wandering (and sailing) worth it:
//   bones      – an adventurer's remains: a few coins, scraps and a note
//   signpost   – points to the nearest boss arena or market
//   mushrooms  – a ring of glowcaps: a little healing and a burst of speed
//   camp       – an abandoned campsite: rest (full heal) and a small stash
//   bottle     – a message in a bottle on a beach: a treasure map (pinned)
//   wreck      – a shipwreck: wood, scrap and coins
//   idol       – an island idol: +2 max health, once per idol
//   treasure   – buried treasure on an island: dig it up (needs a pickaxe)

import { hashInts } from '../core/rng.js';
import { CHUNK } from './world.js';
import { openChestLoot, addPickup } from './loot.js';
import { currentPickaxe } from './gathering.js';

export const POI = {
  bones: { label: 'Search the remains', once: true },
  signpost: { label: 'Read the signpost', once: false },
  mushrooms: { label: 'Eat a glowcap', once: true },
  camp: { label: 'Rest at the old campsite', once: true },
  bottle: { label: 'Open the bottle', once: true },
  wreck: { label: 'Search the wreck', once: true },
  idol: { label: 'Touch the idol', once: true },
  treasure: { label: 'Dig up the treasure', once: true },
};

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
      game.toast(NOTES[hashInts(game.world.seed, Math.floor(o.x), Math.floor(o.y)) % NOTES.length]);
      game.audio.play('chest');
      break;
    }
    case 'signpost': {
      const targets = [];
      for (const lm of game.world.landmarks) {
        if (game.save.bosses.defeated[lm.bossId]) continue;
        targets.push({ x: lm.x, y: lm.y, name: game.data.byId.bosses.get(lm.bossId)?.name ?? 'A boss' });
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
      openChestLoot(game, o, { richness: 2.5 });
      if (Math.random() < 0.1) addPickup(game, 'shard', o.x, o.y, { value: 1, color: '#ffd24a' });
      fx.emit('sparkle', o.x, o.y, 24, 0.8, 3);
      game.shake = Math.max(game.shake, 0.2);
      game.toast('Buried treasure!', 'legendary');
      game.audio.play('chest');
      const pin = game.save.world.pins.findIndex((pp) => pp.label === 'Treasure' && Math.hypot(pp.x - o.x, pp.y - o.y) < 2);
      if (pin >= 0) game.removePin(pin);
      break;
    }
    default:
      return false;
  }
  if (def.once) markFound(game, o);
  game.requestSave();
  return true;
}
