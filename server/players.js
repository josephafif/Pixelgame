// Players on the server: joining, inputs (with the anti-speedhack budget),
// movement, actions, death and respawn, persistence.

import { stepMove, dash, PLAYER_RADIUS, TICK_DT, TICK_RATE, LEAP_TIME, DASH_TIME } from '../src/net/movement.js';
import { hasSkill, dashCooldown, GALE_STEP } from '../src/game/skills.js';
import { BTN, CMD, byteToAngle } from '../src/net/protocol.js';
import { computePlayerStats, xpToNext } from '../src/game/stats.js';
import { compileWeapon } from '../src/game/combat.js';
import { currentPickaxe, findHarvestTarget } from '../src/game/gathering.js';
import { inSafeZone, isNewbie } from '../src/net/rules.js';
import { MP_RESOURCE_KEYS } from '../src/net/mpsave.js';
import { T } from '../src/game/world.js';
import { baseBonuses, GARDEN_WARD_LEVEL, TONIC } from '../src/game/base.js';
import { currentBoat, boatMode, findLaunch, findLanding } from '../src/game/sailing.js';
import * as combat from './combat.js';
import * as loot from './loot.js';
import * as building from './building.js';
import * as abilities from './abilities.js';
import * as discoveries from './discoveries.js';
import * as markets from './markets.js';
import * as base from './base.js';
import * as horses from './horses.js';

// Inputs waiting to be simulated; beyond this the oldest are dropped.
const MAX_QUEUE = 12;
// One input may be simulated per tick, plus this much catch-up after a
// network hiccup. A client sending inputs faster than real time gains
// nothing: the extra inputs just pile up and are dropped.
const MAX_CREDITS = 4;
const INTERACT_RADIUS = 1.6;
export const TOWN_SPAWN = { x: 0.5, y: 1.6 };

export function newCharacter(accountId) {
  return {
    accountId,
    x: TOWN_SPAWN.x,
    y: TOWN_SPAWN.y + 1,
    hp: 0,
    level: 1,
    xp: 0,
    resources: { essence: 0, scrap: 0, wood: 0, stone: 0, gold: 0, shards: 0 },
    pickaxe: 0,
    loadout: { equipped: null, secondary: null, activeSlot: 'main', favorites: [] },
    spawn: null,
    playSeconds: 0,
    firstBoss: false,
    pvpOptIn: false,
    deaths: 0,
    kills: 0,
    pvpKills: 0,
    extra: { codex: { modifiers: [], abilities: [] }, bosses: {}, crafts: 0, spawnAt: 'banner' },
  };
}

/** Creates the in-world player for an account (from the database). */
export function createPlayer(gs, account, ch, items) {
  for (const k of MP_RESOURCE_KEYS) ch.resources[k] = Math.max(0, Math.floor(ch.resources[k] ?? 0));
  ch.extra ??= {};
  ch.extra.codex ??= { modifiers: [], abilities: [] };
  ch.extra.bosses ??= {};
  const inv = {
    bag: items.filter((i) => i.place === 'bag').map((i) => i.dna),
    storage: items.filter((i) => i.place === 'storage').map((i) => i.dna),
    equipped: ch.loadout.equipped ?? null,
    secondary: ch.loadout.secondary ?? null,
    activeSlot: ch.loadout.activeSlot ?? 'main',
    favorites: (ch.loadout.favorites ?? []).filter((id) => items.some((i) => i.id === id)),
  };
  if (inv.equipped && !inv.bag.some((w) => w.id === inv.equipped)) inv.equipped = null;
  if (inv.secondary && !inv.bag.some((w) => w.id === inv.secondary)) inv.secondary = null;
  const p = {
    id: gs.newId(),
    accountId: account.id,
    name: account.name,
    isAdmin: false,
    conn: null,
    ch,
    inv,
    x: ch.x,
    y: ch.y,
    kx: 0,
    ky: 0,
    r: PLAYER_RADIUS,
    facing: 0,
    hp: ch.hp,
    maxHp: 100,
    dead: false,
    respawnAt: 0,
    weapon: null,
    stats: null,
    speed: gs.data.player.moveSpeed,
    clanId: gs.memberOf.get(account.id) ?? null,
    queue: [],
    credits: MAX_CREDITS,
    idleTicks: 0,
    lastSeq: 0,
    lastQueued: 0,
    lastView: 0,
    attackCd: 0,
    toolCd: 0,
    anim: 0,
    guard: 1,
    attackHeld: false,
    suppressAttack: false,
    statuses: {},
    buffs: [],
    protectUntil: 0,
    invulnUntil: 0, // a moment after a Blink or a Phoenix rebirth
    ascend: null, // Ascension: { until, color }
    blinkTick: -1,
    combatUntil: 0,
    lastHurtAt: 0,
    asleep: false,
    asleepUntil: 0,
    moving: false,
    sprinting: false,
    harvest: new Map(),
    infoRev: 1,
    events: [],
    meDirty: true,
    view: { known: new Map(), chunks: new Set(), pinfo: new Map(), dna: new Set(), lastChunk: null },
    dmgDone: 0,
    joinedAt: Date.now(),
    lastSave: Date.now(),
  };
  applySlot(gs, p, inv.activeSlot, { quiet: true });
  if (!p.hp || p.hp <= 0) p.hp = p.maxHp;
  p.hp = Math.min(p.hp, p.maxHp);
  // Saved at sea: keep sailing if the boat still floats there.
  p.sailing = Boolean(ch.extra.sailing && boatOf(gs, p) && gs.world.isFree(p.x, p.y, p.r, boatMode(boatOf(gs, p))));
  // Safe placement (the world may have changed while they were away).
  gs.world.gateFilter = (st) => st.clanId && st.clanId === p.clanId;
  if (!p.sailing && !gs.world.isFree(p.x, p.y, p.r)) Object.assign(p, gs.world.findFreeSpot(p.x, p.y, p.r, 'player', TOWN_SPAWN));
  gs.world.gateFilter = null;
  p.newbie = isNewbie(gs.rules, ch);
  return p;
}

