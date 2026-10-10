// The campaign in single player: your soldiers and squads out in the world
// (army.js), and the territories with their outposts (territory.js).
//
// Close to you everything is real: outposts stand with their palisade and
// flag, monsters guard the ones nobody holds, soldiers walk and fight, and
// a flag is taken by standing at it with no foes about. Far away the same
// numbers decide it as a whole: a squad that reaches an outpost fights its
// guards in one go, and a counterattack on an outpost meets its garrison.
//
// Saved: save.army ({ squads, nextSquad }) and save.territories ({ owned:
// { key: { since } }, capture: { key: 0..1 }, cleared: { key: until },
// incomeAt, raidT }). Soldiers are workers with a soldier's role in
// save.base.workers (workforce.js).

import {
  isSoldier, roleDef, trainProblem, startTraining, finishTraining, gearUpgrade, soldierStats, soldierPower, addXp,
  ensureArmy, createSquad, assignSoldier, pruneSquads, squadOf, makeOrder, postFor, stepSoldier, hurtSoldier,
  squadHealth, stanceParams, STANCES, ORDER_NAMES, roleTitle,
} from './army.js';
import {
  territoryConfig, territoryAt, territoryKey, parseKey, outpostFor, outpostLayout, defendersFor, outpostLevel,
  monsterPower, abstractBattle, stepCapture, incomeFor, frontier, defenseFactor, placeOutpost, removeOutpost,
} from './territory.js';
import { buildingDef, buildingLevel, canAfford, pay, shortfalls } from './base.js';
import { spawnEnemy } from './enemies.js';
import { dealDamage } from './combat.js';

const LIVE = 64; // soldiers within this of you fight for real
const ACTIVATE = 70; // outposts closer than this stand in the world
const DEACTIVATE = 92;
const CLEARED_FOR = 12 * 60 * 1000; // beaten guards stay away this long (ms)
const HOUR = 3600 * 1000;
export const OWN_COLOR = '#3fa86a';
export const NEUTRAL_COLOR = '#b8b8c8';

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

export function ensureTerritories(t) {
  const out = t ?? {};
  out.owned ??= {};
  out.capture ??= {};
  out.cleared ??= {};
  out.incomeAt ??= null;
  out.raidT ??= null;
  return out;
}

export class Campaign {
  constructor(game) {
    this.game = game;
    game.save.army = ensureArmy(game.save.army);
    game.save.territories = ensureTerritories(game.save.territories);
    this.active = new Map(); // key → { site, structures, defenders, contested, attacked }
    this.structures = [];
    this.checkT = 0;
    this.slowT = 0;
    this.alerts = new Map(); // key → game time until which it is shown as under attack
    this.capFull = false;
  }

  get data() {
    return this.game.data;
  }

  get army() {
    return this.game.save.army;
  }

  get terr() {
    return this.game.save.territories;
  }

  cfg() {
    return territoryConfig(this.data);
  }

  levels() {
    const { data, save } = this.game;
    return { training: buildingLevel(data, save, 'training'), forge: buildingLevel(data, save, 'forge') };
  }

  /** Where soldiers without a squad stand: by the Training Grounds. */
  home() {
    const def = buildingDef(this.data, 'training');
    return { x: def?.x ?? 6.5, y: (def?.y ?? 2.5) + 1.8 };
  }

  site(key) {
    const { tx, ty } = parseKey(key);
    return outpostFor(this.game.world, this.data, tx, ty);
  }

  isOwned(key) {
    return Boolean(this.terr.owned[key]);
  }

  ownedKeys() {
    return Object.keys(this.terr.owned);
  }

  roster() {
    return this.game.save.base.workers;
  }

  rec(id) {
    return this.roster().find((r) => r.id === id) ?? null;
  }

  /** Runtime soldiers (workforce.js keeps them with the workers). */
  soldiers() {
    return this.game.workforce.list.filter((w) => isSoldier(this.data, w.role));
  }

  // --- Training and gear ----------------------------------------------------------------------------

  trainProblem(id, role) {
    const rec = this.rec(id);
    const problem = trainProblem(this.data, this.roster(), rec, role, this.levels());
    if (problem) return problem;
    const cost = roleDef(this.data, role).cost;
    if (!canAfford(this.game.save.resources, cost)) return shortfalls(this.game.save.resources, cost)[0];
    return null;
  }

