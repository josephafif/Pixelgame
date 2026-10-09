// Points of interest in multiplayer: the same small finds as single player
// (src/game/discoveries.js). Each player finds each one for themselves (a
// stash you emptied is still full for the next adventurer), and buried
// treasure is personal loot too.

import { hashInts } from '../src/core/rng.js';
import { POI, nearestTreasure, direction } from '../src/game/discoveries.js';
import * as players from './players.js';
import * as loot from './loot.js';
import * as pals from './pals.js';

const MAX_FOUND = 1500;

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

function addBuff(gs, p, stat, value, duration) {
  const existing = p.buffs.find((b) => b.stat === stat && b.source === 'poi');
  if (existing) existing.until = gs.time + duration;
  else p.buffs.push({ stat, value, until: gs.time + duration, source: 'poi' });
  players.recomputeStats(gs, p);
}