// --- Stats / loadout ---------------------------------------------------------------

// Your clan's buildings (the Hearth's health, the Training Grounds' attack
// and defense) count for you wherever you are, as the camp does in single player.
function statSave(gs, p) {
  return {
    player: { level: p.ch.level, bonusLuck: 0, bonusHp: p.ch.extra?.bonusHp ?? 0 },
    base: { buildings: base.levelsFor(gs, p), beacon: building.beaconFor(gs, p.clanId) },
  };
}

export function recomputeStats(gs, p) {
  const before = p.maxHp;
  const dna = p.weapon?.dna ?? null;
  const save = statSave(gs, p);
  p.stats = computePlayerStats(gs.data, save, dna, p.buffs);
  // The clan's Healing Garden: healing out of a fight, and from level 2 a ward against the bogs.
  p.regenPct = baseBonuses(gs.data, save).regenPct ?? 0;
  p.gardenLevel = save.base.buildings.garden ?? 0;
  p.maxHp = p.stats.maxHp;
  if (before && before !== p.maxHp && p.hp > 0) p.hp = Math.min(p.maxHp, p.hp * (p.maxHp / before));
  const chilled = p.statuses.chill?.until > gs.time;
  p.speed = p.stats.moveSpeed * (chilled ? 0.65 : 1);
}

function slotDna(p, slot) {
  const id = slot === 'secondary' ? p.inv.secondary : p.inv.equipped;
  return id ? p.inv.bag.find((w) => w.id === id) ?? null : null;
}

/** Switches what the player holds: 'main' | 'secondary' | 'tool' | 'none'. */
export function applySlot(gs, p, slot, { quiet = false } = {}) {
  const inv = p.inv;
  if (slot === 'tool' && !(p.ch.pickaxe > 0)) slot = inv.activeSlot === 'tool' ? 'main' : inv.activeSlot;
  if (slot === 'secondary' && !inv.secondary) slot = 'main';
  inv.activeSlot = slot;
  const dna = slot === 'main' || slot === 'secondary' ? slotDna(p, slot) ?? slotDna(p, 'main') : null;
  if (dna?.id !== p.weapon?.dna.id) p.weapon = dna ? compileWeapon(dna, gs.data) : null;
  if (slot === 'tool' || slot === 'none') {
    // Keep the main weapon's stats (defense etc.) but nothing in hand.
    const main = slotDna(p, 'main');
    if (main && main.id !== p.weapon?.dna.id) p.weapon = compileWeapon(main, gs.data);
  }
  p.attackCd = Math.max(p.attackCd, 0.25);
  recomputeStats(gs, p);
  p.infoRev++;
  if (!quiet) gs.send(p, { t: 'loadout', equipped: inv.equipped, secondary: inv.secondary, activeSlot: inv.activeSlot });
}

