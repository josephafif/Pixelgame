// Loot on the server: monster drops, chests, felled trees and rocks, death
// bags, and picking things up. Weapons are generated here from fresh
// random seeds (nobody can predict a drop), and every weapon that changes
// hands is written to the database before anyone is told.

import { randomBytes, randomInt } from 'node:crypto';
import { generateWeapon } from '../src/weapons/generator.js';
import { dropRarity, WEAPON_DROP_CHANCE } from '../src/game/economy.js';
import { harvestInfo, rollDrops } from '../src/game/gathering.js';
import { salvageValue } from '../src/game/loot.js';
import { learnFromWeapon, MP_RESOURCE_KEYS } from '../src/net/mpsave.js';
import { inSafeZone } from '../src/net/rules.js';
import * as players from './players.js';
import * as pals from './pals.js';
import * as base from './base.js';
import * as discoveries from './discoveries.js';

const MAGNET = 2.6;
const COLLECT = 0.6;
const LOCK_MS = 15000; // only the one who earned a drop can take it at first
const DESPAWN_MS = 5 * 60 * 1000;
const BAG_MS = 10 * 60 * 1000;
const MAX_PICKUPS = 900;

export const RESOURCE_COLORS = { essence: '#7ae0ff', scrap: '#c8ccd8', wood: '#b07a48', stone: '#b8bcc8', gold: '#ffd24a', shard: '#ffd24a', heart: '#ff5a6a', bag: '#c89a5a', mapscroll: '#ecdcb0' };

export function harvestInfoFor(gs, tileId) {
  return harvestInfo(gs.data, tileId);
}

export function newItemId() {
  return `m${randomBytes(8).toString('hex')}`;
}

/** A brand-new weapon with an unpredictable seed and a unique id. */
export function generate(gs, { level, luck = 0, source = 'drop', minRarity = null, maxRarity = null, theme = null, craft = null, unlocked = [], roll = source }) {
  const limits = craft ? { minRarity, maxRarity } : dropRarity({ source: roll, minRarity, luck, roll: Math.random() });
  const dna = generateWeapon(gs.data, {
    seed: randomInt(0, 0xffffffff),
    level: Math.max(1, Math.min(99, Math.round(level))),
    luck,
    source,
    unlocked,
    minRarity: limits.minRarity,
    maxRarity: limits.maxRarity,
    theme,
    craft,
  });
  dna.id = newItemId();
  return dna;
}

export function addPickup(gs, kind, x, y, extra = {}) {
  if (gs.pickups.size >= MAX_PICKUPS) {
    for (const [id, it] of gs.pickups) {
      if (it.kind !== 'weapon' && it.kind !== 'bag') {
        gs.pickups.delete(id);
        break;
      }
    }
  }
  // On land it must lie where you can walk; out at sea it floats where it fell.
  if (!gs.world.isFree(x, y, 0.3) && !gs.world.isFree(x, y, 0.3, 'boat')) ({ x, y } = gs.world.findFreeSpot(x, y, 0.3, 'player', { x, y }));
  const a = Math.random() * Math.PI * 2;
  const it = {
    id: gs.newId(),
    kind,
    x,
    y,
    vx: Math.cos(a) * 1.8,
    vy: Math.sin(a) * 1.8,
    value: 1,
    color: RESOURCE_COLORS[kind] ?? '#ffffff',
    rarity: 0,
    owner: 0,
    lockUntil: 0,
    born: Date.now(),
    ...extra,
  };
  gs.pickups.set(it.id, it);
  return it;
}

function dropWeapon(gs, dna, x, y, owner) {
  const r = gs.data.rarityIndex.get(dna.rarity) ?? 0;
  const color = gs.data.byId.rarities.get(dna.rarity)?.color ?? '#ffffff';
  const it = addPickup(gs, 'weapon', x, y, { dna, color, rarity: r, owner: owner?.id ?? 0, lockUntil: owner ? Date.now() + LOCK_MS : 0, ref: gs.newId() });
  if (r >= 3) gs.event(x, y, { k: 'fx', fx: 'drop', x, y, r, color }, 40);
  if (r >= 4) gs.broadcast({ t: 'toast', text: `${owner?.name ?? 'Någon'} hittade ett LEGENDARISKT vapen: ${dna.name.text}!`, kind: 'legendary' });
  return it;
}

