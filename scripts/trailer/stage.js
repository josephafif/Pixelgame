// The trailer's stagehands (runs in the page, next to the game): put the
// hero somewhere, steer them, set the hour, hand them a weapon, spawn the
// cast, and keep the HUD out of the shot. Everything goes through the
// game's own systems, so what is filmed is the real game.

import { clockAt } from '../../src/game/daynight.js';
import { forgeWeapon } from '../../src/weapons/workshop.js';
import { spawnEnemy, spawnBoss } from '../../src/game/enemies.js';
import { syncPalEntity } from '../../src/game/pals.js';
import { installHd } from '../../src/render/hd.js';
import { horseStats } from '../../src/game/horses.js';
import { compileWeapon } from '../../src/game/combat.js';

export const G = () => window.__pixelgame.game;

// --- The hero's controls -------------------------------------------------------------

const ctl = { moveX: 0, moveY: 0, sprint: false, attack: false, commands: [] };

/** Takes over the input: the hero does what `drive` says. */
export function takeControls() {
  const g = G();
  g.input.sample = () => {
    const commands = ctl.commands;
    ctl.commands = [];
    return { moveX: ctl.moveX, moveY: ctl.moveY, attack: ctl.attack, sprint: ctl.sprint, commands, mode: 'keyboard' };
  };
}

/** Steer: a direction (normalised here), sprint, hold attack. */
export function drive({ x = 0, y = 0, sprint = false, attack = false } = {}) {
  const len = Math.hypot(x, y);
  ctl.moveX = len > 1 ? x / len : x;
  ctl.moveY = len > 1 ? y / len : y;
  ctl.sprint = sprint;
  ctl.attack = attack;
}

/** A one-off command: 'ability', 'dash', 'interact', 'slot1' … */
export function press(command) {
  ctl.commands.push(command);
}

/** Steer towards a point; returns the distance left. */
export function walkTo(x, y, { sprint = true, attack = false, stop = 0.4 } = {}) {
  const p = G().player;
  const dx = x - p.x;
  const dy = y - p.y;
  const d = Math.hypot(dx, dy);
  if (d < stop) drive({ attack });
  else drive({ x: dx / d, y: dy / d, sprint, attack });
  return d;
}

// --- The set ---------------------------------------------------------------------------

let spawnsOff = false;

/** Clears the stage: no monsters, shots, loot or effects left from the last shot. */
export function clearStage({ keepPal = true } = {}) {
  const g = G();
  g.enemies.length = 0;
  g.projectiles.length = 0;
  g.areas.length = 0;
  g.pickups.length = 0;
  g.allies.length = 0;
  g.boss = null;
  g.emit('boss', { active: false, victory: false });
  g.fx.particles.length = 0;
  g.fx.shapes.length = 0;
  g.fx.texts.length = 0;
  g.timers.length = 0;
  g.shake = 0;
  g.hitstop = 0;
  g.screenFlash = null;
  g.abilityReadyAt.clear();
  g.discoveryQueue.length = 0;
  const p = g.player;
  p.dead = false;
  p.hp = g.pstats.maxHp;
  p.statuses = {};
  p.hurtFlash = 0;
  p.kx = 0;
  p.ky = 0;
  p.leap = null;
  if (!keepPal) g.pal = null;
  drive();
}

/** Puts the hero at (x, y) (the nearest free spot) and the camera on them. */
export function teleport(x, y, { exact = false, sail = false } = {}) {
  const g = G();
  const p = g.player;
  g.save.player.sailing = sail;
  const spot = exact ? { x, y } : g.world.findFreeSpot(x, y, p.r, sail ? g.moveMode : 'player');
  p.x = spot.x;
  p.y = spot.y;
  p.invuln = 0;
  g.renderer.pan.x = 0;
  g.renderer.pan.y = 0;
  g.renderer.snapCamera();
  if (g.pal) {
    g.pal.x = p.x - 1;
    g.pal.y = p.y + 0.5;
  }
  return spot;
}

/** The hour of the day (0–24). */
export function setHour(h) {
  G().save.world.clock = clockAt(h);
}

/** No wild monsters wander in (the shot's cast is placed by hand). */
export function spawns(on) {
  spawnsOff = !on;
}

/** Called every frame before the game steps. */
export function holdStage() {
  const g = G();
  if (spawnsOff) g.spawnTimer = 1e9;
  else if (g.spawnTimer > 1e8) g.spawnTimer = 0.2;
}