/** The weapon actually in hand (null with the pickaxe or empty hands). */
export function heldWeapon(p) {
  const s = p.inv.activeSlot;
  return s === 'main' || s === 'secondary' ? p.weapon : null;
}

export function markMe(p) {
  p.meDirty = true;
}

export function mePayload(gs, p) {
  const clan = p.clanId ? gs.clans.get(p.clanId) : null;
  const member = clan?.members.get(p.accountId);
  return {
    t: 'me',
    name: p.name,
    level: p.ch.level,
    xp: p.ch.xp,
    xpNext: xpToNext(gs.data, p.ch.level),
    resources: p.ch.resources,
    pickaxe: p.ch.pickaxe,
    boat: p.ch.extra.boat ?? 0,
    playSeconds: Math.floor(p.ch.playSeconds),
    newbie: p.newbie,
    pvpOptIn: p.ch.pvpOptIn,
    protectUntil: p.protectUntil,
    clan: clan ? { id: clan.id, name: clan.name, tag: clan.tag, role: member?.role ?? 'member' } : null,
    spawnAt: p.ch.extra.spawnAt ?? 'banner',
    bosses: p.ch.extra.bosses,
    codex: p.ch.extra.codex,
    crafts: p.ch.extra.crafts ?? 0,
    pals: p.ch.extra.pals ?? null,
    found: p.ch.extra.found ?? [],
    recallAt: p.ch.extra.recallAt ?? 0,
    components: p.ch.extra.components ?? {},
    markets: p.ch.extra.markets ?? {},
    recallFrom: p.ch.extra.recallFrom ?? null,
    horses: horses.payload(p),
    stats: p.stats,
    dashCd: dashCooldownOf(gs, p),
    tonicLeft: Math.max(0, (p.tonicUntil ?? 0) - gs.time),
    kills: p.ch.kills,
    deaths: p.ch.deaths,
    pvpKills: p.ch.pvpKills,
    admin: p.isAdmin,
  };
}

export function inventoryPayload(gs, p) {
  return { t: 'inv', ...p.inv, ...base.sizesFor(gs, p) };
}

/** What other players see about this one (name, clan, weapon in hand). */
export function infoPayload(gs, p) {
  const clan = p.clanId ? gs.clans.get(p.clanId) : null;
  return {
    t: 'pinfo',
    id: p.id,
    name: p.name,
    clanId: p.clanId,
    tag: clan?.tag ?? null,
    weapon: heldWeapon(p)?.dna ?? null,
    slot: p.inv.activeSlot,
    pickaxe: p.ch.pickaxe,
  };
}

// --- XP ------------------------------------------------------------------------------

export function addXp(gs, p, amount) {
  const ch = p.ch;
  ch.xp += Math.max(0, Math.round(amount));
  let leveled = false;
  while (ch.xp >= xpToNext(gs.data, ch.level) && ch.level < 99) {
    ch.xp -= xpToNext(gs.data, ch.level);
    ch.level += 1;
    leveled = true;
  }
  if (leveled) {
    recomputeStats(gs, p);
    p.hp = p.maxHp;
    gs.send(p, { t: 'levelup', level: ch.level });
    gs.event(p.x, p.y, { k: 'fx', fx: 'levelup', x: p.x, y: p.y });
    p.infoRev++;
  }
  markMe(p);
}

// --- Inputs ------------------------------------------------------------------------------

/** Queues input frames from the client (duplicates and replays ignored). */
export function receiveInput(gs, p, frames) {
  for (const f of frames) {
    if (f.seq <= p.lastQueued) continue;
    if (f.seq > p.lastQueued + 1000) continue; // nonsense jump
    p.lastQueued = f.seq;
    p.queue.push(f);
  }
  if (p.queue.length > MAX_QUEUE) {
    const drop = p.queue.length - MAX_QUEUE;
    p.queue.splice(0, drop);
    p.dropped = (p.dropped ?? 0) + drop;
  }
}

