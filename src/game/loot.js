// Drops and pickups: essence, scrap, hearts, weapon components and
// procedurally generated weapons (generated in the Web Worker).

import { hashInts } from '../core/rng.js';
import { dist2, normalize } from '../core/math.js';
import { researchedComponents } from '../weapons/crafting.js';
import { dropRarity, seededRoll, WEAPON_DROP_CHANCE } from './economy.js';

const MAGNET_RADIUS = 2.6;
const COLLECT_RADIUS = 0.6;
const WEAPON_PICKUP_RADIUS = 0.9;
const MAX_PICKUPS = 120;

// [scrap, essence] per rarity. Salvaging is a trickle, not an income.
const SALVAGE = { common: [2, 0], uncommon: [4, 1], rare: [8, 3], epic: [14, 6], legendary: [24, 12] };

export function salvageValue(dna) {
  const [scrap, essence] = SALVAGE[dna.rarity] ?? [2, 0];
  const lvl = dna.ctx?.lvl ?? 1;
  const out = { scrap: Math.round(scrap * (1 + lvl * 0.03)), essence: Math.round(essence * (1 + lvl * 0.03)) };
  // Breaking down a legendary leaves a Star Shard behind.
  if (dna.rarity === 'legendary') out.shards = 1;
  return out;
}

/** Essence per orb grows slowly with the enemy's level. */
function orbValue(level) {
  return 1 + Math.floor(level / 8);
}

export function addPickup(game, kind, x, y, extra = {}) {
  if (game.pickups.length >= MAX_PICKUPS) {
    const idx = game.pickups.findIndex((p) => p.kind === 'essence' || p.kind === 'scrap');
    if (idx >= 0) game.pickups.splice(idx, 1);
  }
  // Loot must land where the player can walk (never in a lake or a rock) —
  // except out at sea, where it floats so you can scoop it up from the boat.
  const afloat = game.sailing && game.world.isSea(x, y);
  if (!afloat && !game.world.isFree(x, y, 0.3)) ({ x, y } = game.world.findFreeSpot(x, y, 0.3, 'player', { x, y }));
  const a = Math.random() * Math.PI * 2;
  game.pickups.push({
    kind, x, y, t: 0,
    vx: Math.cos(a) * 1.8, vy: Math.sin(a) * 1.8,
    value: 1,
    ...extra,
  });
}

/**
 * Asks the weapon generator for a drop and places it when ready. The drop
 * seed comes from the world seed + a persistent counter, so drops are
 * reproducible per save.
 */
export function requestWeaponDrop(game, x, y, {
  level, source = 'drop', minRarity = null, theme = null, elementBias = [], roll = source, reveal = 'ground',
}) {
  const save = game.save;
  const n = save.counters.drop;
  const seed = hashInts(save.worldSeed, 0xd409, n);
  save.counters.drop += 1;
  const luck = Math.floor(game.pstats.luck);
  // Normal loot stops at epic; legendaries need a separate, tiny roll.
  const limits = dropRarity({ source: roll, minRarity, luck, roll: seededRoll(save, 0x1e6d, n) });
  const request = {
    seed,
    level,
    luck,
    source,
    unlocked: researchedComponents(save),
    minRarity: limits.minRarity,
    maxRarity: limits.maxRarity,
    theme,
    elementBias,
  };
  game.pendingDrops += 1;
  return game.weapons.generate(request)
    .then((dna) => {
      if (reveal === 'case') {
        game.discoverWeapon(dna, { caseRoll: { min: minRarity ?? 'common', max: 'legendary', title: 'Opening chest…' } });
      } else {
        announceDrop(game, dna, x, y);
      }
      return dna;
    })
    .catch((err) => console.error('[loot] weapon generation failed', err))
    .finally(() => {
      game.pendingDrops -= 1;
    });
}

/**
 * Places a weapon drop with a show that matches its rarity: it pops out and
 * lands, rarer drops ring out, flash and (epic+) announce themselves.
 */
function announceDrop(game, dna, x, y) {
  const rarity = game.data.byId.rarities.get(dna.rarity);
  const r = game.data.rarityIndex.get(dna.rarity) ?? 0;
  const color = rarity?.color ?? '#ffffff';
  addPickup(game, 'weapon', x, y, { dna, color, rarity: r, z: 1.2, vz: 3.5 });
  game.audio.play('drop', { rarity: r, throttle: 0 });
  if (r >= 2) game.fx.add({ type: 'ring', x, y, r0: 0.2, r1: 1 + r * 0.5, color, dur: 0.45 });
  if (r >= 3) {
    game.fx.add({ type: 'pillar', x, y, r: 0.25 + r * 0.05, color, dur: 0.5 });
    game.fx.emit('sparkle', x, y - 0.5, 10 + r * 6, 0.8, 3);
    game.toast(r >= 4 ? `A LEGENDARY weapon dropped: ${dna.name.text}!` : `An epic weapon dropped nearby!`, r >= 4 ? 'legendary' : 'epic');
  }
  if (r >= 4) {
    game.shake = Math.max(game.shake, 0.35);
    game.flash?.(color, 0.35);
  }
}

