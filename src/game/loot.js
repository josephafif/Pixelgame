// Drops and pickups: essence, scrap, hearts, weapon components and
// procedurally generated weapons (generated in the Web Worker).

import { hashInts } from '../core/rng.js';
import { dist2, normalize } from '../core/math.js';
import { researchedComponents } from '../weapons/crafting.js';

const MAGNET_RADIUS = 2.6;
const COLLECT_RADIUS = 0.6;
const WEAPON_PICKUP_RADIUS = 0.9;
const MAX_PICKUPS = 120;

const SALVAGE = { common: [4, 1], uncommon: [7, 3], rare: [12, 6], epic: [20, 12], legendary: [35, 25] };

export function salvageValue(dna) {
  const [scrap, essence] = SALVAGE[dna.rarity] ?? [4, 1];
  const lvl = dna.ctx?.lvl ?? 1;
  return { scrap: Math.round(scrap * (1 + lvl * 0.05)), essence: Math.round(essence * (1 + lvl * 0.05)) };
}

export function addPickup(game, kind, x, y, extra = {}) {
  if (game.pickups.length >= MAX_PICKUPS) {
    const idx = game.pickups.findIndex((p) => p.kind === 'essence' || p.kind === 'scrap');
    if (idx >= 0) game.pickups.splice(idx, 1);
  }
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
export function requestWeaponDrop(game, x, y, { level, source = 'drop', minRarity = null, theme = null, elementBias = [] }) {
  const save = game.save;
  const seed = hashInts(save.worldSeed, 0xd409, save.counters.drop);
  save.counters.drop += 1;
  const request = {
    seed,
    level,
    luck: Math.floor(game.pstats.luck),
    source,
    unlocked: researchedComponents(save),
    minRarity,
    theme,
    elementBias,
  };
  game.pendingDrops += 1;
  return game.weapons.generate(request)
    .then((dna) => {
      addPickup(game, 'weapon', x, y, { dna, color: game.data.byId.rarities.get(dna.rarity)?.color ?? '#fff' });
      if (game.data.rarityIndex.get(dna.rarity) >= 3) game.fx.add({ type: 'beam', x, y, color: game.data.byId.rarities.get(dna.rarity).color, dur: 2.5 });
    })
    .catch((err) => console.error('[loot] weapon generation failed', err))
    .finally(() => {
      game.pendingDrops -= 1;
    });
}

function pickComponent(game, list) {
  if (!list?.length) return null;
  return list[(Math.random() * list.length) | 0];
}

export function onEnemyKilledLoot(game, e) {
  const luck = game.pstats.luck;
  const level = e.level;
  const biome = game.world.biomeAt(Math.floor(e.x), Math.floor(e.y));
  const orbs = e.boss ? 20 : 1 + Math.floor(level / 3) + (e.elite ? 3 : 0);
  for (let i = 0; i < orbs; i++) addPickup(game, 'essence', e.x, e.y, { value: e.boss ? 4 : 1, color: '#7ae0ff' });
  if (Math.random() < (e.elite ? 0.9 : 0.22)) addPickup(game, 'scrap', e.x, e.y, { value: 1 + ((Math.random() * 2) | 0), color: '#b8bcc8' });
  if (Math.random() < 0.04) addPickup(game, 'heart', e.x, e.y, { color: '#e8364a' });

  if (e.summoned) return;
  const weaponChance = e.boss ? 1 : (e.elite ? 0.3 : 0.035) + luck * 0.001;
  if (Math.random() < weaponChance) {
    requestWeaponDrop(game, e.x, e.y, {
      level,
      minRarity: e.boss ? e.bossDef.drop.minRarity : e.elite ? 'uncommon' : null,
      theme: e.boss ? e.bossDef.drop.theme : null,
      elementBias: biome.elements,
    });
  }
  if (e.boss) {
    // A second guaranteed drop so bosses feel like a jackpot.
    requestWeaponDrop(game, e.x + 1, e.y, { level, minRarity: 'rare', elementBias: [e.element] });
    addPickup(game, 'component', e.x, e.y, { componentId: e.bossDef.drop.component, color: e.color });
    for (let i = 0; i < 10; i++) addPickup(game, 'scrap', e.x, e.y, { value: 2, color: '#b8bcc8' });
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

export function openChestLoot(game, obj) {
  const level = Math.max(game.world.worldLevel(obj.x, obj.y), game.save.player.level);
  const biome = game.world.biomeAt(Math.floor(obj.x), Math.floor(obj.y));
  requestWeaponDrop(game, obj.x, obj.y + 0.8, { level, source: 'chest', minRarity: 'uncommon', elementBias: biome.elements });
  const essence = 4 + ((Math.random() * 6) | 0);
  for (let i = 0; i < essence; i++) addPickup(game, 'essence', obj.x, obj.y + 0.5, { value: 2, color: '#7ae0ff' });
  for (let i = 0; i < 3; i++) addPickup(game, 'scrap', obj.x, obj.y + 0.5, { value: 2, color: '#b8bcc8' });
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
    it.x += it.vx * dt;
    it.y += it.vy * dt;
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