export function update(gs, p, now) {
  const dt = TICK_DT;
  p.attackCd = Math.max(0, p.attackCd - dt);
  p.toolCd = Math.max(0, p.toolCd - dt);
  if (p.dead) {
    p.queue.length = 0;
    if (now >= p.respawnAt && p.conn) respawn(gs, p, now);
    else if (now >= p.respawnAt && !p.conn) gs.removePlayer?.(p);
    return;
  }
  if (p.asleep) {
    if (now >= p.asleepUntil) gs.removePlayer?.(p);
  } else {
    p.credits = Math.min(MAX_CREDITS, p.credits + 1);
    // One frame per tick keeps movement smooth even when a client sends its
    // frames in pairs; only a real backlog (a hiccup in the network) is
    // caught up faster. Never more frames than ticks: no speed hacks.
    const backlog = (gs.config.inputEvery ?? 1) + 1;
    let n = 0;
    while (p.credits >= 1 && p.queue.length && n < MAX_CREDITS && (n === 0 || p.queue.length > backlog)) {
      const f = p.queue.shift();
      p.credits -= 1;
      n++;
      applyFrame(gs, p, f, now);
      if (p.dead) break;
    }
    if (n) p.idleTicks = 0;
    else if (++p.idleTicks > backlog) p.moving = false;
    p.ch.playSeconds += dt;
  }
  tickStatuses(gs, p, dt, now);
  // The fen's bog sickens you, unless the clan's Healing Garden or a Lumen Tonic wards you.
  if (!p.dead && !p.sailing && gs.world.groundAt(Math.floor(p.x), Math.floor(p.y)) === T.BOG
    && (p.gardenLevel ?? 0) < GARDEN_WARD_LEVEL && !(p.tonicUntil > gs.time)) {
    p.bogT = (p.bogT ?? 0) + dt;
    if (p.bogT >= 1.5) {
      p.bogT = 0;
      applyPlayerStatus(gs, p, 'poison', 1.5 + p.ch.level * 0.4);
    }
  } else {
    p.bogT = 0;
  }
  // Out of a fight you slowly heal; in town quickly (the Healing Garden and a Lumen Tonic help).
  if (!p.dead && p.hp < p.maxHp) {
    const town = inSafeZone(gs.rules, p.x, p.y);
    const calm = now - p.lastHurtAt > 6000;
    const extra = (calm ? p.regenPct ?? 0 : 0) / 100 + (p.tonicUntil > gs.time ? TONIC.regenPct / 100 : 0);
    if (town || calm || extra) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * ((town ? 0.08 : calm ? 0.012 : 0) + extra) * dt);
  }
  if (p.buffs.length && p.buffs.some((b) => b.until <= gs.time)) {
    p.buffs = p.buffs.filter((b) => b.until > gs.time);
    recomputeStats(gs, p);
  }
  if (gs.tick % TICK_RATE === 0) {
    const newbie = isNewbie(gs.rules, p.ch);
    if (newbie !== p.newbie) {
      p.newbie = newbie;
      if (!newbie) gs.toast(p, 'Ditt nybörjarskydd är slut: nu kan andra spelare skada dig i vildmarken.', 'warn');
      markMe(p);
    }
  }
}

function applyFrame(gs, p, f, now) {
  p.lastSeq = f.seq;
  p.lastView = Math.min(f.view, gs.tick);
  p.lastTarget = f.target; // your pal helps with whatever you fight
  if (f.cmd) command(gs, p, f.cmd);
  // Movement: the same code the client predicts with.
  gs.world.gateFilter = (st) => Boolean(st.clanId) && st.clanId === p.clanId;
  const mv = moveParams(gs, p);
  if (f.buttons & BTN.DASH) galeStep(gs, p, f, mv, now);
  stepMove(gs.world, p, f, mv.speed, mv.sprint, p.r, mv.mode);
  gs.world.gateFilter = null;
  if (p.leap) {
    // A horse leapt a gap in the clouds: everyone around sees the arc.
    p.leapUntil = gs.time + LEAP_TIME;
    p.leap = null;
  }
  p.moving = f.mx !== 0 || f.my !== 0;
  p.sprinting = p.moving && (f.buttons & BTN.SPRINT) !== 0;
  const aim = byteToAngle(f.aim);
  p.facing = aim;
  if (!(f.buttons & BTN.ATTACK)) p.suppressAttack = false;
  if (f.buttons & BTN.INTERACT) {
    if (interact(gs, p, now)) p.suppressAttack = true;
  }
  if ((f.buttons & BTN.ATTACK) && !p.suppressAttack) {
    if (p.inv.activeSlot === 'tool') toolSwing(gs, p, aim, now);
    else if (heldWeapon(p)) combat.tryAttack(gs, p, aim, f.target, now);
  }
  if (f.buttons & BTN.ABILITY && p.inv.activeSlot !== 'tool') abilities.cast(gs, p, aim, f.target, now);
}

