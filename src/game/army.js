// Soldiers and squads. A worker trained at the Training Grounds becomes a
// guard, an infantryman, an archer, a rider or an engineer: it no longer
// chops trees, it fights. Soldiers get better gear (bought in the camp) and
// rank up with every fight. Squads are named groups with an order (move,
// defend, attack, patrol, follow, hold, retreat) and a stance.
//
// Pure rules and behaviour shared by single player (campaign.js) and the
// server (server/army.js), like the workers' (workers.js), whose way of
// walking soldiers share.

import { walk } from './workers.js';
import { unitPower } from './territory.js';

export const ORDERS = ['move', 'defend', 'attack', 'patrol', 'follow', 'hold', 'retreat'];
export const STANCES = ['defensive', 'balanced', 'aggressive', 'cautious'];
export const ORDER_NAMES = {
  move: 'Move', defend: 'Defend', attack: 'Attack', patrol: 'Patrol', follow: 'Follow me', hold: 'Hold', retreat: 'Retreat',
};
export const ORDER_NAMES_SV = {
  move: 'Flytta', defend: 'Försvara', attack: 'Anfall', patrol: 'Patrullera', follow: 'Följ mig', hold: 'Håll', retreat: 'Retirera',
};
export const STANCE_NAMES = { defensive: 'Defensive', balanced: 'Balanced', aggressive: 'Aggressive', cautious: 'Retreat on losses' };
export const STANCE_NAMES_SV = { defensive: 'Defensiv', balanced: 'Balanserad', aggressive: 'Aggressiv', cautious: 'Retirera vid förluster' };

// How far a soldier looks for a fight, and how far from its post it chases one.
const STANCE = {
  defensive: { engage: 5, chase: 7, retreatAt: 0 },
  balanced: { engage: 8, chase: 12, retreatAt: 0 },
  aggressive: { engage: 11, chase: 22, retreatAt: 0 },
  cautious: { engage: 8, chase: 11, retreatAt: 0.4 },
};

export const LEG = 28; // a long march goes in legs this long (the way is planned per leg)
const FORMATION = [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [1.2, 1.2], [-1.2, 1.2], [0, -1.2], [2.4, 0], [-2.4, 0], [0, 2.4]];
const PATROL = [[-7, -7], [7, -7], [7, 7], [-7, 7]];

export function stanceParams(stance) {
  return STANCE[stance] ?? STANCE.balanced;
}

export function armyConfig(data) {
  return data.army ?? { roles: [], gear: [{ level: 1, pct: 0 }], squads: { max: 4, size: 8 }, barracksPerTraining: 2, xpPerRank: 40, maxRank: 5, rankPct: 8 };
}

export function roleDef(data, id) {
  return armyConfig(data).roles.find((r) => r.id === id) ?? null;
}

/** "a guard", "an archer", "an infantryman". */
export function roleTitle(def) {
  if (!def) return 'a soldier';
  const n = def.id === 'infantry' ? 'infantryman' : def.name.toLowerCase();
  return `${/^[aeiou]/.test(n) ? 'an' : 'a'} ${n}`;
}

export function isSoldier(data, role) {
  return Boolean(roleDef(data, role));
}

export function soldierRoles(data) {
  return armyConfig(data).roles.map((r) => r.id);
}

/** Room for soldiers: the Training Grounds' barracks (2 per level). */
export function barracksCap(data, trainingLevel) {
  return Math.max(0, trainingLevel) * (armyConfig(data).barracksPerTraining ?? 2);
}

/** Soldiers (and those in training) in a roster. */
export function soldierCount(data, roster) {
  return roster.filter((r) => isSoldier(data, r.role) || r.trainingTo).length;
}

/** Workers (not soldiers, not in training) in a roster. */
export function workerCount(data, roster) {
  return roster.length - soldierCount(data, roster);
}

/**
 * Why `rec` can't start training as `role` (null = it can). levels:
 * { training } (the Training Grounds' level).
 */
export function trainProblem(data, roster, rec, role, levels) {
  const def = roleDef(data, role);
  if (!def) return 'Unknown role';
  if (!rec) return 'No such worker';
  if (rec.trainingTo) return 'Already training';
  if (rec.role === role) return `Already a ${def.name.toLowerCase()}`;
  if ((levels.training ?? 0) < 1) return 'Build the Training Grounds first';
  if ((levels.training ?? 0) < def.training) return `Needs the Training Grounds at level ${def.training}`;
  if (!isSoldier(data, rec.role) && soldierCount(data, roster) >= barracksCap(data, levels.training)) {
    return 'The barracks are full: upgrade the Training Grounds';
  }
  return null;
}

