// JSON requests from a logged-in player: inventory, forge, building, clans,
// chat (with a few slash commands) and admin tools. Every request is
// checked here — the client is never trusted.

import { validateCraft, craftCost, buildCraftRequest } from '../src/weapons/crafting.js';
import { forgePickaxe } from '../src/game/gathering.js';
import { buildBoat } from '../src/game/sailing.js';
import { researchCost } from '../src/game/base.js';
import { MP_RESOURCE_KEYS } from '../src/net/mpsave.js';
import { describeRaidWindow, passwordProblem } from '../src/net/rules.js';
import { hashPassword } from './auth.js';
import * as players from './players.js';
import * as loot from './loot.js';
import * as pals from './pals.js';
import * as markets from './markets.js';
import * as building from './building.js';
import * as clans from './clans.js';
import * as base from './base.js';

const NO_FORGE = 'Gå till en smedja: i Fristaden (upp till sällsynta vapen) eller i er bas';

function vsave(gs, p, forge = null) {
  return base.saveFor(gs, p, forge);
}

function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function findItem(p, id) {
  const bag = p.inv.bag.find((w) => w.id === id);
  if (bag) return { dna: bag, place: 'bag' };
  const st = p.inv.storage.find((w) => w.id === id);
  return st ? { dna: st, place: 'storage' } : null;
}

/** A guest's password, so they can log in with their name from anywhere. */
async function setPassword(gs, p, password) {
  if (!p.accountId.startsWith('guest:')) return 'Ditt konto loggar in via e-post, Google eller Discord';
  const problem = passwordProblem(password);
  if (problem) return problem;
  const now = Date.now();
  if (now - (p.passwordAt ?? 0) < 3000) return 'Vänta lite innan du försöker igen';
  p.passwordAt = now;
  const hash = await hashPassword(password);
  gs.db.setPassword(p.accountId, hash);
  gs.log.info(`[account] ${p.name} set a password`);
  return null;
}