// A little slack: the client's clock and the server's tick never agree to the millisecond.
const DASH_SLACK = 0.15;

/** The cooldown of your Gale Step (the clan's Wind Beacon shortens it). */
export function dashCooldownOf(gs, p) {
  return dashCooldown(building.beaconFor(gs, p.clanId));
}

/**
 * Gale Step (V): a quick dash that slips past attacks. The client predicts
 * it with the same code (movement.js: dash), on the frame it pressed it.
 */
function galeStep(gs, p, f, mv, now) {
  if (p.dead || p.sailing || mv.mode === 'boat' || p.asleep) return;
  if ((p.dashReadyAt ?? 0) - DASH_SLACK > gs.time) return;
  if (!hasSkill(gs.data, p.ch.extra.components, GALE_STEP.id)) return;
  if (!dash(gs.world, p, f, p.r, mv.mode)) return;
  p.dash = null;
  p.dashReadyAt = gs.time + dashCooldownOf(gs, p);
  p.dashUntil = gs.time + DASH_TIME;
  p.invulnUntil = Math.max(p.invulnUntil ?? 0, now + DASH_TIME * 1000);
}

function command(gs, p, cmd) {
  const slots = { [CMD.SLOT_MAIN]: 'main', [CMD.SLOT_SECONDARY]: 'secondary', [CMD.SLOT_TOOL]: 'tool', [CMD.SLOT_NONE]: 'none' };
  if (slots[cmd]) {
    const want = slots[cmd];
    if (want === p.inv.activeSlot || want === 'none') applySlot(gs, p, 'none');
    else if (want === 'tool' && !(p.ch.pickaxe > 0)) gs.toast(p, 'Ingen hacka än: smid en i Fristadens smedja.', 'warn');
    else if (want === 'secondary' && !p.inv.secondary) gs.toast(p, 'Inget andravapen: välj ett i väskan.', 'warn');
    else applySlot(gs, p, want);
  } else if (cmd === CMD.SLOT_NEXT || cmd === CMD.SLOT_PREV) {
    const order = ['main', 'secondary', 'tool'].filter((s) => (s === 'main' && p.inv.equipped) || (s === 'secondary' && p.inv.secondary) || (s === 'tool' && p.ch.pickaxe > 0));
    if (order.length < 2) return;
    const i = order.indexOf(p.inv.activeSlot);
    applySlot(gs, p, order[(i + (cmd === CMD.SLOT_NEXT ? 1 : -1) + order.length) % order.length]);
  }
}

// --- Statuses ---------------------------------------------------------------------------

export function applyPlayerStatus(gs, p, id, dps = 0) {
  const s = p.statuses;
  const until = gs.time + ({ burn: 2, poison: 3, chill: 1.5, bleed: 3 }[id] ?? 2);
  s[id] = { until, dps: Math.max(s[id]?.until > gs.time ? s[id].dps : 0, dps) };
  if (id === 'chill') recomputeStats(gs, p);
}

function tickStatuses(gs, p, dt) {
  const s = p.statuses;
  let dot = 0;
  let attacker = null;
  for (const id of ['burn', 'poison', 'bleed']) {
    if (s[id]?.until > gs.time) {
      dot += s[id].dps;
      attacker = s[id].from ?? attacker;
    }
  }
  if (s.chill && s.chill.until <= gs.time) {
    delete s.chill;
    recomputeStats(gs, p);
  }
  if (!dot || p.dead) return;
  p.dotAcc = (p.dotAcc ?? 0) + dot * dt;
  if (p.dotAcc >= 1) {
    const n = Math.floor(p.dotAcc);
    p.dotAcc -= n;
    combat.hurtPlayer(gs, p, n, { dot: true, attacker: attacker ? gs.players.get(attacker) : null });
  }
}

// --- Interaction ------------------------------------------------------------------------