// --- Monsters ----------------------------------------------------------------------------

export function onEnemyKilled(gs, e, killer) {
  // Everyone who helped gets experience; the killer the most.
  const now = Date.now();
  for (const [pid, dmg] of e.damageBy) {
    const p = gs.players.get(pid);
    if (!p || p.dead) continue;
    const share = pid === killer?.id ? 1 : Math.min(0.75, 0.25 + dmg / e.maxHp);
    players.addXp(gs, p, e.xp * share);
    if (pid === killer?.id) p.ch.kills += 1;
  }
  if (e.boss) {
    bossDefeated(gs, e, now);
    return;
  }
  if (e.minion) return;
  const owner = killer ?? null;
  if (e.def.sea) {
    seaLoot(gs, e, owner, now);
    return;
  }
  const luck = owner?.stats?.luck ?? 0;
  const value = 1 + Math.floor(e.level / 8);
  const orbs = e.elite ? 6 : 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < orbs; i++) addPickup(gs, 'essence', e.x, e.y, { value, owner: owner?.id ?? 0, lockUntil: owner ? now + LOCK_MS : 0 });
  if (Math.random() < (e.elite ? 1 : 0.35)) addPickup(gs, 'scrap', e.x, e.y, { value: 1 + Math.floor(e.level / 6), owner: owner?.id ?? 0, lockUntil: owner ? now + LOCK_MS : 0 });
  if (Math.random() < 0.05) addPickup(gs, 'heart', e.x, e.y, {});
  // Now and then a component to research (more often from elites).
  if (owner && Math.random() < (e.elite ? 0.08 : 0.012) + luck * 0.0004) {
    const biome = gs.world.biomeAt(Math.floor(e.x), Math.floor(e.y));
    dropComponent(gs, owner, pickOne(biome.components), e.x, e.y);
  }
  if (owner && e.elite) pals.dropEgg(gs, owner, 'elite', e.x, e.y);
  // Now and then an elite carries an old map.
  if (owner && e.elite && Math.random() < 0.03) addPickup(gs, 'mapscroll', e.x, e.y, { owner: owner.id, lockUntil: now + LOCK_MS });
  const source = e.elite ? 'elite' : 'drop';
  if (Math.random() < WEAPON_DROP_CHANCE[source] * (1 + luck * 0.01)) {
    const dna = generate(gs, { level: e.level, luck: Math.floor(luck), source, roll: source, unlocked: researchedOf(owner) });
    dropWeapon(gs, dna, e.x, e.y, owner);
  }
}

/** Sharks and serpents: essence, scrap and coins; serpents are a real catch (as in single player). */
function seaLoot(gs, e, owner, now) {
  const big = Boolean(e.def.bigLoot);
  const lock = owner ? { owner: owner.id, lockUntil: now + LOCK_MS } : {};
  const value = 1 + Math.floor(e.level / 8);
  for (let i = 0; i < (big ? 8 : 2); i++) addPickup(gs, 'essence', e.x, e.y, { value, ...lock });
  for (let i = 0; i < (big ? 5 : Math.random() < 0.5 ? 1 : 0); i++) addPickup(gs, 'scrap', e.x, e.y, { value: 1 + (big ? 1 : 0), ...lock });
  const coins = big ? 20 + ((Math.random() * 26) | 0) : Math.random() < 0.35 ? 1 + ((Math.random() * 4) | 0) : 0;
  if (coins) addPickup(gs, 'gold', e.x, e.y, { value: coins, ...lock });
  if (big && Math.random() < 0.08) addPickup(gs, 'shard', e.x, e.y, { value: 1, ...lock });
  if (owner && e.kind === 'serpent') pals.dropEgg(gs, owner, 'serpent', e.x, e.y);
  const luck = owner?.stats?.luck ?? 0;
  const source = big ? 'elite' : 'drop';
  if (Math.random() < (big ? 0.35 : WEAPON_DROP_CHANCE.drop) * (1 + luck * 0.01)) {
    const dna = generate(gs, { level: e.level, luck: Math.floor(luck), source, minRarity: big ? 'uncommon' : null, roll: source, unlocked: researchedOf(owner) });
    dropWeapon(gs, dna, e.x, e.y, owner);
  }
}