/** Handles one request. Returns null (ok) or a problem text (or a promise of one). */
export function handle(gs, p, msg) {
  switch (msg.t) {
    case 'ping':
      gs.send(p, { t: 'pong', c: msg.c, s: Date.now(), tick: gs.tick });
      return null;
    case 'chat':
      return chat(gs, p, msg);
    case 'build':
      return building.place(gs, p, String(msg.id ?? ''), Number(msg.x), Number(msg.y));
    case 'unbuild':
      return building.remove(gs, p, Number(msg.x), Number(msg.y));
    case 'equip':
      return equip(gs, p, String(msg.id ?? ''), msg.slot === 'secondary' ? 'secondary' : 'main');
    case 'pal':
      return pals.request(gs, p, msg);
    case 'research': {
      const def = gs.data.byId.components.get(String(msg.id ?? ''));
      const entry = def ? p.ch.extra.components?.[def.id] : null;
      if (!def || !entry) return 'Den komponenten har du inte hittat';
      if (entry.researched) return 'Redan utforskad';
      const cost = researchCost(gs.data, vsave(gs, p), def);
      if ((p.ch.resources.essence ?? 0) < cost) return `Kräver ${cost} essens`;
      p.ch.resources.essence -= cost;
      entry.researched = true;
      players.persist(gs, p);
      players.markMe(p);
      gs.toast(p, `${def.name} är utforskad!`, 'component');
      return null;
    }
    case 'market':
      return markets.request(gs, p, msg);
    case 'base':
      return base.request(gs, p, msg);
    case 'recall':
      return players.recall(gs, p, msg.op === 'back' ? 'back' : 'go');
    case 'move':
      return moveItem(gs, p, String(msg.id ?? ''), msg.to === 'storage' ? 'storage' : 'bag');
    case 'salvage': {
      const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 60).map(String) : [];
      const res = loot.salvage(gs, p, ids);
      if (!res) return 'Kunde inte smälta ner';
      if (res.count) gs.toast(p, `Smälte ner ${res.count} vapen: ${res.scrap} skrot och ${res.essence} essens${res.shards ? ` och ${res.shards} stjärnskärva` : ''}.`);
      return null;
    }
    case 'drop':
      return loot.dropFromBag(gs, p, String(msg.id ?? ''));
    case 'fav': {
      const id = String(msg.id ?? '');
      if (!findItem(p, id)) return 'Det vapnet har du inte';
      const on = !p.inv.favorites.includes(id);
      p.inv.favorites = on ? [...p.inv.favorites, id] : p.inv.favorites.filter((f) => f !== id);
      gs.send(p, { t: 'loadout', equipped: p.inv.equipped, secondary: p.inv.secondary, activeSlot: p.inv.activeSlot, favorites: p.inv.favorites });
      return null;
    }
    case 'craft':
      return craft(gs, p, msg.choice ?? {});
    case 'pickaxe': {
      const forge = base.forgeAt(gs, p);
      if (!forge) return NO_FORGE;
      const save = vsave(gs, p, forge);
      try {
        const def = forgePickaxe(gs.data, save, Number(msg.tier));
        p.ch.pickaxe = def.tier;
        players.persist(gs, p);
        gs.db.log(p.accountId, 'pickaxe', null, { tier: def.tier });
        players.markMe(p);
        p.infoRev++;
        gs.send(p, { t: 'loadout', equipped: p.inv.equipped, secondary: p.inv.secondary, activeSlot: p.inv.activeSlot, favorites: p.inv.favorites });
        gs.toast(p, `${def.name} smidd! Gå fram till ett träd eller en sten och hacka (3).`, 'level');
        return null;
      } catch (err) {
        return err.message;
      }
    }
    case 'boat': {
      const forge = base.forgeAt(gs, p);
      if (!forge) return NO_FORGE;
      const save = vsave(gs, p, forge);
      try {
        const def = buildBoat(gs.data, save, Number(msg.tier));
        p.ch.extra.boat = def.tier;
        players.persist(gs, p);
        gs.db.log(p.accountId, 'boat', null, { tier: def.tier });
        players.markMe(p);
        gs.toast(p, `${def.name} byggd! Gå ner till vattnet och tryck Använd för att segla ut.`, 'level');
        return null;
      } catch (err) {
        return err.message;
      }
    }
    case 'spawnAt':
      p.ch.extra.spawnAt = msg.at === 'town' ? 'town' : 'banner';
      players.markMe(p);
      return null;
    case 'pvp':
      if (!p.ch.pvpOptIn) {
        p.ch.pvpOptIn = true;
        p.newbie = false;
        players.markMe(p);
        gs.toast(p, 'Nybörjarskyddet är avstängt. Lycka till där ute!', 'warn');
      }
      return null;
    case 'clan':
      return clans.handle(gs, p, msg);
    case 'password':
      return setPassword(gs, p, msg.password);
    case 'who':
      gs.send(p, { t: 'who', list: whoList(gs) });
      return null;
    default:
      return 'Okänt kommando';
  }
}