/** Uses whatever is next to the player. Returns true if something was used. */
export function interact(gs, p, now) {
  if (p.dead) return false;
  // Out on the water, Use takes you ashore (when there is land next to you).
  // With no land in reach, nothing happens: the attack button (which also
  // means Use) still attacks the sea creatures around the boat.
  if (p.sailing) {
    const spot = findLanding(sailingView(gs, p));
    if (!spot) return false;
    setSailing(gs, p, false, spot);
    return true;
  }
  let best = null;
  let bestD = INTERACT_RADIUS * INTERACT_RADIUS;
  for (const o of gs.world.objectsNear(p.x, p.y, 1)) {
    const d = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
    if (d >= bestD) continue;
    if (o.type === 'chest' || o.type === 'shrine') {
      if (gs.objectUsed(o.key)) continue;
    } else if (discoveries.isPoi(o.type)) {
      if (o.type !== 'signpost' && discoveries.isFound(p, o)) continue;
    } else if (o.type !== 'altar' && o.type !== 'building') {
      continue;
    }
    bestD = d;
    best = o;
  }
  // A merchant at a market: trade (unless they are angry with you).
  const merchant = markets.merchantNear(gs, p, 2.4);
  if (merchant) {
    if (markets.isHostile(p, merchant.entry.def.id, now)) {
      gs.toast(p, `${merchant.entry.def.name} vill inte handla med dig just nu.`, 'warn');
    } else {
      gs.send(p, { t: 'ui', panel: { name: 'market', marketId: merchant.entry.def.id } });
    }
    return true;
  }
  const banner = building.ownBannerNear(gs, p, 2.2);
  if (banner && (!best || (banner.x + 0.5 - p.x) ** 2 + (banner.y + 0.5 - p.y) ** 2 < bestD)) {
    gs.send(p, { t: 'ui', panel: 'clan' });
    return true;
  }
  // Your clan's buildings (forge, vault, well …).
  const bst = base.buildingNear(gs, p);
  if (bst && (!best || (bst.x + 0.5 - p.x) ** 2 + (bst.y + 0.5 - p.y) ** 2 < bestD)) return base.use(gs, p, bst);
  // Horses: climb on one next to you; on horseback, Use (with nothing else near) gets you off.
  if (horses.ridingOf(p)) {
    if (!best) return horses.dismount(gs, p, now);
  } else {
    const horse = horses.near(gs, p);
    if (horse && (!best || horse.d < bestD)) return horses.mount(gs, p, horse.h, now);
  }
  if (!best) return tryLaunch(gs, p);
  if (discoveries.isPoi(best.type)) return discoveries.interact(gs, p, best, now);
  switch (best.type) {
    case 'chest':
      loot.openChest(gs, p, best, now);
      return true;
    case 'shrine':
      gs.setMark(best.key, 'shrine', now + 10 * 60 * 1000);
      p.hp = p.maxHp;
      p.buffs.push({ stat: 'attackPower', value: 15, until: gs.time + 90 });
      recomputeStats(gs, p);
      gs.toast(p, 'Helgedomens välsignelse: full hälsa och +15 % skada i 90 sekunder.', 'component');
      gs.event(best.x, best.y, { k: 'fx', fx: 'holy', x: best.x, y: best.y });
      gs.broadcastTile(Math.floor(best.x), Math.floor(best.y), { t: 'wd', k: 'used', key: best.key, used: true });
      return true;
    case 'altar':
      combat.summonBoss(gs, p, best, now);
      return true;
    case 'building': {
      const panel = { forge: 'crafting', vault: 'storage', hearth: 'town', library: 'library', training: 'town' }[best.buildingId] ?? 'town';
      if (best.buildingId === 'hearth') p.hp = p.maxHp;
      gs.send(p, { t: 'ui', panel, building: best.buildingId });
      return true;
    }
    default:
      return false;
  }
}

// --- Sailing ---------------------------------------------------------------------------------

/** The boat this character owns (its best), or null. */
export function boatOf(gs, p) {
  return currentBoat(gs.data, { tools: { boat: p.ch.extra.boat ?? 0 } });
}

/**
 * How you move right now: walking, or sailing your boat (its own speed, a
 * small sprint boost, and water to float on). The client predicts with the
 * same numbers (they come with every snapshot).
 */