function bossDefeated(gs, b, now) {
  const def = b.def;
  if (b.altarKey) {
    gs.setMark(b.altarKey, 'altar');
    gs.broadcast({ t: 'wd', k: 'altar', key: b.altarKey, spent: true });
  }
  gs.event(b.x, b.y, { k: 'boss', id: b.id, active: false, victory: true, name: def.name }, 80);
  const total = [...b.damageBy.values()].reduce((s, v) => s + v, 0) || 1;
  const winners = [];
  for (const [pid, dmg] of b.damageBy) {
    const p = gs.players.get(pid);
    if (!p || dmg / total < gs.rules.bossShare) continue;
    winners.push(p);
    p.ch.firstBoss = true;
    // A Pal Egg: always the first time you beat this boss, sometimes after that.
    pals.dropEgg(gs, p, p.ch.extra.bosses[def.id] ? 'boss' : 'bossFirst', b.x + (Math.random() - 0.5) * 2, b.y + (Math.random() - 0.5) * 2);
    p.ch.extra.bosses[def.id] = (p.ch.extra.bosses[def.id] ?? 0) + 1;
    // Personal loot: everyone who fought gets their own reward.
    const dna = generate(gs, {
      level: b.level, luck: Math.floor(p.stats.luck), source: 'boss', minRarity: def.drop?.minRarity ?? 'rare', theme: def.drop?.theme ?? null, roll: 'boss',
      unlocked: researchedOf(p),
    });
    // The boss's core: new weapon possibilities at the forge.
    if (def.drop?.component) dropComponent(gs, p, def.drop.component, b.x, b.y);
    dropWeapon(gs, dna, b.x + (Math.random() - 0.5) * 2, b.y + (Math.random() - 0.5) * 2, p);
    for (let i = 0; i < 12; i++) addPickup(gs, 'essence', b.x, b.y, { value: 2 + Math.floor(b.level / 5), owner: p.id, lockUntil: now + 60000 });
    addPickup(gs, 'shard', b.x, b.y, { value: 1, owner: p.id, lockUntil: now + 60000 });
    players.markMe(p);
    gs.toast(p, `${def.name} är besegrad! Din belöning ligger vid altaret.`, 'legendary');
  }
  if (winners.length) gs.log.info(`[boss] ${def.name} defeated by ${winners.map((p) => p.name).join(', ')}`);
}

// --- Chests ------------------------------------------------------------------------------

export function openChest(gs, p, o, now) {
  gs.setMark(o.key, 'chest', now + 2 * 60 * 60 * 1000); // refills after two hours
  gs.broadcastTile(Math.floor(o.x), Math.floor(o.y), { t: 'wd', k: 'used', key: o.key, used: true });
  gs.event(o.x, o.y, { k: 'fx', fx: 'chest', x: o.x, y: o.y });
  const level = gs.world.worldLevel(o.x, o.y);
  const rich = o.rich ? 2 : 1;
  for (let i = 0; i < 4 * rich; i++) addPickup(gs, 'essence', o.x, o.y, { value: 1 + Math.floor(level / 6), owner: p.id, lockUntil: now + LOCK_MS });
  for (let i = 0; i < 2 * rich; i++) addPickup(gs, 'scrap', o.x, o.y, { value: 2 + Math.floor(level / 4), owner: p.id, lockUntil: now + LOCK_MS });
  if (Math.random() < 0.4) addPickup(gs, 'gold', o.x, o.y, { value: 3 + ((Math.random() * 8) | 0), owner: p.id, lockUntil: now + LOCK_MS });
  if (Math.random() < 0.06) addPickup(gs, 'mapscroll', o.x, o.y, { owner: p.id, lockUntil: now + LOCK_MS });
  if (Math.random() < WEAPON_DROP_CHANCE.chest * rich) {
    const dna = generate(gs, { level: Math.max(level, p.ch.level - 1), luck: Math.floor(p.stats.luck), source: 'chest', roll: 'chest', unlocked: researchedOf(p) });
    dropWeapon(gs, dna, o.x, o.y + 0.6, p);
  }
  chestComponent(gs, p, o);
}

