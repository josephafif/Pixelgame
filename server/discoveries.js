// Points of interest in multiplayer: the same small finds and bigger sites
// (watchtowers, ruins, old mines, runestones) as single player
// (src/game/discoveries.js), and the rare old maps. Each player finds each
// one for themselves (a stash you emptied is still full for the next
// adventurer), and buried treasure is personal loot too. What shows on your
// map is yours alone: the server tells only you ({ t: 'reveal' }, pins).

import { hashInts } from '../src/core/rng.js';
import {
  POI, nearestTreasure, direction, REVEAL, unseenPlaces, mapTarget, placeName, guardianKinds, mineHaul,
} from '../src/game/discoveries.js';
import * as players from './players.js';
import * as loot from './loot.js';
import * as pals from './pals.js';
import { spawnEnemy } from './enemies.js';

const MAX_FOUND = 1500;
const MAX_SHOWN = 300;

const NOTES = [
  'En skrynklig lapp: ”Bossar lämnar sina arenor om man springer tillräckligt långt. Fegisar lever längre.”',
  'En dagbokssida: ”Flottar duger vid kusten. Där vattnet blir mörkt behöver du ett riktigt segel.”',
  'Inristat i en sköld: ”Frostväktaren andas kyla. Håll dig utanför konen.”',
  'Ett brev: ”Handlare betalar bra för legendariska vapen. Jag hittade aldrig något. Kanske du gör det.”',
  'En sönderriven kartbit, med ett kryss någonstans ute till havs.',
  'En lapp: ”Stormkolossen kallar ner blixtar där du står. Fortsätt röra dig!”',
  'Ett kvitto: ”1 stjärnskärva: 4 000 guld. Rena rånet.”',
  'En dagbok: ”Önidolerna är varma att röra vid. Jag kände mig starkare efteråt.”',
  'Ett kärleksbrev som aldrig skickades. Du lägger tillbaka det.',
  'En lapp: ”Tomhetens härold är aldrig ensam. Hitta den riktiga.”',
];

const DIRS_SV = {
  east: 'österut', 'south-east': 'åt sydost', south: 'söderut', 'south-west': 'åt sydväst',
  west: 'västerut', 'north-west': 'åt nordväst', north: 'norrut', 'north-east': 'åt nordost',
};

export function isPoi(type) {
  return Object.hasOwn(POI, type);
}

function found(p) {
  p.ch.extra.found ??= [];
  return p.ch.extra.found;
}

export function isFound(p, o) {
  return found(p).includes(o.key);
}

function markFound(p, o) {
  const list = found(p);
  if (!list.includes(o.key)) list.push(o.key);
  if (list.length > MAX_FOUND) list.splice(0, list.length - MAX_FOUND);
}