export function moveParams(gs, p) {
  const horse = horses.moveParams(gs, p);
  if (horse) return horse;
  const boat = p.sailing ? boatOf(gs, p) : null;
  if (!boat) return { speed: p.speed, sprint: gs.data.player.sprintMultiplier, mode: 'player' };
  const chilled = p.statuses.chill?.until > gs.time;
  return { speed: boat.speed * (chilled ? 0.65 : 1), sprint: 1.2, mode: boatMode(boat) };
}

/** What the single-player sailing rules need to look at. */
function sailingView(gs, p) {
  return { world: gs.world, player: p, data: gs.data, save: base.saveFor(gs, p) };
}

function tryLaunch(gs, p) {
  const spot = findLaunch(sailingView(gs, p));
  if (!spot) return false;
  if (spot.type === 'shore') {
    gs.toast(p, spot.reason === 'Build a boat at the Forge (Tools) to sail'
      ? 'Bygg en båt i smedjan (Verktyg) för att segla.'
      : `${boatOf(gs, p)?.name ?? 'Båten'} klarar inte det öppna havet.`, 'warn');
    return true;
  }
  setSailing(gs, p, true, spot);
  return true;
}

export function setSailing(gs, p, on, spot) {
  gs.event(p.x, p.y, { k: 'fx', fx: 'splash', x: p.x, y: p.y }, 24);
  p.x = spot.x;
  p.y = spot.y;
  p.kx = p.ky = 0;
  p.sailing = on;
  p.infoRev++;
  if (on && !p.ch.extra.sailed) {
    p.ch.extra.sailed = true;
    gs.toast(p, `Ombord på ${boatOf(gs, p)?.name ?? 'båten'}! Styr som när du går, och tryck Använd vid land för att gå i land.`, 'component');
  }
  markMe(p);
}

// --- Pickaxe ---------------------------------------------------------------------------------

function toolSwing(gs, p, aim, now) {
  if (p.toolCd > 0) return;
  const tool = currentPickaxe(gs.data, { tools: { pickaxe: p.ch.pickaxe } });
  if (!tool) return;
  const target = findHarvestTarget({ player: p, world: gs.world, data: gs.data });
  p.anim = (p.anim + 1) & 255;
  if (!target) {
    // Nothing to chop: a light swing at whoever is in front.
    p.toolCd = 0.45;
    gs.schedule(0.13, () => {
      if (p.dead) return;
      const dmg = 4 + 6 * tool.tier + p.ch.level * 1.5;
      combat.meleeArc(gs, p, { x: p.x, y: p.y, angle: aim, range: 1.4, half: 1.2, damage: dmg, crit: false, tool: true });
    });
    return;
  }
  p.toolCd = tool.swing ?? 0.36;
  if (target.info.tier > tool.tier) {
    p.toolCd = 0.6;
    if (!p.warnedTier) gs.toast(p, `Du behöver en starkare hacka för ${target.info.name.toLowerCase()}.`, 'warn');
    p.warnedTier = true;
    return;
  }
  gs.schedule(0.13, () => {
    if (p.dead || !gs.world.blockAt(target.tx, target.ty)) return;
    const key = `${target.tx},${target.ty}`;
    const prev = p.harvest.get(key);
    const dmg = (prev && now - prev.at < 20000 ? prev.dmg : 0) + tool.power;
    p.harvest.set(key, { dmg, at: now });
    if (p.harvest.size > 32) p.harvest.delete(p.harvest.keys().next().value);
    gs.event(target.x, target.y, { k: 'chop', x: target.x, y: target.y, wood: Boolean(target.info.drops.wood), frac: Math.min(1, dmg / target.info.hp) }, 24);
    if (dmg >= target.info.hp) {
      p.harvest.delete(key);
      loot.fellBlock(gs, p, target, tool);
    }
  });
}

// --- Death / respawn -----------------------------------------------------------------------

/** Where you come back to life (and where the Waystone takes you): your clan's banner or Fristaden. */
function homeSpot(gs, p) {
  if ((p.ch.extra.spawnAt ?? 'banner') === 'banner' && p.clanId) {
    const banner = building.bannerOf(gs, p.clanId);
    if (banner) return { x: banner.x + 0.5, y: banner.y + 1.6 };
  }
  return { x: TOWN_SPAWN.x + (Math.random() - 0.5) * 3, y: TOWN_SPAWN.y + Math.random() * 2 };
}