/** Starts training (pay first): it takes the role's time. */
export function startTraining(data, rec, role, now) {
  const def = roleDef(data, role);
  rec.trainingTo = role;
  rec.trainUntil = now + def.seconds * 1000;
  rec.gear ??= 1;
  rec.rank ??= 0;
  rec.xp ??= 0;
}

/** Finishes training when its time is up. Returns true when `rec` just became a soldier. */
export function finishTraining(rec, now) {
  if (!rec.trainingTo || rec.trainUntil > now) return false;
  rec.role = rec.trainingTo;
  delete rec.trainingTo;
  delete rec.trainUntil;
  return true;
}

export function gearDef(data, level) {
  const list = armyConfig(data).gear;
  return list.find((g) => g.level === level) ?? list[0];
}

/** The next gear level for `rec` and why it can't be bought ({ next, problem }). levels: { forge }. */
export function gearUpgrade(data, rec, levels) {
  const next = armyConfig(data).gear.find((g) => g.level === (rec.gear ?? 1) + 1) ?? null;
  if (!next) return { next: null, problem: 'Best gear already' };
  if (next.forge && (levels.forge ?? 0) < next.forge) return { next, problem: `Needs the Forge at level ${next.forge}` };
  return { next, problem: null };
}

/** A soldier's numbers: its role, better with gear, rank and the Training Grounds. */
export function soldierStats(data, rec, trainingLevel = 1) {
  const def = roleDef(data, rec.role);
  if (!def) return null;
  const cfg = armyConfig(data);
  const pct = (gearDef(data, rec.gear ?? 1).pct ?? 0) + (rec.rank ?? 0) * (cfg.rankPct ?? 8) + Math.max(0, trainingLevel - 1) * 6;
  const k = 1 + pct / 100;
  return {
    hp: Math.round(def.hp * k), damage: def.damage * k, every: def.every, reach: def.reach, ranged: Boolean(def.ranged),
    speed: def.speed, sight: def.sight, repair: (def.repair ?? 0) * k,
  };
}

/** What a soldier weighs in a battle (the same scale as monsterPower). */
export function soldierPower(data, rec, trainingLevel = 1, hpFrac = 1) {
  const s = soldierStats(data, rec, trainingLevel);
  if (!s) return 0;
  return unitPower(s.hp * hpFrac, (s.damage / s.every) * (s.ranged ? 1.15 : 1));
}

/** Experience from a fight; returns true when the soldier rose in rank. */
export function addXp(data, rec, n) {
  const cfg = armyConfig(data);
  rec.xp = (rec.xp ?? 0) + n;
  rec.rank ??= 0;
  let up = false;
  while (rec.rank < (cfg.maxRank ?? 5) && rec.xp >= (cfg.xpPerRank ?? 40) * (rec.rank + 1)) {
    rec.rank++;
    up = true;
  }
  return up;
}

// --- Squads ----------------------------------------------------------------------------------------

/** army: { squads: [{ id, name, members, order, stance }], nextSquad }. */
export function ensureArmy(army) {
  const a = army ?? {};
  a.squads = Array.isArray(a.squads) ? a.squads : [];
  a.nextSquad ??= 1;
  return a;
}

export function newSquadProblem(data, army) {
  if (army.squads.length >= (armyConfig(data).squads?.max ?? 4)) return 'You have as many squads as you can lead';
  return null;
}

export function createSquad(data, army, name) {
  const problem = newSquadProblem(data, army);
  if (problem) throw new Error(problem);
  const id = army.nextSquad++;
  const squad = { id, name: String(name || `Squad ${id}`).slice(0, 24), members: [], order: { kind: 'retreat' }, stance: 'balanced' };
  army.squads.push(squad);
  return squad;
}

/** Puts a soldier in a squad (out of any other); squadId 0 takes it out. */
export function assignSoldier(data, army, soldierId, squadId) {
  for (const s of army.squads) s.members = s.members.filter((m) => m !== soldierId);
  if (!squadId) return null;
  const squad = army.squads.find((s) => s.id === squadId);
  if (!squad) return 'No such squad';
  if (squad.members.length >= (armyConfig(data).squads?.size ?? 8)) return 'That squad is full';
  squad.members.push(soldierId);
  return null;
}

/** Drops members that are no longer soldiers (dead, let go, back at work). */
export function pruneSquads(data, army, roster) {
  const ok = new Set(roster.filter((r) => isSoldier(data, r.role)).map((r) => r.id));
  for (const s of army.squads) s.members = s.members.filter((m) => ok.has(m));
}