/** Using a point of interest. Returns true when handled. */
export function interact(gs, p, o, now) {
  const def = POI[o.type];
  if (!def) return false;
  if (def.once && isFound(p, o)) return false;
  const bits = (n0, n1) => n0 + ((Math.random() * (n1 - n0 + 1)) | 0);
  const drop = (kind, value, x = o.x, y = o.y) => loot.addPickup(gs, kind, x, y, { value, owner: p.id, lockUntil: now + 60000 });
  switch (o.type) {
    case 'bones':
      for (let i = 0; i < bits(2, 4); i++) drop('scrap', 1);
      drop('gold', bits(2, 8));
      if (Math.random() < 0.4) drop('essence', 2);
      if (Math.random() < 0.06) loot.addPickup(gs, 'mapscroll', o.x, o.y, { owner: p.id, lockUntil: now + 60000 });
      gs.toast(p, NOTES[hashInts(gs.worldSeed, Math.floor(o.x), Math.floor(o.y)) % NOTES.length]);
      gs.event(o.x, o.y, { k: 'fx', fx: 'chest', x: o.x, y: o.y }, 20);
      break;
    case 'signpost': {
      const targets = [];
      for (const a of gs.world.allAltarsNear(o.x, o.y, 900)) {
        if (gs.altarSpent(a.key)) continue;
        targets.push({ x: a.x, y: a.y, name: `${gs.data.byId.bosses.get(a.bossId)?.name ?? 'Bossens'} altare` });
      }
      for (const m of gs.world.marketsNear(o.x, o.y, 500)) targets.push({ x: m.x, y: m.y, name: m.name });
      targets.sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y));
      const t = targets[0];
      gs.toast(p, t
        ? `Skylten visar: ”${t.name}: ${Math.round(Math.hypot(t.x - o.x, t.y - o.y))} m ${DIRS_SV[direction(o.x, o.y, t.x, t.y)]}”`
        : 'Skylten är för väderbiten för att läsa.');
      return true; // read it as often as you like
    }
    case 'mushrooms':
      p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.25));
      addBuff(gs, p, 'moveSpeedPct', 25, 45);
      gs.event(o.x, o.y, { k: 'fx', fx: 'holy', x: o.x, y: o.y }, 20);
      gs.toast(p, 'Glödhatten smakar regn. Du känner dig lätt på foten (+25 % fart i 45 s).', 'component');
      break;
    case 'camp':
      p.hp = p.maxHp;
      for (let i = 0; i < bits(3, 6); i++) drop('essence', 2, o.x, o.y + 0.4);
      drop('wood', bits(3, 6), o.x, o.y + 0.4);
      gs.toast(p, 'Du vilar vid den gamla elden (full hälsa) och hittar ett litet gömställe.', 'component');
      gs.event(o.x, o.y, { k: 'fx', fx: 'chest', x: o.x, y: o.y }, 20);
      break;
    case 'bottle': {
      const t = nearestTreasure(gs.world, { world: { found: found(p) } }, o.x, o.y);
      if (t) {
        gs.send(p, { t: 'pin', x: t.x, y: t.y, label: 'Skatt' });
        const d = Math.round(Math.hypot(t.x - o.x, t.y - o.y));
        gs.toast(p, `En skattkarta! Ett kryss på en ö ${d} m ${DIRS_SV[direction(o.x, o.y, t.x, t.y)]} (utmärkt på din karta).`, 'legendary');
      } else {
        gs.toast(p, 'Lappen i flaskan är urblekt. Inget att läsa.');
      }
      break;
    }
    case 'wreck':
      drop('wood', bits(8, 15));
      for (let i = 0; i < bits(4, 8); i++) drop('scrap', 1);
      drop('gold', bits(6, 18));
      gs.toast(p, 'Du letar igenom vraket: plankor, spik och några mynt.');
      gs.event(o.x, o.y, { k: 'fx', fx: 'chest', x: o.x, y: o.y }, 20);
      break;
    case 'idol':
      p.ch.extra.bonusHp = (p.ch.extra.bonusHp ?? 0) + 2;
      players.recomputeStats(gs, p);
      p.hp = p.maxHp;
      gs.event(o.x, o.y, { k: 'fx', fx: 'holy', x: o.x, y: o.y }, 20);
      gs.toast(p, 'Idolen surrar. +2 max hälsa (för alltid), full hälsa.', 'level');
      break;
    case 'tower': {
      reveal(gs, p, o.x, o.y, REVEAL.tower);
      const near = unseenPlaces(gs.world, new Set(), [...found(p), ...shown(p)], o.x, o.y, { min: 20, max: 260 }).slice(0, 2);
      for (const t of near) showPlace(gs, p, t);
      gs.event(o.x, o.y, { k: 'fx', fx: 'holy', x: o.x, y: o.y - 1.5 }, 20);
      gs.toast(p, near.length
        ? `Från toppen ser du långt: landet runt omkring syns på din karta, och ${near.length === 1 ? 'en plats' : 'två platser'} värda ett besök (utmärkta).`
        : 'Från toppen ser du långt: landet runt omkring syns på din karta.', 'component');
      break;
    }
    case 'ruins': {
      loot.personalChest(gs, p, o, now, 2);
      if (Math.random() < 0.35) loot.addPickup(gs, 'mapscroll', o.x, o.y + 0.5, { owner: p.id, lockUntil: now + 60000 });
      if (Math.random() < 0.08) drop('shard', 1);
      const biome = gs.world.biomeAt(Math.floor(o.x), Math.floor(o.y));
      const level = Math.max(gs.world.worldLevel(o.x, o.y), p.ch.level - 1);
      guardianKinds(gs.data, biome).forEach((id, i) => {
        const a = (i / 2) * Math.PI * 2 + Math.random();
        const x = o.x + Math.cos(a) * 2.5;
        const y = o.y + Math.sin(a) * 2.5;
        if (gs.world.isFree(x, y, 0.45, 'enemy')) spawnEnemy(gs, id, x, y, { level, elite: true, biome });
      });
      gs.event(o.x, o.y, { k: 'fx', fx: 'boss', x: o.x, y: o.y, ops: [['shake', 0.25], ['emit', 'void', o.x, o.y - 0.4, 18, 0.8, 2]] }, 24);
      gs.toast(p, 'Du letar igenom ruinerna och hittar gamla rikedomar. Något rör sig: väktarna har vaknat!', 'boss');
      break;
    }
    case 'mine': {
      if (!(p.ch.pickaxe > 0)) {
        gs.toast(p, 'Den gamla gruvan har malm kvar. Du behöver en hacka för att gräva.', 'warn');
        return true;
      }
      const haul = mineHaul(gs.world.worldLevel(o.x, o.y));
      drop('stone', haul.stone, o.x, o.y + 0.6);
      for (let i = 0; i < haul.scrap; i++) drop('scrap', 1, o.x, o.y + 0.6);
      for (let i = 0; i < Math.ceil(haul.essence / 2); i++) drop('essence', 2, o.x, o.y + 0.6);
      drop('gold', haul.gold, o.x, o.y + 0.6);
      if (haul.shard) drop('shard', 1, o.x, o.y + 0.6);
      if (haul.map) loot.addPickup(gs, 'mapscroll', o.x, o.y + 0.6, { owner: p.id, lockUntil: now + 60000 });
      gs.event(o.x, o.y, { k: 'fx', fx: 'chest', x: o.x, y: o.y }, 20);
      gs.toast(p, haul.shard ? 'Djupt inne i gruvan glittrar något: en stjärnskärva!' : 'Du gräver fram det gruvarbetarna lämnade kvar.', haul.shard ? 'legendary' : 'component');
      break;
    }
    case 'runestone': {
      addBuff(gs, p, 'attackPower', 15, 300);
      reveal(gs, p, o.x, o.y, REVEAL.runestone);
      const t = unseenPlaces(gs.world, new Set(), [...found(p), ...shown(p)], o.x, o.y, { min: 30, max: 400 })[0];
      if (t) showPlace(gs, p, t);
      gs.event(o.x, o.y, { k: 'fx', fx: 'holy', x: o.x, y: o.y - 0.6 }, 20);
      gs.toast(p, t
        ? `Runorna glöder under din hand (+15 % skada i 5 min). De berättar om ${placeName(gs.data, t, true).toLowerCase()} ${Math.round(t.d)} m ${DIRS_SV[direction(o.x, o.y, t.x, t.y)]} (utmärkt).`
        : 'Runorna glöder under din hand (+15 % skada i 5 min).', 'component');
      break;
    }
    case 'treasure':
      if (!(p.ch.pickaxe > 0)) {
        gs.toast(p, 'Något ligger begravt här. Du behöver en hacka för att gräva upp det.', 'warn');
        return true;
      }
      loot.personalChest(gs, p, o, now, 2.5);
      if (Math.random() < 0.1) drop('shard', 1);
      pals.dropEgg(gs, p, 'treasure', o.x, o.y);
      gs.toast(p, 'En begravd skatt!', 'legendary');
      gs.send(p, { t: 'unpin', x: o.x, y: o.y, label: 'Skatt' });
      break;
    default:
      return false;
  }
  if (def.once) markFound(p, o);
  players.markMe(p);
  players.persist(gs, p);
  return true;
}