/** Moves a player somewhere else at once (on land unless the boat floats there). */
function teleport(gs, p, x, y, { sailing = false } = {}) {
  gs.event(p.x, p.y, { k: 'fx', fx: 'blink', x: p.x, y: p.y }, 24);
  const boat = sailing ? boatOf(gs, p) : null;
  if (boat && gs.world.isFree(x, y, p.r, boatMode(boat))) {
    p.sailing = true;
  } else {
    p.sailing = false;
    gs.world.gateFilter = (st) => Boolean(st.clanId) && st.clanId === p.clanId;
    ({ x, y } = gs.world.findFreeSpot(x, y, p.r, 'player', TOWN_SPAWN));
    gs.world.gateFilter = null;
  }
  p.x = x;
  p.y = y;
  p.kx = p.ky = 0;
  p.queue.length = 0;
  gs.send(p, { t: 'teleport', x: p.x, y: p.y });
  gs.event(p.x, p.y, { k: 'fx', fx: 'blink', x: p.x, y: p.y }, 24);
  markMe(p);
}

/**
 * Your clan's Waystone, from anywhere: home to it, then (level 2) back
 * again to where you left. Not in the middle of a fight with another player.
 */
export function recall(gs, p, op, now = Date.now()) {
  if (p.dead) return 'Du är död';
  if (p.combatUntil > now) return 'Du kan inte resa mitt i en strid mot andra spelare';
  const ex = p.ch.extra;
  const stone = p.clanId ? base.placed(gs, p.clanId).get('waystone') : null;
  if (!stone) return 'Bygg en vägsten i er bas för att kunna resa hem';
  const level = base.levelsFor(gs, p).waystone ?? 1;
  const home = { x: stone.x + 0.5, y: stone.y + 1.6 };
  if (op === 'back') {
    const back = ex.recallFrom;
    if (!back) return 'Ingen väg tillbaka just nu';
    if (level < 2) return 'Vägstenen behöver nivå 2 för resan tillbaka';
    if (Math.hypot(home.x - p.x, home.y - p.y) > 20) return 'Gå tillbaka till vägstenen först';
    ex.recallFrom = null;
    teleport(gs, p, back.x, back.y, { sailing: back.sailing });
    gs.toast(p, 'Genom vägstenen, tillbaka dit du var.');
    return null;
  }
  const left = (ex.recallAt ?? 0) - now;
  if (left > 0) return `Vägstenen laddas om: ${Math.ceil(left / 1000)} s kvar`;
  if (Math.hypot(home.x - p.x, home.y - p.y) < 20) return 'Du är redan hemma';
  ex.recallFrom = level >= 2 ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, sailing: Boolean(p.sailing) } : null;
  ex.recallAt = now + (gs.data.base.recallCooldown ?? 60) * 1000;
  teleport(gs, p, home.x, home.y);
  gs.toast(p, level >= 2 ? 'Vägstenen för dig hem. Res tillbaka från menyn när du vill.' : 'Vägstenen för dig hem.', 'component');
  persist(gs, p);
  return null;
}

export function respawn(gs, p, now) {
  const spot = homeSpot(gs, p);
  gs.world.gateFilter = (st) => Boolean(st.clanId) && st.clanId === p.clanId;
  const free = gs.world.findFreeSpot(spot.x, spot.y, p.r, 'player', TOWN_SPAWN);
  gs.world.gateFilter = null;
  p.x = free.x;
  p.y = free.y;
  p.kx = p.ky = 0;
  p.dead = false;
  p.sailing = false;
  p.statuses = {};
  recomputeStats(gs, p);
  p.hp = p.maxHp;
  p.protectUntil = now + gs.rules.spawnProtectSeconds * 1000;
  p.queue.length = 0;
  gs.send(p, { t: 'respawn', x: p.x, y: p.y });
  markMe(p);
}

// --- Persistence -----------------------------------------------------------------------------

export function persist(gs, p) {
  const ch = p.ch;
  ch.x = Math.round(p.x * 100) / 100;
  ch.y = Math.round(p.y * 100) / 100;
  ch.hp = p.dead ? p.maxHp : Math.max(1, Math.round(p.hp));
  ch.loadout = { equipped: p.inv.equipped, secondary: p.inv.secondary, activeSlot: p.inv.activeSlot, favorites: p.inv.favorites };
  ch.extra.sailing = Boolean(p.sailing);
  gs.db.saveCharacter(ch);
  p.lastSave = Date.now();
}
