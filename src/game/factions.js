// NPC factions: three to five per world, each with a headquarters in a
// territory of its own, a personality (defender, expansionist, raider,
// strategist) and an AI quality (1-3). They hold territories like you do
// (territory.js), with camps, strongholds and a headquarters for bases, and
// a strategic AI that every few seconds weighs its options: reinforce what
// is threatened, expand into neutral land, raid or attack a neighbour. Its
// armies march along the map from square to square; where they arrive the
// same strength numbers as everywhere decide the fight (close to a player,
// the fight is real: the caller spawns the troops).
//
// Pure rules, shared by single player (campaign.js) and the server
// (server/army.js). The caller hands in a context for everything about
// other owners (the player, clans), what may be attacked and what happens.

import { createRng, hashInts } from '../core/rng.js';
import {
  territoryConfig, territoryKey, parseKey, outpostFor, neighbours, monsterPower, outpostLevel, abstractBattle,
} from './territory.js';

export const PERSONALITIES = ['defender', 'expansionist', 'raider', 'strategist'];
export const PERSONALITY_NAMES = { defender: 'Defender', expansionist: 'Expansionist', raider: 'Raider', strategist: 'Strategist' };
export const PERSONALITY_NAMES_SV = { defender: 'Försvarare', expansionist: 'Expansionist', raider: 'Plundrare', strategist: 'Strateg' };
export const TIERS = ['camp', 'stronghold', 'hq'];

// What each personality likes: [reinforce, expand, raid/attack the player, attack other factions], and how sure of a win it wants to be.
const TASTE = {
  defender: { reinforce: 1.6, expand: 0.5, attack: 0.25, rival: 0.3, margin: 1.4 },
  expansionist: { reinforce: 0.8, expand: 1.6, attack: 0.6, rival: 0.7, margin: 1.1 },
  raider: { reinforce: 0.6, expand: 0.6, attack: 1.5, rival: 1.0, margin: 0.95 },
  strategist: { reinforce: 1.0, expand: 1.0, attack: 0.9, rival: 1.1, margin: 1.25 },
};

export const FACTION_DEFAULTS = {
  count: [3, 5], pool: [], tiers: { camp: { garrison: 3, income: 1 }, stronghold: { garrison: 5, income: 2, upgrade: 90 }, hq: { garrison: 8, income: 3 } },
  aiEverySeconds: 12, marchSpeed: 2.2, reach: 4, maxTerritories: 7, maxArmies: 2, startBank: 60, incomePerMinute: 4, troopCost: 12,
  catchUpHours: 3, plunderPct: 15,
};

export function factionConfig(data) {
  return { ...FACTION_DEFAULTS, ...(data.factions ?? {}) };
}

/** Owner reference for a faction (in territory states that mix owners): 'f:<id>'. */
export function factionRef(id) {
  return `f:${id}`;
}

export function isFactionRef(owner) {
  return typeof owner === 'string' && owner.startsWith('f:');
}

export function factionIdOf(owner) {
  return isFactionRef(owner) ? owner.slice(2) : null;
}

function cheb(a, b) {
  return Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));
}

/**
 * The world's factions, the same for everyone with the same world:
 * { list, owned: { key: { faction, tier, garrison, since } }, armies, nextArmy, aiT }.
 * Headquarters stand three to five squares out, spread around the camp.
 */