function whoList(gs) {
  return [...gs.players.values()].filter((o) => o.conn).map((o) => ({
    name: o.name, tag: o.clanId ? gs.clans.get(o.clanId)?.tag ?? null : null, level: o.ch.level,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// --- Inventory -------------------------------------------------------------------------

function equip(gs, p, id, slot) {
  let item = findItem(p, id);
  if (!item) return 'Det vapnet har du inte';
  if (item.place === 'storage') {
    // From the town vault into the bag first.
    const problem = moveItem(gs, p, id, 'bag');
    if (problem) return problem;
    item = findItem(p, id);
  }
  const inv = p.inv;
  const key = slot === 'secondary' ? 'secondary' : 'equipped';
  const other = key === 'equipped' ? 'secondary' : 'equipped';
  if (inv[other] === id) inv[other] = inv[key] ?? null;
  inv[key] = id;
  players.applySlot(gs, p, slot === 'secondary' ? 'secondary' : 'main');
  players.persist(gs, p);
  return null;
}

function moveItem(gs, p, id, to) {
  if (!base.ownNear(gs, p, 'vault')) return 'Förrådet står i er bas: gå dit (bygg ett förråd med Bygg-menyn)';
  const item = findItem(p, id);
  if (!item) return 'Det vapnet har du inte';
  if (item.place === to) return null;
  if (to === 'storage' && (p.inv.equipped === id || p.inv.secondary === id)) return 'Ta bort vapnet från din utrustning först';
  const sizes = base.sizesFor(gs, p);
  if (to === 'bag' && p.inv.bag.length >= sizes.bagSize) return 'Väskan är full';
  if (to === 'storage' && p.inv.storage.length >= sizes.storageSize) return 'Förrådet är fullt';
  try {
    gs.db.moveItem(id, { fromOwner: p.accountId, toOwner: p.accountId, place: to });
  } catch {
    return 'Kunde inte flytta vapnet';
  }
  const from = item.place === 'bag' ? p.inv.bag : p.inv.storage;
  from.splice(from.indexOf(item.dna), 1);
  (to === 'bag' ? p.inv.bag : p.inv.storage).push(item.dna);
  gs.send(p, { t: 'inv>', id, place: to });
  return null;
}

// --- Forge -------------------------------------------------------------------------------

function craft(gs, p, raw) {
  const forge = base.forgeAt(gs, p);
  if (!forge) return NO_FORGE;
  const choice = {
    archetype: String(raw.archetype ?? ''),
    material: String(raw.material ?? ''),
    core: raw.core ? String(raw.core) : null,
    rune: raw.rune ? String(raw.rune) : null,
    ability: raw.ability ? String(raw.ability) : null,
    catalyst: raw.catalyst ? String(raw.catalyst) : 'none',
  };
  const save = vsave(gs, p, forge);
  const errors = validateCraft(gs.data, save, choice);
  if (errors.length) return forge.town && /^Forge level/.test(errors[0]) ? 'Fristadens smedja smider bara upp till sällsynta vapen: bygg en smedja i er bas för bättre katalysatorer' : errors[0];
  const sizes = base.sizesFor(gs, p);
  if (p.inv.bag.length >= sizes.bagSize) return 'Väskan är full: gör plats för det nya vapnet';
  const cost = craftCost(gs.data, choice, save);
  const request = buildCraftRequest(gs.data, save, choice, Math.floor(p.stats.luck));
  const dna = loot.generate(gs, { ...request, craft: request.craft, minRarity: request.minRarity, maxRarity: request.maxRarity });
  const r = p.ch.resources;
  r.scrap -= cost.scrap;
  r.essence -= cost.essence;
  if (cost.shards) r.shards -= cost.shards;
  p.ch.extra.crafts = (p.ch.extra.crafts ?? 0) + 1;
  try {
    gs.db.tx(() => {
      gs.db.insertItem({ id: dna.id, ownerId: p.accountId, place: 'bag', dna, source: 'craft' });
      players.persist(gs, p);
      gs.db.log(p.accountId, 'craft', dna.id, { cost, rarity: dna.rarity });
    });
  } catch (err) {
    r.scrap += cost.scrap;
    r.essence += cost.essence;
    if (cost.shards) r.shards += cost.shards;
    gs.log.error('[craft] failed', err);
    return 'Smedjan krånglade, försök igen';
  }
  p.inv.bag.push(dna);
  gs.send(p, { t: 'inv+', place: 'bag', dna, crafted: true, catalyst: choice.catalyst });
  if (!p.inv.equipped) {
    p.inv.equipped = dna.id;
    players.applySlot(gs, p, 'main');
  }
  players.markMe(p);
  if (dna.rarity === 'legendary') gs.broadcast({ t: 'toast', text: `${p.name} smidde ett LEGENDARISKT vapen: ${dna.name.text}!`, kind: 'legendary' });
  return null;
}

// --- Chat ----------------------------------------------------------------------------------

function chat(gs, p, msg) {
  const now = Date.now();
  let text = cleanText(msg.text, 200);
  if (!text) return null;
  // Chat lines are rate limited (commands go through the normal message limit).
  const command = text.startsWith('/') && !/^\/(c|klan)\s/i.test(text);
  if (!command) {
    if (now - (p.lastChat ?? 0) < 900) return 'Du skriver för snabbt';
    p.lastChat = now;
  }
  let channel = msg.ch === 'clan' ? 'clan' : 'all';
  if (text.startsWith('/')) {
    const [cmd, ...args] = text.slice(1).split(' ');
    const rest = args.join(' ');
    switch (cmd.toLowerCase()) {
      case 'c':
      case 'klan':
        channel = 'clan';
        text = rest;
        break;
      case 'who':
      case 'vilka':
        gs.send(p, { t: 'who', list: whoList(gs) });
        return null;
      case 'help':
      case 'hjälp':
        gs.send(p, { t: 'sys', text: 'Kommandon: /c text (klanchatt), /who (vilka är online), /raid (raidregler)' + (p.isAdmin ? ' · Admin: /kick, /ban, /unban, /tp, /give, /announce, /save, /password namn nyttlösenord' : '') });
        return null;
      case 'raid': {
        const st = p.clanId ? gs.raidState(p.clanId) : null;
        gs.send(p, { t: 'sys', text: `Raidfönster: ${describeRaidWindow(gs.raidWindows)}. Baser kan raidas när någon i klanen är online, och ${gs.rules.raidGraceMinutes} min efter att sista loggat ut.${st ? ` Er bas: ${st.raidable ? 'kan raidas nu' : 'skyddad just nu'}.` : ''}` });
        return null;
      }
      default:
        if (p.isAdmin) return admin(gs, p, cmd.toLowerCase(), args);
        return 'Okänt kommando (skriv /help)';
    }
    if (!text) return null;
  }
  const tag = p.clanId ? gs.clans.get(p.clanId)?.tag ?? null : null;
  const out = { t: 'chat', from: p.name, tag, text, ch: channel, at: now };
  if (channel === 'clan') {
    if (!p.clanId) return 'Du är inte med i någon klan';
    gs.broadcast(out, (o) => o.clanId === p.clanId);
  } else {
    gs.broadcast(out);
  }
  return null;
}

function admin(gs, p, cmd, args) {
  const target = () => {
    const name = (args[0] ?? '').toLowerCase();
    return [...gs.players.values()].find((o) => o.name.toLowerCase() === name) ?? null;
  };
  switch (cmd) {
    case 'kick': {
      const t = target();
      if (!t) return 'Ingen sådan spelare online';
      t.conn?.kick(args.slice(1).join(' ') || 'Utsparkad av en admin');
      return null;
    }
    case 'ban': {
      const acc = gs.db.accountByName(args[0] ?? '');
      if (!acc) return 'Ingen sådan spelare';
      const hours = Number(args[1]) || 24 * 365;
      gs.db.ban(acc.id, Date.now() + hours * 3600 * 1000, args.slice(2).join(' ') || null);
      gs.byAccount.get(acc.id)?.conn?.kick('Avstängd');
      gs.log.warn(`[admin] ${p.name} banned ${acc.name} for ${hours} h`);
      gs.send(p, { t: 'sys', text: `${acc.name} är avstängd i ${hours} timmar.` });
      return null;
    }
    case 'unban': {
      const acc = gs.db.accountByName(args[0] ?? '');
      if (!acc) return 'Ingen sådan spelare';
      gs.db.ban(acc.id, 0, null);
      gs.send(p, { t: 'sys', text: `${acc.name} får spela igen.` });
      return null;
    }
    case 'tp': {
      const x = Number(args[0]);
      const y = Number(args[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Använd: /tp x y';
      const spot = gs.world.findFreeSpot(x, y, p.r);
      p.x = spot.x;
      p.y = spot.y;
      gs.send(p, { t: 'teleport', x: p.x, y: p.y });
      return null;
    }
    case 'give': {
      const kind = args[0];
      const n = Math.floor(Number(args[1]));
      if (!MP_RESOURCE_KEYS.includes(kind) || !Number.isFinite(n)) return `Använd: /give ${MP_RESOURCE_KEYS.join('|')} antal`;
      p.ch.resources[kind] = Math.max(0, (p.ch.resources[kind] ?? 0) + n);
      gs.db.log(p.accountId, 'admin-give', null, { kind, n });
      players.markMe(p);
      return null;
    }
    case 'announce':
      gs.broadcast({ t: 'toast', text: args.join(' ').slice(0, 200), kind: 'boss' });
      return null;
    case 'save':
      gs.saveAll();
      gs.send(p, { t: 'sys', text: 'Sparat.' });
      return null;
    case 'password': {
      // Someone forgot their password: /password name newpassword
      const pw = args.at(-1) ?? '';
      const acc = args.length >= 2 ? gs.db.accountByName(args.slice(0, -1).join(' ')) : null;
      if (!acc) return 'Använd: /password namn nyttlösenord';
      if (!acc.id.startsWith('guest:')) return 'Den spelaren loggar in med e-post, Google eller Discord';
      const problem = passwordProblem(pw);
      if (problem) return problem;
      return hashPassword(pw).then((hash) => {
        gs.db.setPassword(acc.id, hash);
        gs.log.warn(`[admin] ${p.name} set a new password for ${acc.name}`);
        gs.send(p, { t: 'sys', text: `${acc.name} har fått ett nytt lösenord.` });
        return null;
      });
    }
    default:
      return 'Okänt kommando';
  }
}