  train(id, role) {
    const problem = this.trainProblem(id, role);
    if (problem) throw new Error(problem);
    const rec = this.rec(id);
    pay(this.game.save.resources, roleDef(this.data, role).cost);
    startTraining(this.data, rec, role, Date.now());
    this.game.workforce.sync();
    this.#changed();
    return rec;
  }

  gearInfo(id) {
    const rec = this.rec(id);
    if (!rec) return { next: null, problem: 'No such soldier' };
    const g = gearUpgrade(this.data, rec, this.levels());
    if (!g.problem && g.next && !canAfford(this.game.save.resources, g.next.cost)) return { ...g, problem: shortfalls(this.game.save.resources, g.next.cost)[0] };
    return g;
  }

  buyGear(id) {
    const { next, problem } = this.gearInfo(id);
    if (problem) throw new Error(problem);
    const rec = this.rec(id);
    pay(this.game.save.resources, next.cost);
    rec.gear = next.level;
    this.game.workforce.sync();
    this.#changed();
    return rec.gear;
  }

  /** A soldier goes back to work (if the lodge has room): `role` 'wood' or 'stone'. */
  muster(id, role = 'wood') {
    const rec = this.rec(id);
    if (!rec || !isSoldier(this.data, rec.role)) throw new Error('Not a soldier');
    const wf = this.game.workforce;
    if (wf.workerCount() >= wf.cap()) throw new Error('The lodge is full');
    rec.role = role;
    assignSoldier(this.data, this.army, id, 0);
    wf.sync();
    this.#changed();
  }

  // --- Squads ---------------------------------------------------------------------------------------

  createSquad(name) {
    const squad = createSquad(this.data, this.army, name);
    this.#changed();
    return squad;
  }

  disbandSquad(id) {
    this.army.squads = this.army.squads.filter((s) => s.id !== id);
    this.#changed();
  }

  assign(soldierId, squadId) {
    const problem = assignSoldier(this.data, this.army, soldierId, squadId);
    if (problem) throw new Error(problem);
    this.#changed();
  }

  setStance(squadId, stance) {
    const squad = this.army.squads.find((s) => s.id === squadId);
    if (!squad || !STANCES.includes(stance)) return false;
    squad.stance = stance;
    this.#changed();
    return true;
  }

  /** Gives a squad an order: { key } for a territory's outpost or { x, y } for a place. Returns the problem or null. */
  order(squadId, kind, target = {}) {
    const squad = this.army.squads.find((s) => s.id === squadId);
    if (!squad) return 'No such squad';
    if (!squad.members.length && kind !== 'retreat') return 'The squad has no soldiers yet';
    const from = this.squadCentre(squad) ?? this.game.player;
    const { order, problem } = makeOrder(kind, { ...target, site: (k) => this.site(k), from });
    if (problem) return problem;
    if (kind === 'defend' && order.key && !this.isOwned(order.key)) return 'You can only defend an outpost you hold: attack it first';
    squad.order = order;
    this.#changed();
    return null;
  }

  squadCentre(squad) {
    const members = this.soldiers().filter((s) => squad.members.includes(s.id));
    if (!members.length) return null;
    return { x: members.reduce((a, s) => a + s.x, 0) / members.length, y: members.reduce((a, s) => a + s.y, 0) / members.length };
  }

  postOf(s) {
    const squad = squadOf(this.army, s.id);
    const p = this.game.player;
    if (squad) return postFor(squad, squad.members.indexOf(s.id), { home: this.home(), leader: p.dead ? null : p, clock: this.game.time });
    const free = this.soldiers().filter((x) => !squadOf(this.army, x.id));
    return postFor(null, free.indexOf(s), { home: this.home() });
  }