// Cinematic shots: no HUD, no notices, no compass arrow (UI panels the
// director opens on purpose, in #overlay-root, still show).
const style = document.createElement('style');
style.textContent = `
  body.trailer-cine #hud, body.trailer-cine #toasts, body.trailer-cine #update-banner { display: none !important; }
  #trailer-ov { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 100000; pointer-events: none; }
`;
document.head.append(style);
let cine = false;
{
  const g = G();
  let compass = null;
  Object.defineProperty(g, 'lastCompass', {
    get: () => (cine ? null : compass),
    set: (v) => {
      compass = v;
    },
    configurable: true,
  });
}

/** Hides (or shows) the HUD, the game's own notices and the compass arrow. */
export function cinematic(on) {
  cine = on;
  document.body.classList.toggle('trailer-cine', on);
}

/** The camera's offset from the hero, in tiles. */
export function pan(x, y) {
  const r = G().renderer;
  r.pan.x = x;
  r.pan.y = y;
}

/**
 * How close the camera is: screen pixels per art pixel (the game picks 4 at
 * 1080p; 3 shows more of the world, 6 is a close-up).
 */
export function zoom(scale = 4) {
  const r = G().renderer;
  r.resize();
  if (r.scale === scale) return;
  r.scale = scale;
  r.R = scale % 2 === 0 ? 2 : 3;
  r.W = Math.ceil(r.canvas.width / scale);
  r.H = Math.ceil(r.canvas.height / scale);
  r.view.width = r.W * r.R;
  r.view.height = r.H * r.R;
  r.v = r.view.getContext('2d');
  installHd(r.v, r.R);
  r.snapCamera();
}

// --- Weapons -----------------------------------------------------------------------------

/** A weapon from the Workshop's tools, not given to anyone. */
export function makeWeapon(opts = {}) {
  return forgeWeapon(G().data, { level: 40, ...opts });
}

// --- Horses, the camp, friends ---------------------------------------------------------

/** In the saddle of a horse of `breed`. */
export function ride(breed = 'courser') {
  const g = G();
  const h = g.save.horses;
  if (h.riding) return;
  const rec = { id: h.nextId++, ...horseStats(breed, 0x5eed + h.nextId), x: g.player.x, y: g.player.y, stabled: false };
  h.owned.push(rec);
  h.riding = rec.id;
  g.buffs = g.buffs.filter((b) => b.source !== 'horse');
  g.buffs.push({ stat: 'maxHp', value: rec.hp, until: Infinity, source: 'horse' });
  g.recomputeStats();
}

/** Out of the saddle (the horse is let go: nothing filmed is kept). */
export function unride() {
  const g = G();
  const h = g.save.horses;
  if (!h.riding) return;
  h.owned = h.owned.filter((x) => x.id !== h.riding);
  h.riding = null;
  g.buffs = g.buffs.filter((b) => b.source !== 'horse');
  g.recomputeStats();
}

/** Every camp building at `level` (each as high as it goes). */
export function camp(level = 7) {
  const g = G();
  const b = g.save.base.buildings;
  for (const def of g.data.base.buildings) b[def.id] = Math.min(level, def.levels.length);
  g.recomputeStats();
}

/** Structures up at once ({ id, x, y } tiles), with a puff of dust each. */
export function raise(list, { dust = true } = {}) {
  const g = G();
  const cur = g.save.base.structures;
  const taken = new Set(cur.map((st) => `${st.x},${st.y},${st.id.includes('floor') ? 'f' : 's'}`));
  for (const st of list) {
    const key = `${st.x},${st.y},${st.id.includes('floor') ? 'f' : 's'}`;
    if (taken.has(key)) continue;
    taken.add(key);
    cur.push({ id: st.id, x: st.x, y: st.y });
    if (dust) g.fx.emit('dust', st.x + 0.5, st.y + 0.6, 5, 0.6, 1.4);
  }
  g.construction.load();
}

export function razeAll() {
  const g = G();
  g.save.base.structures = [];
  g.construction.load();
}

/**
 * Other players at your side (drawn by the game's own multiplayer code):
 * [{ name, tag, cloak, weapon (DNA) }]. `others` keeps them moving.
 */