/** A stash only for `p` (buried treasure): like a chest, `rich` times as much. */
export function personalChest(gs, p, o, now, rich = 1) {
  gs.event(o.x, o.y, { k: 'fx', fx: 'chest', x: o.x, y: o.y });
  const level = gs.world.worldLevel(o.x, o.y);
  const lock = { owner: p.id, lockUntil: now + LOCK_MS };
  for (let i = 0; i < Math.round(4 * rich); i++) addPickup(gs, 'essence', o.x, o.y, { value: 1 + Math.floor(level / 6), ...lock });
  for (let i = 0; i < Math.round(2 * rich); i++) addPickup(gs, 'scrap', o.x, o.y, { value: 2 + Math.floor(level / 4), ...lock });
  addPickup(gs, 'gold', o.x, o.y, { value: Math.round((3 + ((Math.random() * 8) | 0)) * rich), ...lock });
  if (Math.random() < WEAPON_DROP_CHANCE.chest * rich) {
    const dna = generate(gs, { level: Math.max(level, p.ch.level - 1), luck: Math.floor(p.stats.luck), source: 'chest', roll: 'chest', unlocked: researchedOf(p) });
    dropWeapon(gs, dna, o.x, o.y + 0.6, p);
  }
  chestComponent(gs, p, o);
}

// --- Components (research at the library, as in single player) ---------------------------

const BLUEPRINTS = ['bp_scythe', 'bp_gun', 'bp_cannon', 'bp_chakram', 'bp_warfan', 'bp_crossbow'];

function pickOne(list) {
  return list?.length ? list[(Math.random() * list.length) | 0] : null;
}

/** The components a character has researched (they widen what drops and what the forge can make). */
export function researchedOf(p) {
  if (!p?.ch?.extra?.components) return [];
  return Object.entries(p.ch.extra.components).filter(([, c]) => c.researched).map(([id]) => id).sort();
}

function componentColor(gs, id) {
  const c = gs.data.byId.components.get(id);
  if (c?.element) return gs.data.byId.elements.get(c.element)?.glow ?? '#ffffff';
  return gs.data.byId.rarities.get(c?.rarity)?.color ?? '#ffffff';
}

export function dropComponent(gs, p, id, x, y) {
  if (!id || !gs.data.byId.components.has(id)) return;
  addPickup(gs, 'component', x, y, { componentId: id, color: componentColor(gs, id), owner: p.id, lockUntil: Date.now() + 60000 });
}

function chestComponent(gs, p, o) {
  if (Math.random() >= 0.35 + (p.stats?.luck ?? 0) * 0.005) return;
  const biome = gs.world.biomeAt(Math.floor(o.x), Math.floor(o.y));
  dropComponent(gs, p, pickOne([...biome.components, ...BLUEPRINTS]), o.x, o.y + 0.5);
}

/** Picking up (or buying) a component. */
export function discoverComponent(gs, p, id) {
  const def = gs.data.byId.components.get(id);
  if (!def) return;
  p.ch.extra.components ??= {};
  const entry = p.ch.extra.components[id] ?? { found: 0, researched: false };
  p.ch.extra.components[id] = entry;
  entry.found += 1;
  if (entry.found > 1 && entry.researched) {
    p.ch.resources.essence = (p.ch.resources.essence ?? 0) + 10;
    gs.toast(p, `${def.name} (dubblett) → +10 essens`);
  } else if (def.research === 0 && !entry.researched) {
    entry.researched = true;
    gs.toast(p, `Bosskärna: ${def.name}! Nya vapenmöjligheter i smedjan.`, 'legendary');
  } else if (entry.found === 1) {
    gs.toast(p, `Ny komponent: ${def.name}. Forska på den i biblioteket för att få fler val i smedjan.`, 'component');
  }
  gs.event(p.x, p.y, { k: 'pick', id: p.id, kind: 'component' }, 12);
  players.markMe(p);
  players.persist(gs, p);
}