function pickComponent(game, list) {
  if (!list?.length) return null;
  return list[(Math.random() * list.length) | 0];
}

/** Sharks and serpents: essence, scrap and coins; serpents are a real catch. */
function seaLoot(game, e) {
  const big = Boolean(e.def.bigLoot);
  const value = orbValue(e.level);
  for (let i = 0; i < (big ? 8 : 2); i++) addPickup(game, 'essence', e.x, e.y, { value, color: '#7ae0ff' });
  for (let i = 0; i < (big ? 5 : Math.random() < 0.5 ? 1 : 0); i++) addPickup(game, 'scrap', e.x, e.y, { value: 1 + (big ? 1 : 0), color: '#b8bcc8' });
  const coins = big ? 20 + ((Math.random() * 26) | 0) : Math.random() < 0.35 ? 1 + ((Math.random() * 4) | 0) : 0;
  if (coins) addPickup(game, 'gold', e.x, e.y, { value: coins, color: '#ffd24a' });
  if (big && Math.random() < 0.08) addPickup(game, 'shard', e.x, e.y, { value: 1, color: '#ffd24a' });
  const source = big ? 'elite' : 'drop';
  if (Math.random() < (big ? 0.35 : WEAPON_DROP_CHANCE.drop) * (1 + game.pstats.luck * 0.01)) {
    requestWeaponDrop(game, e.x, e.y, { level: e.level, minRarity: big ? 'uncommon' : null, roll: source });
  }
}

export function onEnemyKilledLoot(game, e) {
  if (e.def?.sea) {
    seaLoot(game, e);
    return;
  }
  const luck = game.pstats.luck;
  const level = e.level;
  const biome = game.world.biomeAt(Math.floor(e.x), Math.floor(e.y));
  // Most kills drop nothing but XP; essence is something to go out and earn.
  const orbs = e.boss ? 12 : e.elite ? 3 : Math.random() < 0.4 ? 1 : 0;
  const value = orbValue(level) * (e.boss ? 2 : 1);
  for (let i = 0; i < orbs; i++) addPickup(game, 'essence', e.x, e.y, { value, color: '#7ae0ff' });
  if (Math.random() < (e.elite ? 0.8 : 0.15)) addPickup(game, 'scrap', e.x, e.y, { value: 1 + (e.elite ? 1 : 0), color: '#b8bcc8' });
  if (Math.random() < 0.04) addPickup(game, 'heart', e.x, e.y, { color: '#e8364a' });
  if (e.elite && !e.summoned && Math.random() < 0.03) addPickup(game, 'mapscroll', e.x, e.y, { color: '#ecdcb0' });
  // Gold (spent at markets) mostly comes from selling weapons; a little drops.
  const coins = e.boss ? 40 + ((Math.random() * 40) | 0) : e.elite && Math.random() < 0.4 ? 1 + ((Math.random() * 3) | 0) : 0;
  if (coins) addPickup(game, 'gold', e.x, e.y, { value: coins, color: '#ffd24a' });

  if (e.summoned) return;
  // Weapons are a find, not a given: most kills drop none.
  const source = e.boss ? 'boss' : e.elite ? 'elite' : 'drop';
  const weaponChance = WEAPON_DROP_CHANCE[source] * (1 + luck * 0.01);
  if (Math.random() < weaponChance) {
    requestWeaponDrop(game, e.x, e.y, {
      level,
      minRarity: e.boss ? e.bossDef.drop.minRarity ?? 'rare' : e.elite ? 'uncommon' : null,
      theme: e.boss ? e.bossDef.drop.theme : null,
      elementBias: biome.elements,
      roll: e.boss ? 'boss' : e.elite ? 'elite' : 'drop',
    });
  }
  if (e.boss) {
    // Sometimes a second weapon, so bosses still feel like a jackpot.
    if (Math.random() < 0.35) requestWeaponDrop(game, e.x + 1, e.y, { level, minRarity: 'uncommon', elementBias: [e.element], roll: 'elite' });
    addPickup(game, 'component', e.x, e.y, { componentId: e.bossDef.drop.component, color: e.color });
    // Star Shards (for the Golden Catalyst): first kill of each boss, then 25%.
    const firstKill = !(game.save.bosses.defeated[e.bossDef.id] > 0);
    if (firstKill || Math.random() < 0.25) addPickup(game, 'shard', e.x, e.y, { value: 1, color: '#ffd24a' });
    for (let i = 0; i < 6; i++) addPickup(game, 'scrap', e.x, e.y, { value: 2, color: '#b8bcc8' });
    return;
  }
  const componentChance = (e.elite ? 0.08 : 0.012) + luck * 0.0004;
  if (Math.random() < componentChance) {
    const id = pickComponent(game, biome.components);
    if (id) addPickup(game, 'component', e.x, e.y, { componentId: id, color: componentColor(game, id) });
  }
}