export function createFactions(world, data) {
  const cfg = factionConfig(data);
  const rng = createRng(hashInts(world.seed ?? 0, 0xfac7));
  const r = () => rng.next();
  const pool = [...cfg.pool];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const [lo, hi] = cfg.count;
  const n = Math.min(pool.length, lo + Math.floor(r() * (hi - lo + 1)));
  const state = { list: [], owned: {}, armies: [], nextArmy: 1, aiT: 0 };
  const start = r() * Math.PI * 2;
  const taken = [];
  for (let i = 0; i < n; i++) {
    const def = pool[i];
    const a = start + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.4;
    const d = 3 + Math.floor(r() * 2);
    let hq = null;
    for (let k = 0; k < 24 && !hq; k++) {
      const dd = d + (k % 3);
      const aa = a + Math.ceil(k / 3) * 0.18 * (k % 2 ? 1 : -1);
      const tx = Math.round(Math.cos(aa) * dd);
      const ty = Math.round(Math.sin(aa) * dd);
      const sq = { tx, ty };
      if (Math.max(Math.abs(tx), Math.abs(ty)) < 2 || taken.some((t) => cheb(t, sq) < 3)) continue;
      if (outpostFor(world, data, tx, ty)) hq = sq;
    }
    if (!hq) continue;
    taken.push(hq);
    const f = {
      id: def.id, name: def.name, sv: def.sv ?? def.name, color: def.color, personality: PERSONALITIES.includes(def.personality) ? def.personality : 'strategist',
      quality: 1 + Math.floor(r() * 3), hq: territoryKey(hq.tx, hq.ty), bank: cfg.startBank, alive: true,
    };
    state.list.push(f);
    state.owned[f.hq] = { faction: f.id, tier: 'hq', garrison: cfg.tiers.hq.garrison, since: 0 };
    // A camp next door to start with.
    for (const [x, y] of neighbours(hq.tx, hq.ty)) {
      const key = territoryKey(x, y);
      if (state.owned[key] || (x === 0 && y === 0) || !outpostFor(world, data, x, y)) continue;
      state.owned[key] = { faction: f.id, tier: 'camp', garrison: cfg.tiers.camp.garrison, since: 0 };
      break;
    }
  }
  return state;
}

export function factionById(state, id) {
  return state?.list.find((f) => f.id === id) ?? null;
}

export function factionAt(state, key) {
  const e = state?.owned[key];
  return e ? factionById(state, e.faction) : null;
}

export function factionSquares(state, id) {
  return Object.keys(state.owned).filter((k) => state.owned[k].faction === id);
}

/** A faction's troops for a garrison or an army: a captain in a stronghold or headquarters, warriors and archers. */
export function troopsFor(faction, tier, count) {
  const out = [];
  if (tier === 'stronghold' || tier === 'hq') out.push({ kind: `${faction.id}_captain`, elite: true });
  for (let i = out.length; i < count; i++) out.push({ kind: `${faction.id}_${i % 3 === 2 ? 'archer' : 'warrior'}`, elite: false });
  return out;
}

/** What a garrison (or an army of `count`) weighs where it stands. */
export function troopPower(data, faction, tier, count, site) {
  return monsterPower(data, troopsFor(faction, tier, count), site ? outpostLevel(site) : 3);
}

/**
 * One step of every faction: armies march, and every aiEverySeconds the
 * strategic AI thinks. ctx:
 *   world, data, rng(),
 *   ownerOf(key) → { kind: 'player' | 'clan', id } | null (owners other than factions),
 *   defense(key, site) → power of a non-faction owner's defence there (or of the monsters guarding a neutral one),
 *   allowed(key, factionId, kind) → may it march there at all (never your camp, never a dormant outpost …),
 *   live(key, site) → is a player near (then the caller fights it out for real: realAttack),
 *   realAttack(army, site) → spawn the army's troops by the outpost,
 *   taken(key, factionId, fromOwner), lost(key, factionId, toOwner), plunder(owner, pct, faction),
 *   told(text) → a message for the player(s) (optional).
 */
export function stepFactions(state, ctx, dt) {
  const cfg = factionConfig(ctx.data);
  marchArmies(state, ctx, cfg, dt);
  state.aiT = (state.aiT ?? 0) - dt;
  if (state.aiT > 0) return;
  state.aiT = cfg.aiEverySeconds;
  for (const f of state.list) if (f.alive) think(state, ctx, cfg, f);
}

function siteOf(ctx, key) {
  const { tx, ty } = parseKey(key);
  return outpostFor(ctx.world, ctx.data, tx, ty);
}