// --- Gathering ---------------------------------------------------------------------------

/** A tree or rock falls. `direct`: straight into p's pockets (what a pal chopped). */
export function fellBlock(gs, p, target, tool, { direct = false } = {}) {
  const id = gs.removeBlock(target.tx, target.ty);
  if (!id) return;
  const drops = rollDrops(target.info, tool.yield ?? 1);
  const now = Date.now();
  for (const [kind, n] of Object.entries(drops)) {
    if (direct) {
      p.ch.resources[kind] = (p.ch.resources[kind] ?? 0) + n;
      players.markMe(p);
      continue;
    }
    for (let i = 0; i < n; i++) {
      addPickup(gs, kind === 'shards' ? 'shard' : kind, target.x, target.y, { value: 1, owner: p.id, lockUntil: now + LOCK_MS });
    }
  }
  gs.event(target.x, target.y, { k: 'fell', x: target.x, y: target.y, wood: Boolean(target.info.drops.wood), text: Object.entries(drops).map(([k, n]) => `+${n} ${k}`).join(' ') }, 30);
}

// --- Death bags ----------------------------------------------------------------------------

/** Drops part of what a player carries where they died (one transaction). */
export function dropDeathBag(gs, p, killer) {
  const res = {};
  let any = false;
  for (const k of MP_RESOURCE_KEYS) {
    const n = Math.floor((p.ch.resources[k] ?? 0) * gs.rules.deathDrop);
    if (n > 0) {
      res[k] = n;
      p.ch.resources[k] -= n;
      any = true;
    }
  }
  const items = [];
  if (gs.rules.hardcore) {
    const keep = new Set([p.inv.equipped, p.inv.secondary]);
    for (const dna of p.inv.bag.filter((w) => !keep.has(w.id))) items.push(dna);
  }
  try {
    gs.db.tx(() => {
      for (const dna of items) gs.db.deleteItem(dna.id, p.accountId);
      players.persist(gs, p);
      gs.db.log(p.accountId, 'death-drop', null, { res, items: items.map((d) => d.id), killer: killer?.accountId ?? null });
    });
  } catch (err) {
    // Nothing was written: give it all back rather than lose it.
    for (const [k, n] of Object.entries(res)) p.ch.resources[k] += n;
    gs.log.error('[death] could not drop bag', err);
    return;
  }
  if (items.length) {
    const gone = new Set(items.map((d) => d.id));
    p.inv.bag = p.inv.bag.filter((w) => !gone.has(w.id));
    p.inv.favorites = p.inv.favorites.filter((id) => !gone.has(id));
    for (const id of gone) gs.send(p, { t: 'inv-', id });
  }
  players.markMe(p);
  if (!any && !items.length) return;
  addPickup(gs, 'bag', p.x, p.y, {
    vx: 0, vy: 0, res, items, owner: killer && killer !== p ? killer.id : 0,
    lockUntil: killer && killer !== p ? Date.now() + 10000 : 0, born: Date.now(), bag: true, ownerName: p.name,
  });
}

// --- Pickups --------------------------------------------------------------------------------