export function friends(list) {
  const g = G();
  const p = g.player;
  g.others = list.map((f, i) => ({
    remote: true, friendly: true, name: f.name, tag: f.tag ?? null, cloak: f.cloak, nameColor: '#9af0a0',
    weapon: compileWeapon(f.weapon, g.data), x: p.x + (f.dx ?? 0), y: p.y + (f.dy ?? 0), facing: 0, moving: false, walkT: i,
    hp: 100, maxHp: 100, attackAnim: null, slot: 'main', ox: f.dx ?? 0, oy: f.dy ?? 0, swingAt: 0.3 * i,
  }));
  return g.others;
}

/** Friends keep their place around `center`, face the nearest monster and swing at it. */
export function moveFriends(dt, center) {
  const g = G();
  for (const o of g.others ?? []) {
    const tx = center.x + o.ox;
    const ty = center.y + o.oy;
    const dx = tx - o.x;
    const dy = ty - o.y;
    const d = Math.hypot(dx, dy);
    o.moving = d > 0.25;
    if (o.moving) {
      const s = Math.min(d, 6 * dt);
      o.x += (dx / d) * s;
      o.y += (dy / d) * s;
      o.walkT += dt * 9;
    }
    let best = null;
    let bd = 64;
    for (const e of g.enemies) {
      if (e.dead) continue;
      const ed = (e.x - o.x) ** 2 + (e.y - o.y) ** 2;
      if (ed < bd) {
        bd = ed;
        best = e;
      }
    }
    if (best) o.facing = Math.atan2(best.y - o.y, best.x - o.x);
    else if (o.moving) o.facing = Math.atan2(dy, dx);
    o.swingAt -= dt;
    if (o.attackAnim) {
      o.attackAnim.t += dt;
      if (o.attackAnim.t >= o.attackAnim.dur) o.attackAnim = null;
    }
    if (best && o.swingAt <= 0) {
      o.swingAt = 0.55 + (o.walkT % 0.3);
      o.attackAnim = { t: 0, dur: 0.28, angle: o.facing, dir: o.attackAnim?.dir === 1 ? -1 : 1 };
      if (bd < 2.6 * 2.6 + best.r) g.damageEnemy(best, 18 + (o.walkT % 1) * 12, { crit: false });
      if (o.weapon.attack.pattern === 'projectile' || o.weapon.attack.pattern === 'beam') {
        g.fx.emit('arcane', o.x + Math.cos(o.facing) * 0.8, o.y - 0.4 + Math.sin(o.facing) * 0.8, 4, 0.3, 2);
      }
    }
  }
}

// --- The cast ------------------------------------------------------------------------------

/** A monster at (x, y) (relative to the hero when `rel`). */
export function monster(kind, x, y, { rel = true, level = 12, elite = false, element = null, alert = true } = {}) {
  const g = G();
  const p = g.player;
  const ax = rel ? p.x + x : x;
  const ay = rel ? p.y + y : y;
  const spot = g.world.isFree(ax, ay, 0.45, 'enemy') ? { x: ax, y: ay } : g.world.findFreeSpot(ax, ay, 0.45, 'enemy');
  const e = spawnEnemy(g, kind, spot.x, spot.y, { level, elite, element });
  if (e && alert) e.alert = true;
  return e;
}

/** A ring (or arc) of monsters around the hero. */
export function horde(kind, n, radius, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (opts.turn ?? 0);
    const r = radius * (0.85 + ((i * 37) % 10) / 33);
    out.push(monster(Array.isArray(kind) ? kind[i % kind.length] : kind, Math.cos(a) * r, Math.sin(a) * r * 0.75, opts));
  }
  return out.filter(Boolean);
}

/** A boss, awake and on the hunt, at (x, y) from the hero. */
export function boss(id, x, y) {
  const g = G();
  const p = g.player;
  const b = spawnBoss(g, id, p.x + x, p.y + y);
  // (Tougher for the camera: a legendary power must not end the fight in one blow.)
  b.maxHp *= 4;
  b.hp = b.maxHp;
  g.boss = b;
  b.alert = true;
  g.emit('boss', { active: true, name: b.def.name });
  return b;
}

/** A pal at your side (hatched and levelled for the shot). */
export function pal(species = 'glimmerfox', level = 8) {
  const g = G();
  const s = g.save.pals;
  let rec = s.owned.find((x) => x.species === species);
  if (!rec) {
    rec = { id: `pal${s.nextId++}`, species, level, name: species === 'emberpup' ? 'Ember' : species === 'mossling' ? 'Moss' : 'Glim' };
    s.owned.push(rec);
  }
  s.active = rec.id;
  s.mode = 'fight';
  syncPalEntity(g);
  return g.pal;
}