  #changed() {
    this.game.emit('army');
    this.game.requestSave();
  }

  // --- Every frame ------------------------------------------------------------------------------------

  update(dt) {
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.5;
      this.#outposts();
    }
    this.#stepSoldiers(dt);
    this.#capture(dt);
    this.slowT -= dt;
    if (this.slowT <= 0) {
      this.slowT = 1;
      this.#training();
      pruneSquads(this.data, this.army, this.roster());
      this.#cautious();
      this.#abstract();
      this.#income();
    }
    this.#raids(dt);
  }

  #training() {
    let done = false;
    for (const rec of this.roster()) {
      if (!finishTraining(rec, Date.now())) continue;
      done = true;
      const w = this.game.workforce.list.find((x) => x.id === rec.id);
      this.game.toast(`${w?.name ?? 'A recruit'} finished training and is now ${roleTitle(roleDef(this.data, rec.role))}! Give them a squad on the strategy map (N).`, 'level');
    }
    if (done) {
      this.game.workforce.sync();
      this.#changed();
    }
  }

  #stepSoldiers(dt) {
    const list = this.soldiers();
    if (!list.length) return;
    const g = this.game;
    const p = g.player;
    const training = this.levels().training;
    const ctx = {
      world: g.world, time: g.time,
      stats: (s) => {
        const rec = this.rec(s.id);
        if (!rec) return null;
        const key = `${rec.role}|${rec.gear}|${rec.rank}|${training}`;
        if (s.statsKey !== key) {
          s.statsKey = key;
          s.stats = soldierStats(this.data, rec, training);
          const was = s.maxHp;
          s.maxHp = s.stats.hp;
          if (!was || s.hp > s.maxHp || !Number.isFinite(s.hp)) s.hp = s.maxHp;
          else s.hp = Math.min(s.maxHp, s.hp + Math.max(0, s.maxHp - was));
        }
        return s.stats;
      },
      post: (s) => this.postOf(s),
      stance: (s) => squadOf(this.army, s.id)?.stance ?? 'defensive',
      foes: (x, y, r) => g.enemies.filter((e) => !e.dead && !e.submerged && (e.x - x) ** 2 + (e.y - y) ** 2 <= r * r),
      hit: (s, foe, dmg) => this.#strike(s, foe, dmg),
      shoot: (s, foe, dmg) => {
        const angle = Math.atan2(foe.y - s.y, foe.x - s.x);
        const proj = g.spawnProjectile({
          x: s.x, y: s.y - 0.3, angle, speed: 13, damage: dmg, range: (s.stats?.reach ?? 6) + 2, size: 2, sprite: 'arrow',
          owner: 'turret', element: 'physical', color: '#e8d8b0', depth: 1,
        });
        if (proj) proj.soldier = s;
      },
      repairTarget: (s, post) => {
        let best = null;
        let bestD = 12 * 12;
        for (const st of g.construction.damaged) {
          if (st.dead || st.hp >= st.def.hp) continue;
          const dd = (st.x + 0.5 - post.x) ** 2 + (st.y + 0.5 - post.y) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = st;
          }
        }
        return best;
      },
      repair: (s, st, amount) => {
        st.hp = Math.min(st.def.hp, st.hp + amount);
        g.fx.emit('wood', st.x + 0.5, st.y + 0.4, 2, 0.3, 1);
        if (st.hp >= st.def.hp) g.construction.damaged.delete(st);
      },
      live: (s) => !p.dead && dist2(s, p) < LIVE * LIVE,
    };
    // Soldiers go through your gates like workers do.
    for (const s of list) stepSoldier(s, ctx, dt);
  }

  #strike(s, foe, dmg) {
    const g = this.game;
    dealDamage(g, foe, dmg, { source: 'ally', depth: 1, canCrit: false, fromX: s.x, fromY: s.y, knockback: 0.3, color: '#ffe0a0' });
    if (!foe.dead) foe.brawl = s;
    else this.soldierKill(s, foe);
  }

  /** A soldier's arrow hit (projectiles.js → game.turretHit). */
  arrowHit(proj, e) {
    const s = proj.soldier;
    dealDamage(this.game, e, proj.damage, { source: 'ally', depth: 1, canCrit: false, color: '#ffe0a0' });
    if (!e.dead && s && !s.dead) e.brawl = s;
    if (e.dead && s) this.soldierKill(s, e);
  }

  soldierKill(s, foe) {
    const rec = this.rec(s.id);
    if (!rec) return;
    if (addXp(this.data, rec, foe.boss ? 30 : foe.elite ? 8 : 3)) {
      this.game.fx.text(s.x, s.y - 1.1, 'RANK UP', '#ffd24a', 1.4);
      this.game.toast(`${s.name} rose to rank ${rec.rank}.`, 'level');
      this.game.requestSave();
    }
  }

  /** A monster's blow on a soldier (enemies.js). */
  hurt(s, damage, from = null) {
    if (!s || s.dead) return;
    const g = this.game;
    const dmg = Math.max(1, Math.round(damage));
    g.fx.number(s.x, s.y - 0.6, dmg, { color: '#ff8a8a' });
    if (from && !s.target) s.target = from;
    if (hurtSoldier(s, dmg)) {
      g.fx.emit('smoke', s.x, s.y, 10, 0.5, 1.5);
      g.toast(`${s.name} fell in battle.`, 'warn');
      this.game.workforce.bury(s);
      pruneSquads(this.data, this.army, this.roster());
      this.#changed();
    }
  }

  /** A squad on "retreat on losses" pulls back when it is badly hurt. */
  #cautious() {
    for (const squad of this.army.squads) {
      const p = stanceParams(squad.stance);
      if (!p.retreatAt || squad.order.kind === 'retreat') continue;
      const members = this.soldiers().filter((s) => squad.members.includes(s.id));
      if (members.length && squadHealth(members) < p.retreatAt) {
        squad.order = { kind: 'retreat' };
        this.game.toast(`${squad.name} is badly hurt and pulls back to camp.`, 'warn');
        this.#changed();
      }
    }
  }

  // --- Outposts close to you ---------------------------------------------------------------------------

  #outposts() {
    const g = this.game;
    const p = g.player;
    const { tx, ty } = territoryAt(this.data, p.x, p.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const site = outpostFor(g.world, this.data, tx + dx, ty + dy);
        if (site && !this.active.has(site.key) && dist2(site, p) < ACTIVATE * ACTIVATE) this.#activate(site);
      }
    }
    for (const [key, entry] of this.active) {
      if (dist2(entry.site, p) > DEACTIVATE * DEACTIVATE) this.#deactivate(key);
    }
  }

  flagColor(key) {
    return this.isOwned(key) ? OWN_COLOR : NEUTRAL_COLOR;
  }

  #activate(site) {
    const g = this.game;
    const structures = placeOutpost(g.world, this.data, site, this.flagColor(site.key));
    const entry = { site, structures, defenders: [], contested: false, attacked: false };
    this.active.set(site.key, entry);
    if (!this.isOwned(site.key) && !((this.terr.cleared[site.key] ?? 0) > Date.now())) this.#spawnDefenders(entry);
    this.#refresh();
  }

  #spawnDefenders(entry) {
    const g = this.game;
    const site = entry.site;
    const biome = this.data.byId.biomes.get(site.biome) ?? g.world.biomeAt(site.fx, site.fy);
    const level = Math.max(outpostLevel(site), 1);
    defendersFor(this.data, site).forEach((d, i) => {
      const a = (i / 7) * Math.PI * 2;
      const spot = g.world.findFreeSpot(site.x + Math.cos(a) * 2, site.y + Math.sin(a) * 2, 0.45, 'enemy', null);
      if (!spot) return;
      const e = spawnEnemy(g, d.kind, spot.x, spot.y, { level, elite: d.elite, biome });
      if (!e) return;
      e.outpost = site.key;
      e.homeX = site.x;
      e.homeY = site.y;
      entry.defenders.push(e);
    });
  }

  #deactivate(key) {
    const entry = this.active.get(key);
    if (!entry) return;
    removeOutpost(this.game.world, entry.structures);
    // Guards left standing go back to their posts (they are there when you come back).
    for (const e of entry.defenders) if (!e.dead) e.dead = e.vanished = true;
    this.active.delete(key);
    this.#refresh();
  }

  #refresh() {
    this.structures = [...this.active.values()].flatMap((e) => e.structures);
  }

  #setFlag(key) {
    const entry = this.active.get(key);
    if (!entry) return;
    for (const st of entry.structures) st.color = this.flagColor(key);
  }

  #capture(dt) {
    if (!this.active.size) return;
    const g = this.game;
    const p = g.player;
    const cfg = this.cfg();
    const R = cfg.captureRadius;
    const soldiers = this.soldiers();
    for (const [key, entry] of this.active) {
      const site = entry.site;
      // Beaten guards stay away for a while.
      if (entry.defenders.length && entry.defenders.every((e) => e.dead && !e.vanished)) {
        entry.defenders = [];
        this.terr.cleared[key] = Date.now() + CLEARED_FOR;
        if (!this.isOwned(key)) g.toast('The outpost\'s guards are beaten. Stand by the flag to take it.', 'component');
      }
      const friendly = (!p.dead && dist2(p, site) < R * R) || soldiers.some((s) => !s.dead && !s.ghost && dist2(s, site) < R * R);
      const hostile = g.enemies.some((e) => !e.dead && !e.submerged && dist2(e, site) < 7 * 7);
      const owned = this.isOwned(key);
      const before = this.terr.capture[key] ?? (owned ? 1 : 0);
      let prog = stepCapture(before, { friendly, hostile, dt, seconds: cfg.captureSeconds });
      entry.contested = friendly && hostile;
      entry.attacked = owned && hostile && !friendly;
      if (entry.attacked) this.alerts.set(key, g.time + 3);
      if (!owned && prog >= 1) {
        if (this.ownedKeys().length >= cfg.maxOwned) {
          prog = 0.99;
          if (!this.capFull) g.toast(`You can hold at most ${cfg.maxOwned} territories.`, 'warn');
          this.capFull = true;
        } else {
          this.take(key);
          prog = 1;
        }
      } else if (owned && prog <= 0) {
        this.lose(key, 'Monsters overran your outpost');
      }
      if (this.isOwned(key) || prog > 0) this.terr.capture[key] = prog;
      else delete this.terr.capture[key];
    }
  }

  /** The territory is yours. */
  take(key, text = null) {
    const g = this.game;
    this.terr.owned[key] = { since: Date.now() };
    this.terr.capture[key] = 1;
    this.capFull = false;
    this.#setFlag(key);
    const site = this.site(key);
    if (site) {
      g.fx.emit('holy', site.x, site.y - 1, 24, 0.8, 3);
      g.audio.play('levelup');
    }
    g.toast(text ?? `You took the outpost! It pays ${Object.entries(incomeFor(this.data, site?.tier ?? 1)).map(([k, n]) => `${n} ${k}`).join(', ')} an hour into the Vault.`, 'legendary');
    this.#changed();
  }

  lose(key, why) {
    const g = this.game;
    delete this.terr.owned[key];
    delete this.terr.capture[key];
    delete this.terr.cleared[key];
    this.#setFlag(key);
    g.toast(`${why}: the territory is lost. Take it back!`, 'warn');
    // Its guards return.
    const entry = this.active.get(key);
    if (entry && !entry.defenders.some((e) => !e.dead)) this.#spawnDefenders(entry);
    this.#changed();
  }

  // --- Far away: the same numbers, as a whole ------------------------------------------------------------

  /** Garrison of a territory: soldiers whose squad defends, holds or patrols it, close by. */
  garrison(key) {
    const site = this.site(key);
    if (!site) return [];
    const ids = new Set(this.army.squads
      .filter((sq) => ['defend', 'hold', 'patrol'].includes(sq.order.kind) && (sq.order.key === key || (sq.order.x - site.x) ** 2 + (sq.order.y - site.y) ** 2 < 100))
      .flatMap((sq) => sq.members));
    return this.soldiers().filter((s) => ids.has(s.id) && !s.dead && dist2(s, site) < 14 * 14);
  }

  #power(members) {
    const training = this.levels().training;
    let sum = 0;
    for (const s of members) {
      const rec = this.rec(s.id);
      if (rec) sum += soldierPower(this.data, rec, training, Math.max(0.05, s.hp / s.maxHp));
    }
    return sum;
  }

  #losses(members, share) {
    for (const s of members) {
      const hit = s.maxHp * share * (0.7 + Math.random() * 0.6);
      if (hit >= s.hp) this.hurt(s, s.hp + 1);
      else s.hp -= hit;
    }
  }

  #abstract() {
    const g = this.game;
    for (const squad of this.army.squads) {
      const o = squad.order;
      if (o.kind !== 'attack' || !o.key || this.isOwned(o.key) || this.active.has(o.key)) continue;
      const site = this.site(o.key);
      if (!site) continue;
      const members = this.soldiers().filter((s) => squad.members.includes(s.id));
      if (!members.length || !members.every((s) => s.ghost && dist2(s, site) < 6 * 6)) continue;
      const cleared = (this.terr.cleared[o.key] ?? 0) > Date.now();
      const defense = cleared ? 0 : monsterPower(this.data, defendersFor(this.data, site), outpostLevel(site));
      const res = abstractBattle(this.#power(members), defense);
      if (!cleared) this.#losses(members, res.attackerLoss * 0.6);
      const alive = members.filter((s) => !s.dead);
      for (const s of alive) this.soldierKill(s, { elite: true });
      if (res.win && alive.length) {
        this.terr.cleared[o.key] = Date.now() + CLEARED_FOR;
        this.take(o.key, `${squad.name} took an outpost ${this.#where(site)} while you were away.`);
        squad.order = { kind: 'defend', key: o.key, x: site.x, y: site.y };
      } else {
        squad.order = { kind: 'retreat' };
        g.toast(`${squad.name} was beaten back at the outpost ${this.#where(site)} and is coming home.`, 'warn');
        this.#changed();
      }
    }
  }

  #where(site) {
    const dx = site.x - this.game.player.x;
    const dy = site.y - this.game.player.y;
    const dir = Math.abs(dx) > Math.abs(dy) * 2 ? (dx > 0 ? 'east' : 'west') : Math.abs(dy) > Math.abs(dx) * 2 ? (dy > 0 ? 'south' : 'north') : `${dy > 0 ? 'south' : 'north'}-${dx > 0 ? 'east' : 'west'}`;
    return `${Math.round(Math.hypot(dx, dy))} tiles ${dir}`;
  }

  /** Every so often monsters try to take one of your outposts back. */
  #raids(dt) {
    const t = this.terr;
    const owned = this.ownedKeys();
    if (!owned.length) return;
    const cfg = this.cfg();
    t.raidT ??= cfg.raidEveryMinutes * 60;
    t.raidT -= dt;
    if (t.raidT > 0) return;
    t.raidT = cfg.raidEveryMinutes * 60 * (0.75 + Math.random() * 0.5);
    const key = owned[Math.floor(Math.random() * owned.length)];
    const site = this.site(key);
    if (!site) return;
    const g = this.game;
    const list = defendersFor(this.data, site);
    for (let i = 0; i < Math.floor(owned.length / 4); i++) list.push(list[i % list.length]);
    const level = outpostLevel(site);
    const entry = this.active.get(key);
    this.alerts.set(key, g.time + 60);
    if (entry) {
      // Close by: they come for real, from the wild towards the flag.
      const a = Math.random() * Math.PI * 2;
      const flag = entry.structures.find((st) => st.id === 'outpost_flag') ?? null;
      const biome = this.data.byId.biomes.get(site.biome);
      for (const [i, d] of list.entries()) {
        const spot = g.world.findFreeSpot(site.x + Math.cos(a) * 14 + (i % 3), site.y + Math.sin(a) * 14 + Math.floor(i / 3), 0.45, 'enemy', null);
        if (!spot) continue;
        const e = spawnEnemy(g, d.kind, spot.x, spot.y, { level, elite: d.elite, biome });
        if (!e) continue;
        e.raid = key;
        e.homeX = site.x;
        e.homeY = site.y;
        e.siege = flag;
      }
      g.toast(`Monsters are attacking your outpost ${this.#where(site)}! Hold the flag.`, 'boss');
      g.audio.play('boss');
      return;
    }
    // Far away: the garrison and the palisade against the attack.
    const garrison = this.garrison(key);
    const defense = (this.#power(garrison) + 15 * site.tier) * defenseFactor(this.data, owned.length, frontier(owned));
    const res = abstractBattle(monsterPower(this.data, list, level), defense);
    this.#losses(garrison, res.win ? res.defenderLoss * 0.6 : Math.min(0.5, res.defenderLoss));
    if (res.win) this.lose(key, `Monsters attacked your outpost ${this.#where(site)}`);
    else g.toast(`Monsters attacked your outpost ${this.#where(site)}, but ${garrison.length ? 'the garrison held' : 'the palisade held'}.`, 'info');
  }

  /** Every hour each territory pays into the Vault (also for the hours you were away, up to 12). */
  #income(now = Date.now()) {
    const t = this.terr;
    const owned = this.ownedKeys();
    if (!owned.length) {
      t.incomeAt = now;
      return;
    }
    t.incomeAt ??= now;
    let hours = Math.floor((now - t.incomeAt) / HOUR);
    if (hours <= 0) return;
    if (hours > 12) {
      t.incomeAt = now - 12 * HOUR;
      hours = 12;
    }
    t.incomeAt += hours * HOUR;
    const got = {};
    for (const key of owned) {
      const site = this.site(key);
      for (const [k, n] of Object.entries(incomeFor(this.data, site?.tier ?? 1))) got[k] = (got[k] ?? 0) + n * hours;
    }
    const { data, save } = this.game;
    const into = buildingLevel(data, save, 'vault') > 0 ? save.base.vault : save.resources;
    for (const [k, n] of Object.entries(got)) into[k] = (into[k] ?? 0) + n;
    this.game.toast(`Your territories paid ${Object.entries(got).map(([k, n]) => `${n} ${k}`).join(', ')}${into === save.base.vault ? ' into the Vault' : ''}.`, 'component');
    this.game.emit('base');
    this.game.requestSave();
  }

  // --- For the strategy map -----------------------------------------------------------------------------

  /** Territories around a square: [{ key, tx, ty, site, owner, status, capture, tier }]. */
  territoriesAround(tx0, ty0, radius) {
    const out = [];
    const now = this.game.time;
    for (let ty = ty0 - radius; ty <= ty0 + radius; ty++) {
      for (let tx = tx0 - radius; tx <= tx0 + radius; tx++) {
        const key = territoryKey(tx, ty);
        const home = tx === 0 && ty === 0;
        const site = home ? null : outpostFor(this.game.world, this.data, tx, ty);
        const owned = home || this.isOwned(key);
        const capture = this.terr.capture[key] ?? 0;
        const attacked = (this.alerts.get(key) ?? 0) > now;
        const status = home ? 'home' : !site ? 'empty' : attacked && owned ? 'attacked' : owned ? 'own' : capture > 0 ? 'contested' : 'neutral';
        out.push({ key, tx, ty, site, home, owner: owned ? 'me' : null, status, capture, tier: site?.tier ?? 0 });
      }
    }
    return out;
  }

  /** The squads for the map and the panel. */
  squadsView() {
    const soldiers = this.soldiers();
    return this.army.squads.map((sq) => {
      const members = soldiers.filter((s) => sq.members.includes(s.id));
      const c = this.squadCentre(sq);
      return {
        id: sq.id, name: sq.name, order: sq.order, stance: sq.stance, x: c?.x ?? null, y: c?.y ?? null,
        members: members.map((s) => ({ id: s.id, name: s.name, role: s.role, hp: s.hp, maxHp: s.maxHp, state: s.state })),
        doing: this.describeSquad(sq, members),
      };
    });
  }

  describeSquad(sq, members) {
    if (!members.length) return 'No soldiers: assign some in the list';
    const o = sq.order;
    const where = o.key ? 'the outpost' : 'the spot';
    const fighting = members.some((s) => s.state === 'fight');
    const marching = members.some((s) => s.state === 'march');
    const name = ORDER_NAMES[o.kind] ?? o.kind;
    if (fighting) return `${name}: fighting`;
    if (o.kind === 'retreat') return marching ? 'Coming home' : 'At camp';
    if (o.kind === 'follow') return 'Following you';
    if (marching) return `${name}: marching to ${where}`;
    if (o.kind === 'attack' && o.key && !this.isOwned(o.key)) return 'At the outpost: taking it';
    return `${name}: in place`;
  }
}