export function squadOf(army, soldierId) {
  return army.squads.find((s) => s.members.includes(soldierId)) ?? null;
}

/**
 * Checks and normalises an order: { kind, x?, y?, key? }. Returns
 * { order } or { problem }. `site(key)` gives a territory's outpost.
 */
export function makeOrder(kind, { x, y, key, site, from } = {}) {
  if (!ORDERS.includes(kind)) return { problem: 'Unknown order' };
  if (kind === 'retreat' || kind === 'follow') return { order: { kind } };
  if (kind === 'hold') {
    if (!from) return { problem: 'Nowhere to hold' };
    return { order: { kind, x: from.x, y: from.y } };
  }
  if (key != null) {
    const s = site?.(key);
    if (!s) return { problem: 'No outpost there' };
    return { order: { kind, key: s.key, x: s.x, y: s.y } };
  }
  if (kind === 'attack' || kind === 'defend' || kind === 'patrol') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { problem: 'Pick a place on the map' };
    return { order: { kind, x, y } };
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { problem: 'Pick a place on the map' };
  return { order: { kind, x, y } };
}

/**
 * Where member number `index` of a squad should stand right now: around
 * the order's point in a loose formation (or home, or by the leader).
 */
export function postFor(squad, index, { home, leader, clock = 0 } = {}) {
  const o = squad?.order ?? { kind: 'retreat' };
  const [fx, fy] = FORMATION[index % FORMATION.length];
  if (o.kind === 'follow' && leader) return { x: leader.x + fx - 1.5, y: leader.y + fy + 1.5 };
  if (o.kind === 'retreat' || o.kind === 'follow' || !Number.isFinite(o.x)) return { x: home.x + fx, y: home.y + fy + 1 };
  if (o.kind === 'patrol') {
    const [px, py] = PATROL[Math.floor(clock / 14) % PATROL.length];
    return { x: o.x + px + fx * 0.6, y: o.y + py + fy * 0.6 };
  }
  // At an outpost they stand round the flag; anywhere else round the point.
  return { x: o.x + fx, y: o.y + fy + (o.key ? 1.5 : 0) };
}

// --- Behaviour (one soldier, one step) ---------------------------------------------------------------

/** A runtime soldier on top of a runtime worker (workers.js: createWorker). */
export function makeSoldier(w) {
  w.target = null;
  w.scanT = Math.random() * 0.4;
  w.atkT = 0;
  w.calmT = 0;
  w.ghost = false;
  return w;
}

function d2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/**
 * ctx: { world, time, stats(s) → soldierStats, post(s) → { x, y }, stance(s),
 * foes(x, y, r) → [{ x, y, r, dead }], hit(s, foe, dmg), shoot(s, foe, dmg),
 * repairTarget?(s, post) → structure, repair?(s, st, amount), live(s) → bool }.
 */
