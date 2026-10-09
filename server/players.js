// Players on the server: joining, inputs (with the anti-speedhack budget),
// movement, actions, death and respawn, persistence.

import { stepMove, PLAYER_RADIUS, TICK_DT, TICK_RATE } from '../src/net/movement.js';
import { BTN, CMD, byteToAngle } from '../src/net/protocol.js';
import { computePlayerStats, xpToNext } from '../src/game/stats.js';
import { compileWeapon } from '../src/game/combat.js';
import { currentPickaxe, findHarvestTarget } from '../src/game/gathering.js';
import { inSafeZone, isNewbie } from '../src/net/rules.js';
import { mpInventorySizes, MP_RESOURCE_KEYS, FRISTAD_LEVELS } from '../src/net/mpsave.js';
import * as combat from './combat.js';
import * as loot from './loot.js';
import * as building from './building.js';
import * as abilities from './abilities.js';

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
  // Safe placement (the world may have changed while they were away).
  gs.world.gateFilter = (st) => st.clanId && st.clanId === p.clanId;
  if (!gs.world.isFree(p.x, p.y, p.r)) Object.assign(p, gs.world.findFreeSpot(p.x, p.y, p.r, 'player', TOWN_SPAWN));
  gs.world.gateFilter = null;
  p.newbie = isNewbie(gs.rules, ch);
  return p;
}

// --- Stats / loadout ---------------------------------------------------------------

// Everyone shares Fristaden, so its buildings' bonuses apply to every player.
function statSave(p) {
  return { player: { level: p.ch.level, bonusLuck: 0 }, base: { buildings: FRISTAD_LEVELS } };
}

export function recomputeStats(gs, p) {
  const before = p.maxHp;
  const dna = p.weapon?.dna ?? null;
  p.stats = computePlayerStats(gs.data, statSave(p), dna, p.buffs);
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
    stats: p.stats,
    kills: p.ch.kills,
    deaths: p.ch.deaths,
    pvpKills: p.ch.pvpKills,
    admin: p.isAdmin,
  };
}

export function inventoryPayload(gs, p) {
  return { t: 'inv', ...p.inv, ...mpInventorySizes(gs.data) };
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
  // Out of a fight you slowly heal; in town quickly.
  if (!p.dead && p.hp < p.maxHp) {
    const town = inSafeZone(gs.rules, p.x, p.y);
    const calm = now - p.lastHurtAt > 6000;
    if (town || calm) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * (town ? 0.08 : 0.012) * dt);
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
  stepMove(gs.world, p, f, p.speed, gs.data.player.sprintMultiplier, p.r);
  gs.world.gateFilter = null;
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
  let best = null;
  let bestD = INTERACT_RADIUS * INTERACT_RADIUS;
  for (const o of gs.world.objectsNear(p.x, p.y, 1)) {
    const d = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
    if (d >= bestD) continue;
    if (o.type === 'chest' || o.type === 'shrine') {
      if (gs.objectUsed(o.key)) continue;
    } else if (o.type !== 'altar' && o.type !== 'building') {
      continue;
    }
    bestD = d;
    best = o;
  }
  const banner = building.ownBannerNear(gs, p, 2.2);
  if (banner && (!best || (banner.x + 0.5 - p.x) ** 2 + (banner.y + 0.5 - p.y) ** 2 < bestD)) {
    gs.send(p, { t: 'ui', panel: 'clan' });
    return true;
  }
  if (!best) return false;
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
      const panel = { forge: 'crafting', vault: 'storage', hearth: 'town', library: 'town', training: 'town' }[best.buildingId] ?? 'town';
      if (best.buildingId === 'hearth') p.hp = p.maxHp;
      gs.send(p, { t: 'ui', panel, building: best.buildingId });
      return true;
    }
    default:
      return false;
  }
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

export function respawn(gs, p, now) {
  let spot = null;
  if ((p.ch.extra.spawnAt ?? 'banner') === 'banner' && p.clanId) {
    const banner = building.bannerOf(gs, p.clanId);
    if (banner) spot = { x: banner.x + 0.5, y: banner.y + 1.6 };
  }
  spot ??= { x: TOWN_SPAWN.x + (Math.random() - 0.5) * 3, y: TOWN_SPAWN.y + Math.random() * 2 };
  gs.world.gateFilter = (st) => Boolean(st.clanId) && st.clanId === p.clanId;
  const free = gs.world.findFreeSpot(spot.x, spot.y, p.r, 'player', TOWN_SPAWN);
  gs.world.gateFilter = null;
  p.x = free.x;
  p.y = free.y;
  p.kx = p.ky = 0;
  p.dead = false;
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
  gs.db.saveCharacter(ch);
  p.lastSave = Date.now();
}