// --- Your map ------------------------------------------------------------------------------

/** Places you have been shown (by maps, towers and runestones), so the next one shows something new. */
function shown(p) {
  p.ch.extra.shown ??= [];
  return p.ch.extra.shown;
}

/** The land within r chunks of (x, y) shows on p's map. */
function reveal(gs, p, x, y, r) {
  gs.send(p, { t: 'reveal', x: Math.round(x), y: Math.round(y), r });
}

/** A place goes on p's map (pinned, with the land around it). */
function showPlace(gs, p, t, r = 0) {
  if (r) reveal(gs, p, t.x, t.y, r);
  gs.send(p, { t: 'pin', x: t.x, y: t.y, label: placeName(gs.data, t, true) });
  const list = shown(p);
  if (!list.includes(t.key)) list.push(t.key);
  if (list.length > MAX_SHOWN) list.splice(0, list.length - MAX_SHOWN);
}

/** An old map was picked up: a new part of the world shows on yours. */
export function readMap(gs, p) {
  const t = mapTarget(gs.world, new Set(), [...found(p), ...shown(p)], p.x, p.y);
  reveal(gs, p, p.x, p.y, REVEAL.mapHere);
  if (!t) {
    gs.toast(p, 'En gammal karta, men den visar bara land du redan känner.');
    return;
  }
  showPlace(gs, p, t, REVEAL.map);
  gs.event(p.x, p.y, { k: 'pick', id: p.id, kind: 'shard' }, 12);
  gs.toast(p, `En gammal karta! Den visar ${placeName(gs.data, t, true).toLowerCase()} ${Math.round(t.d)} m ${DIRS_SV[direction(p.x, p.y, t.x, t.y)]}, och landet runt omkring (öppna kartan: M).`, 'legendary');
  players.persist(gs, p);
}

function addBuff(gs, p, stat, value, duration) {
  const existing = p.buffs.find((b) => b.stat === stat && b.source === 'poi');
  if (existing) existing.until = gs.time + duration;
  else p.buffs.push({ stat, value, until: gs.time + duration, source: 'poi' });
  players.recomputeStats(gs, p);
}