function think(state, ctx, cfg, f) {
  const mine = factionSquares(state, f.id);
  if (!mine.length) {
    f.alive = false;
    ctx.told?.({ kind: 'gone', faction: f });
    return;
  }
  const taste = TASTE[f.personality] ?? TASTE.strategist;
  const rnd = () => ctx.rng();
  // Income from what it holds.
  let income = 0;
  for (const key of mine) income += cfg.tiers[state.owned[key].tier]?.income ?? 1;
  f.bank = Math.min(800, f.bank + (cfg.incomePerMinute / 60) * cfg.aiEverySeconds * income);
  // Reinforce: the weakest garrison first (defenders do it eagerly).
  const weakest = mine.map((k) => ({ k, e: state.owned[k] })).sort((a, b) => a.e.garrison / cfg.tiers[a.e.tier].garrison - b.e.garrison / cfg.tiers[b.e.tier].garrison)[0];
  if (weakest && weakest.e.garrison < cfg.tiers[weakest.e.tier].garrison && f.bank >= cfg.troopCost && rnd() < 0.5 * taste.reinforce) {
    weakest.e.garrison++;
    f.bank -= cfg.troopCost;
  }
  // Grow a camp into a stronghold.
  const camp = mine.find((k) => state.owned[k].tier === 'camp');
  const up = cfg.tiers.stronghold.upgrade ?? 90;
  if (camp && f.bank >= up * 1.5 && rnd() < 0.15 * taste.reinforce) {
    state.owned[camp].tier = 'stronghold';
    f.bank -= up;
  }
  // One more army in the field?
  const out = state.armies.filter((a) => a.faction === f.id).length;
  if (out >= Math.min(cfg.maxArmies, f.quality)) return;
  const hq = parseKey(f.hq);
  const choices = [];
  for (const key of mine) {
    const from = parseKey(key);
    for (const [tx, ty] of neighbours(from.tx, from.ty)) {
      const tk = territoryKey(tx, ty);
      if (tx === 0 && ty === 0) continue;
      if (cheb({ tx, ty }, hq) > cfg.reach) continue;
      const site = siteOf(ctx, tk);
      if (!site) continue;
      const theirs = state.owned[tk];
      if (theirs?.faction === f.id) continue;
      if (state.armies.some((a) => a.faction === f.id && a.to === tk)) continue;
      const other = theirs ? null : ctx.ownerOf(tk);
      const kind = theirs ? 'rival' : other ? 'attack' : 'expand';
      if (kind === 'expand' && mine.length >= cfg.maxTerritories) continue;
      if (!ctx.allowed(tk, f.id, kind)) continue;
      const defense = theirs
        ? troopPower(ctx.data, factionById(state, theirs.faction), theirs.tier, theirs.garrison, site) * 1.25
        : ctx.defense(tk, site);
      choices.push({ from: key, to: tk, site, kind, defense, value: (site.tier + 1) * taste[kind] });
    }
  }
  if (!choices.length) return;
  // A better AI judges strength more surely; a worse one guesses.
  const noise = [0, 0.45, 0.25, 0.1][f.quality] ?? 0.25;
  for (const c of choices) c.score = (c.value / Math.max(10, c.defense)) * (1 + (rnd() - 0.5) * 2 * noise);
  choices.sort((a, b) => b.score - a.score);
  const pick = choices[0];
  // Troops: what the source can spare (it keeps one), plus what the bank buys.
  const src = state.owned[pick.from];
  const spare = Math.max(0, src.garrison - 1);
  let bought = 0;
  while (f.bank >= cfg.troopCost && spare + bought < 8) {
    bought++;
    f.bank -= cfg.troopCost;
  }
  const troops = spare + bought;
  const cap = cfg.tiers[src.tier].garrison + 2;
  const power = troops >= 2 ? troopPower(ctx.data, f, 'camp', troops, pick.site) : 0;
  if (troops < 2 || power < pick.defense * taste.margin * (1 + (rnd() - 0.5) * noise)) {
    // Not strong enough yet: what it bought joins the garrison.
    src.garrison = Math.min(cap, src.garrison + bought);
    return;
  }
  src.garrison -= spare;
  const fromSite = siteOf(ctx, pick.from);
  const army = {
    id: state.nextArmy++, faction: f.id, kind: pick.kind, from: pick.from, to: pick.to, troops,
    x: fromSite?.x ?? pick.site.x, y: fromSite?.y ?? pick.site.y,
  };
  state.armies.push(army);
  ctx.told?.({ kind: 'march', faction: f, army, target: ctx.ownerOf(pick.to) });
}