export function updatePickups(gs, dt, now) {
  for (const it of gs.pickups.values()) {
    const age = now - it.born;
    if ((it.kind === 'bag' ? age > BAG_MS : age > DESPAWN_MS) && it.kind !== 'weapon') {
      gs.pickups.delete(it.id);
      continue;
    }
    if (it.kind === 'weapon' && age > 15 * 60 * 1000) {
      gs.pickups.delete(it.id);
      continue;
    }
    // Pop out, then settle.
    if (it.vx || it.vy) {
      const nx = it.x + it.vx * dt;
      const ny = it.y + it.vy * dt;
      if (gs.world.isFree(nx, ny, 0.2)) {
        it.x = nx;
        it.y = ny;
      }
      it.vx *= 0.82;
      it.vy *= 0.82;
      if (Math.abs(it.vx) + Math.abs(it.vy) < 0.05) it.vx = it.vy = 0;
    }
    if (age < 350) continue;
    const locked = it.lockUntil > now;
    const who = gs.nearestPlayer(it.x, it.y, it.kind === 'weapon' || it.kind === 'bag' ? 0.9 : MAGNET, (p) => !p.asleep && (!locked || p.id === it.owner));
    if (!who) continue;
    const d = Math.sqrt((who.x - it.x) ** 2 + (who.y - it.y) ** 2);
    if (d <= (it.kind === 'weapon' || it.kind === 'bag' ? 0.9 : COLLECT)) {
      if (collect(gs, who, it)) gs.pickups.delete(it.id);
    } else if (it.kind !== 'weapon' && it.kind !== 'bag') {
      const pull = Math.min(d, 9 * dt);
      it.x += ((who.x - it.x) / d) * pull;
      it.y += ((who.y - it.y) / d) * pull;
    }
  }
}

/** Gives a pickup to a player. Returns false if it must stay on the ground. */
function collect(gs, p, it) {
  const r = p.ch.resources;
  switch (it.kind) {
    case 'essence':
    case 'scrap':
    case 'wood':
    case 'stone':
    case 'gold':
    case 'prismite':
    case 'spores':
    case 'aether':
      r[it.kind] = (r[it.kind] ?? 0) + it.value;
      players.markMe(p);
      gs.event(p.x, p.y, { k: 'pick', id: p.id, kind: it.kind }, 12);
      return true;
    case 'shard':
      r.shards = (r.shards ?? 0) + it.value;
      players.markMe(p);
      gs.toast(p, `Stjärnskärva! (${r.shards})`, 'legendary');
      return true;
    case 'heart':
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.2);
      return true;
    case 'weapon':
      return giveWeapon(gs, p, it.dna, 'pickup');
    case 'bag':
      return openBag(gs, p, it);
    case 'egg':
      pals.collectEgg(gs, p, it);
      return true;
    case 'component':
      discoverComponent(gs, p, it.componentId);
      return true;
    case 'mapscroll':
      discoveries.readMap(gs, p);
      return true;
    default:
      return true;
  }
}

/** Puts a weapon in the player's bag (written to the database first). */
export function giveWeapon(gs, p, dna, source) {
  const sizes = base.sizesFor(gs, p);
  if (p.inv.bag.length >= sizes.bagSize) {
    if ((p.bagFullWarnAt ?? 0) < Date.now() - 4000) {
      p.bagFullWarnAt = Date.now();
      gs.toast(p, 'Väskan är full: släng eller förvara något först.', 'warn');
    }
    return false;
  }
  try {
    gs.db.tx(() => {
      gs.db.insertItem({ id: dna.id, ownerId: p.accountId, place: 'bag', dna, source });
      gs.db.log(p.accountId, source, dna.id, { rarity: dna.rarity });
    });
  } catch (err) {
    gs.log.error('[loot] could not store weapon', err);
    return false;
  }
  p.inv.bag.push(dna);
  if (learnFromWeapon(p.ch.extra, dna)) players.markMe(p);
  gs.send(p, { t: 'inv+', place: 'bag', dna, found: true });
  if (!p.inv.equipped) {
    p.inv.equipped = dna.id;
    players.applySlot(gs, p, p.inv.activeSlot === 'none' ? 'main' : p.inv.activeSlot);
  }
  return true;
}