export function componentColor(game, id) {
  const c = game.data.byId.components.get(id);
  if (c?.element) return game.data.byId.elements.get(c.element)?.glow ?? '#ffffff';
  return game.data.byId.rarities.get(c?.rarity)?.color ?? '#ffffff';
}

export function openChestLoot(game, obj, { richness = 1 } = {}) {
  const level = Math.max(game.world.worldLevel(obj.x, obj.y), game.save.player.level);
  const biome = game.world.biomeAt(Math.floor(obj.x), Math.floor(obj.y));
  // Chests are mostly essence and scrap; now and then a weapon (opened like a case).
  const weapon = Math.random() < WEAPON_DROP_CHANCE.chest * richness * (1 + game.pstats.luck * 0.01);
  if (weapon) {
    requestWeaponDrop(game, obj.x, obj.y + 0.8, { level, source: 'chest', minRarity: 'uncommon', elementBias: biome.elements, reveal: 'case' });
  }
  const essence = Math.round((5 + ((Math.random() * 5) | 0)) * richness);
  for (let i = 0; i < essence; i++) addPickup(game, 'essence', obj.x, obj.y + 0.5, { value: orbValue(level), color: '#7ae0ff' });
  const scrap = Math.round((3 + ((Math.random() * 4) | 0)) * richness);
  for (let i = 0; i < scrap; i++) addPickup(game, 'scrap', obj.x, obj.y + 0.5, { value: 1 + (level >= 10 ? 1 : 0), color: '#b8bcc8' });
  addPickup(game, 'gold', obj.x, obj.y + 0.5, { value: Math.round((3 + ((Math.random() * 6) | 0)) * richness), color: '#ffd24a' });
  // Now and then an old map (it shows a new part of the world).
  if (Math.random() < 0.06) addPickup(game, 'mapscroll', obj.x, obj.y + 0.5, { color: '#ecdcb0' });
  if (Math.random() < 0.35 + game.pstats.luck * 0.005) {
    const id = pickComponent(game, [...biome.components, 'bp_scythe', 'bp_gun', 'bp_cannon', 'bp_chakram', 'bp_warfan', 'bp_crossbow']);
    if (id && game.data.byId.components.has(id)) addPickup(game, 'component', obj.x, obj.y + 0.5, { componentId: id, color: componentColor(game, id) });
  }
}

export function updatePickups(game, dt) {
  const p = game.player;
  for (let i = game.pickups.length - 1; i >= 0; i--) {
    const it = game.pickups[i];
    it.t += dt;
    if (it.z) {
      // Drops pop up and bounce once before settling.
      it.vz -= 18 * dt;
      it.z += it.vz * dt;
      if (it.z <= 0) {
        it.z = 0;
        if (it.vz < -3) it.vz = -it.vz * 0.3;
        else it.vz = 0;
      }
    }
    if (it.vx || it.vy) {
      const nx = it.x + it.vx * dt;
      const ny = it.y + it.vy * dt;
      if (game.world.isFree(nx, ny, 0.25)) {
        it.x = nx;
        it.y = ny;
      } else {
        it.vx = it.vy = 0;
      }
    }
    const damp = Math.exp(-6 * dt);
    it.vx *= damp;
    it.vy *= damp;
    if (p.dead || it.t < 0.35) continue;
    const d2v = dist2(it.x, it.y, p.x, p.y);
    if (it.kind === 'weapon') {
      if (d2v < WEAPON_PICKUP_RADIUS * WEAPON_PICKUP_RADIUS && !game.discoveryOpen) {
        game.pickups.splice(i, 1);
        game.discoverWeapon(it.dna);
      }
      continue;
    }
    if (d2v < MAGNET_RADIUS * MAGNET_RADIUS) {
      const n = normalize(p.x - it.x, p.y - it.y);
      const pull = 10 * (1 - Math.sqrt(d2v) / MAGNET_RADIUS) + 3;
      it.x += n.x * pull * dt;
      it.y += n.y * pull * dt;
    }
    if (d2v < COLLECT_RADIUS * COLLECT_RADIUS) {
      game.pickups.splice(i, 1);
      game.collect(it);
      continue;
    }
    if (it.t > 90) game.pickups.splice(i, 1);
  }
}