function marchArmies(state, ctx, cfg, dt) {
  for (const army of [...state.armies]) {
    const site = siteOf(ctx, army.to);
    if (!site || !factionById(state, army.faction)?.alive) {
      state.armies = state.armies.filter((a) => a !== army);
      continue;
    }
    const dx = site.x - army.x;
    const dy = site.y - army.y;
    const d = Math.hypot(dx, dy);
    const step = cfg.marchSpeed * dt;
    if (d > 6 && d > step) {
      army.x += (dx / d) * step;
      army.y += (dy / d) * step;
      continue;
    }
    state.armies = state.armies.filter((a) => a !== army);
    arrive(state, ctx, cfg, army, site);
  }
}

function arrive(state, ctx, cfg, army, site) {
  const f = factionById(state, army.faction);
  const key = army.to;
  if (!ctx.allowed(key, f.id, army.kind)) {
    returnHome(state, cfg, army);
    return;
  }
  const theirs = state.owned[key];
  if (theirs?.faction === f.id) {
    theirs.garrison = Math.min(cfg.tiers[theirs.tier].garrison + 2, theirs.garrison + army.troops);
    return;
  }
  const other = theirs ? null : ctx.ownerOf(key);
  // A player's (or clan's) square with a player close by: a real fight (the caller spawns the troops).
  if (other && ctx.live(key, site)) {
    ctx.realAttack(army, site);
    return;
  }
  const attack = troopPower(ctx.data, f, 'camp', army.troops, site);
  const defense = theirs
    ? troopPower(ctx.data, factionById(state, theirs.faction), theirs.tier, theirs.garrison, site) * 1.25
    : ctx.defense(key, site);
  const res = abstractBattle(attack, defense, ctx.rng);
  if (!res.win) {
    if (theirs) theirs.garrison = Math.max(1, Math.round(theirs.garrison * (1 - res.defenderLoss)));
    ctx.told?.({ kind: 'repelled', faction: f, key, owner: other });
    return;
  }
  const left = Math.max(1, Math.round(army.troops * (1 - res.attackerLoss)));
  if (theirs) {
    const loser = factionById(state, theirs.faction);
    delete state.owned[key];
    ctx.told?.({ kind: 'rival', faction: f, loser, key });
  } else if (other) {
    // A raider plunders and leaves; the rest take the square.
    if (f.personality === 'raider') {
      ctx.plunder(other, cfg.plunderPct, f);
      ctx.lost(key, f.id, null);
      ctx.told?.({ kind: 'plundered', faction: f, key, owner: other });
      return;
    }
    ctx.lost(key, f.id, factionRef(f.id));
  }
  state.owned[key] = { faction: f.id, tier: 'camp', garrison: Math.min(cfg.tiers.camp.garrison + 1, left), since: Date.now() };
  ctx.taken(key, f.id, other ?? (theirs ? factionRef(theirs.faction) : null));
}

function returnHome(state, cfg, army) {
  const home = state.owned[army.from];
  if (home?.faction === army.faction) home.garrison = Math.min(cfg.tiers[home.tier].garrison + 2, home.garrison + army.troops);
}

/** The player (or a clan) took a faction's square: it is no longer theirs. */
export function loseToOthers(state, key) {
  const e = state.owned[key];
  if (!e) return null;
  delete state.owned[key];
  const f = factionById(state, e.faction);
  if (f && f.hq === key) f.hqLost = true;
  return f;
}

/** A faction takes a square for real (its troops held the flag). */
export function takeFor(state, data, key, factionId) {
  const cfg = factionConfig(data);
  state.owned[key] = { faction: factionId, tier: 'camp', garrison: Math.max(1, cfg.tiers.camp.garrison - 1), since: Date.now() };
}

/** Squares whose armies are close enough to see: within `range` squares of `keys` or of (tx, ty). */
export function visibleArmies(state, data, near, range = 2) {
  const size = territoryConfig(data).size;
  return state.armies.filter((a) => {
    const at = { tx: Math.round(a.x / size), ty: Math.round(a.y / size) };
    return near.some((n) => cheb(n, at) <= range);
  });
}