function openBag(gs, p, bag) {
  const sizes = base.sizesFor(gs, p);
  const room = sizes.bagSize - p.inv.bag.length;
  const items = bag.items.slice(0, Math.max(0, room));
  try {
    gs.db.tx(() => {
      for (const dna of items) gs.db.insertItem({ id: dna.id, ownerId: p.accountId, place: 'bag', dna, source: 'bag' });
      for (const [k, n] of Object.entries(bag.res)) p.ch.resources[k] = (p.ch.resources[k] ?? 0) + n;
      players.persist(gs, p);
      gs.db.log(p.accountId, 'bag', null, { from: bag.ownerName, res: bag.res, items: items.map((d) => d.id) });
    });
  } catch (err) {
    for (const [k, n] of Object.entries(bag.res)) p.ch.resources[k] = Math.max(0, (p.ch.resources[k] ?? 0) - n);
    gs.log.error('[loot] bag failed', err);
    return false;
  }
  for (const dna of items) {
    p.inv.bag.push(dna);
    gs.send(p, { t: 'inv+', place: 'bag', dna, found: true });
  }
  const text = Object.entries(bag.res).map(([k, n]) => `${n} ${k}`).join(', ');
  gs.toast(p, `Du plockade upp ${bag.ownerName}s säck${text ? `: ${text}` : ''}.`, 'component');
  players.markMe(p);
  // Weapons that didn't fit stay in the bag.
  bag.items = bag.items.slice(items.length);
  bag.res = {};
  return bag.items.length === 0;
}

/** Drops a weapon from the bag onto the ground (others can pick it up). */
export function dropFromBag(gs, p, id) {
  const idx = p.inv.bag.findIndex((w) => w.id === id);
  if (idx < 0) return 'Det vapnet har du inte';
  if (p.inv.equipped === id || p.inv.secondary === id) return 'Ta bort vapnet från din utrustning först';
  if (inSafeZone(gs.rules, p.x, p.y) === false && p.combatUntil > Date.now()) return 'Inte mitt i en strid';
  const dna = p.inv.bag[idx];
  try {
    gs.db.tx(() => {
      gs.db.deleteItem(id, p.accountId);
      gs.db.log(p.accountId, 'drop', id, null);
    });
  } catch {
    return 'Kunde inte släppa vapnet';
  }
  p.inv.bag.splice(idx, 1);
  p.inv.favorites = p.inv.favorites.filter((f) => f !== id);
  gs.send(p, { t: 'inv-', id });
  const it = dropWeapon(gs, dna, p.x + Math.cos(p.facing) * 0.8, p.y + Math.sin(p.facing) * 0.8, null);
  it.lockUntil = Date.now() + 1500;
  it.owner = -1; // nobody for a moment (so it doesn't jump straight back)
  return null;
}

/** Breaks weapons down into scrap and essence. */
export function salvage(gs, p, ids) {
  const total = { scrap: 0, essence: 0, shards: 0 };
  const gone = [];
  const keep = new Set([p.inv.equipped, p.inv.secondary, ...p.inv.favorites]);
  try {
    gs.db.tx(() => {
      for (const id of ids) {
        if (keep.has(id)) continue;
        const place = p.inv.bag.some((w) => w.id === id) ? 'bag' : p.inv.storage.some((w) => w.id === id) ? 'storage' : null;
        if (!place) continue;
        const dna = (place === 'bag' ? p.inv.bag : p.inv.storage).find((w) => w.id === id);
        gs.db.deleteItem(id, p.accountId);
        const v = salvageValue(dna);
        total.scrap += v.scrap;
        total.essence += v.essence;
        total.shards += v.shards ?? 0;
        gone.push(id);
      }
      for (const [k, n] of Object.entries(total)) p.ch.resources[k] = (p.ch.resources[k] ?? 0) + n;
      players.persist(gs, p);
      gs.db.log(p.accountId, 'salvage', null, { ids: gone, total });
    });
  } catch (err) {
    gs.log.error('[salvage] failed', err);
    for (const [k, n] of Object.entries(total)) p.ch.resources[k] = Math.max(0, (p.ch.resources[k] ?? 0) - n);
    return null;
  }
  const set = new Set(gone);
  p.inv.bag = p.inv.bag.filter((w) => !set.has(w.id));
  p.inv.storage = p.inv.storage.filter((w) => !set.has(w.id));
  for (const id of gone) gs.send(p, { t: 'inv-', id });
  players.markMe(p);
  return { ...total, count: gone.length };
}