export function stepSoldier(s, ctx, dt) {
  s.hurtFlash = Math.max(0, (s.hurtFlash ?? 0) - dt);
  if (s.dead) return;
  const stats = ctx.stats(s);
  if (!stats) return;
  s.t += dt;
  s.clock += dt;
  s.atkT -= dt;
  const post = ctx.post(s);
  // Far from everyone the march is simple: straight there, no fights (those are decided as a whole).
  if (!ctx.live(s)) {
    s.ghost = true;
    s.target = null;
    const dx = post.x - s.x;
    const dy = post.y - s.y;
    const d = Math.hypot(dx, dy);
    const step = stats.speed * dt;
    if (d <= step || d < 0.5) {
      s.moving = false;
    } else {
      s.x += (dx / d) * step;
      s.y += (dy / d) * step;
      s.moving = true;
      s.facing = Math.atan2(dy, dx);
    }
    s.state = d < 1.5 ? 'post' : 'march';
    return;
  }
  if (s.ghost) {
    // Back where people are: onto solid ground.
    s.ghost = false;
    const spot = ctx.world.findFreeSpot?.(s.x, s.y, s.r, 'pal', { x: s.x, y: s.y }) ?? s;
    s.x = spot.x;
    s.y = spot.y;
    s.route = null;
    s.goalX = NaN;
  }
  const stance = stanceParams(ctx.stance(s));
  // Out of a fight for a while: wounds close.
  s.calmT += dt;
  if (s.calmT > 6 && s.hp < s.maxHp) s.hp = Math.min(s.maxHp, s.hp + dt * 2);
  // Keep to the fight, unless the foe fell or got too far from the post.
  if (s.target) {
    const t = s.target;
    if (t.dead || d2(s, t) > (stats.sight * 1.8) ** 2 || d2(post, t) > (stance.chase + stats.reach + 2) ** 2) s.target = null;
  }
  s.scanT -= dt;
  if (!s.target && s.scanT <= 0) {
    s.scanT = 0.4;
    const r = Math.min(stats.sight, stance.engage + (stats.ranged ? stats.reach * 0.5 : 0));
    let best = null;
    let bestD = r * r;
    for (const f of ctx.foes(s.x, s.y, r)) {
      if (f.dead || d2(post, f) > (stance.chase + stats.reach) ** 2) continue;
      const dd = d2(s, f);
      if (dd < bestD) {
        bestD = dd;
        best = f;
      }
    }
    s.target = best;
  }
  if (s.target) {
    const t = s.target;
    s.calmT = 0;
    s.state = 'fight';
    const d = Math.sqrt(d2(s, t));
    const reach = stats.ranged ? stats.reach : stats.reach + (t.r ?? 0.4) + s.r;
    if (d <= reach) {
      s.moving = false;
      s.facing = Math.atan2(t.y - s.y, t.x - s.x);
      if (s.atkT <= 0) {
        s.atkT = stats.every;
        s.anim = (s.anim + 1) & 255;
        if (stats.ranged) ctx.shoot(s, t, stats.damage);
        else ctx.hit(s, t, stats.damage);
      }
    } else {
      walk(ctx, s, t.x, t.y, stats.speed * 1.1, dt, reach * 0.9);
    }
    return;
  }
  // Engineers mend what is broken near their post.
  if (stats.repair > 0 && ctx.repairTarget) {
    const st = ctx.repairTarget(s, post);
    if (st) {
      s.state = 'repair';
      if (walk(ctx, s, st.x + 0.5, st.y + 1.3, stats.speed, dt, 0.9)) {
        s.moving = false;
        s.facing = Math.atan2(st.y + 0.5 - s.y, st.x + 0.5 - s.x);
        if (s.atkT <= 0) {
          s.atkT = 1;
          s.anim = (s.anim + 1) & 255;
          ctx.repair(s, st, stats.repair);
        }
      }
      return;
    }
  }
  // To the post: a long way goes in legs, each one planned.
  let gx = post.x;
  let gy = post.y;
  const far = Math.hypot(gx - s.x, gy - s.y);
  if (far > LEG + 4) {
    gx = s.x + ((gx - s.x) / far) * LEG;
    gy = s.y + ((gy - s.y) / far) * LEG;
    // A whole leg ahead: aim for a leg's end only once, so the way isn't planned every step.
    if (!(Math.hypot((s.legX ?? Infinity) - s.x, (s.legY ?? Infinity) - s.y) > 3)) {
      const spot = ctx.world.findFreeSpot?.(gx, gy, s.r, 'pal', { x: gx, y: gy }) ?? { x: gx, y: gy };
      s.legX = spot.x;
      s.legY = spot.y;
    }
    gx = s.legX;
    gy = s.legY;
  } else {
    s.legX = undefined;
    s.legY = undefined;
  }
  if (walk(ctx, s, gx, gy, stats.speed, dt, far > LEG + 4 ? 1.5 : 0.45)) {
    s.moving = false;
    s.state = far > LEG + 4 ? 'march' : 'post';
    if (far > LEG + 4) {
      s.legX = undefined;
      s.legY = undefined;
    }
  } else {
    s.state = 'march';
    // Hopelessly stuck on a long march: they find their own way (as workers do).
    if ((s.noRoute && far > 14) || s.stuckT > 8) {
      const spot = ctx.world.findFreeSpot?.(gx, gy, s.r, 'pal', null);
      if (spot) {
        s.x = spot.x;
        s.y = spot.y;
      }
      s.route = null;
      s.noRoute = false;
      s.goalX = NaN;
      s.stuckT = 0;
    }
  }
}

/** A blow against a soldier; returns true when it fell. */
export function hurtSoldier(s, damage) {
  if (s.dead) return false;
  s.hp -= damage;
  s.hurtFlash = 0.15;
  s.calmT = 0;
  if (s.hp <= 0) {
    s.dead = true;
    s.moving = false;
    return true;
  }
  return false;
}

/** Health left in a squad (0..1), for the stance that pulls back. */
export function squadHealth(members) {
  let hp = 0;
  let max = 0;
  for (const m of members) {
    hp += Math.max(0, m.hp);
    max += m.maxHp;
  }
  return max ? hp / max : 1;
}
