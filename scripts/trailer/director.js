// The trailer's director (runs in the page): films the running order in
// timeline.js one frame at a time. Every shot is the real game, set up with
// the stagehands in stage.js: the hero is placed, armed and steered, the
// cast is spawned, and the game's own simulation and renderer do the rest.
// The titles are drawn on top (overlay.js).
//
// record.mjs calls step() once per video frame, on the page's frozen clock.

import { schedule, TITLES, BAR, FPS, DURATION } from './timeline.js';
import { Overlay, ramp, envelope, ease } from './overlay.js';
import * as st from './stage.js';
import { applyNode } from '../../src/weapons/evolution.js';
import { weaponSprite, weaponIcon } from '../../src/render/weapon-sprite.js';
import { castAbility } from '../../src/game/abilities.js';
import { SEA } from '../../src/game/world.js';
import { closeModal } from '../../src/ui/modal.js';

const G = st.G;
const DT = 1 / 60;
const TAU = Math.PI * 2;

// --- Weapons for the shots -----------------------------------------------------------

/** A weapon grown all the way: base → tempered → form → masterwork → infusion → awakening. */
function awakened(family, form, element, power, seed) {
  const g = G();
  let dna = st.makeWeapon({ archetype: family, rarity: 'rare', seed, level: 40 });
  for (const node of ['tempered', `form:${form}`, `mastery:${form}`, `infuse:${element}`, `awaken:${power}`]) {
    dna = applyNode(g.data, dna, node, { playerLevel: 48 });
  }
  return dna;
}

/** The steps of the sword the hero finds in the chest, grown in the Evolve shot. */
function evolutionSteps(base) {
  const g = G();
  const out = [{ dna: base, step: 'Found: a rare sword' }];
  let dna = base;
  const names = { tempered: 'Tempered', 'form:titan': 'Form: Titan', 'mastery:titan': 'Masterwork: Earthbreaker', 'infuse:fire': 'Infusion: Embers', 'awaken:dragon_breath': "Awakened: Dragon's Breath" };
  for (const node of Object.keys(names)) {
    dna = applyNode(g.data, dna, node, { playerLevel: 48 });
    out.push({ dna, node, step: names[node] });
  }
  return out;
}

const arsenal = {};

function equip(dna) {
  const g = G();
  const bag = g.save.inventory.bag;
  const at = bag.findIndex((w) => w.id === dna.id);
  if (at >= 0) bag[at] = dna;
  else if (bag.length < g.save.inventory.bagSize) bag.push(dna);
  else bag.splice(1, 1, dna); // (the bag is full: make room)
  g.equip(dna.id, 'main');
  g.abilityReadyAt.clear();
}

// --- Little helpers for the shots ---------------------------------------------------------

/** Runs one way (with the camera leading a little). */
function run(dx, dy, { sprint = true, lead = 2.5, attack = false } = {}) {
  st.drive({ x: dx, y: dy, sprint, attack });
  const len = Math.hypot(dx, dy) || 1;
  st.pan((dx / len) * lead, (dy / len) * lead * 0.6);
}

/** A clear spot of `kind` ground near (x, y): no trees within `r` tiles. */
function clearing(x, y, r = 3, mode = 'player') {
  const w = G().world;
  for (let ring = 0; ring < 40; ring++) {
    const n = Math.max(1, ring * 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const cx = Math.round(x + Math.cos(a) * ring * 1.5) + 0.5;
      const cy = Math.round(y + Math.sin(a) * ring * 1.5) + 0.5;
      let ok = true;
      for (let dy = -r; dy <= r && ok; dy++) {
        for (let dx = -r; dx <= r && ok; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          if (!w.isFree(cx + dx, cy + dy, 0.3, mode)) ok = false;
        }
      }
      if (ok) return { x: cx, y: cy };
    }
  }
  return { x, y };
}

/** The ground of the far lands and the sea are found by looking. */
function findWhere(x0, y0, pred, max = 300, step = 3) {
  for (let r = 0; r < max; r += step) {
    const n = Math.max(1, Math.round((TAU * r) / step));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const x = Math.round(x0 + Math.cos(a) * r) + 0.5;
      const y = Math.round(y0 + Math.sin(a) * r) + 0.5;
      if (pred(x, y)) return { x, y };
    }
  }
  return { x: x0, y: y0 };
}

function biomeIs(id) {
  const w = G().world;
  return (x, y) => w.biomeAt(Math.floor(x), Math.floor(y)).id === id;
}

/** Casts the hero's power now (the cooldown is set aside for the shot). */
function cast(angle = null) {
  const g = G();
  g.abilityReadyAt.clear();
  const t = g.target && !g.target.dead ? g.target : nearestEnemy();
  const p = g.player;
  const a = angle ?? (t ? Math.atan2(t.y - p.y, t.x - p.x) : p.facing);
  castAbility(g, a);
}

function nearestEnemy() {
  const g = G();
  const p = g.player;
  let best = null;
  let bd = Infinity;
  for (const e of g.enemies) {
    if (e.dead) continue;
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

/** Keeps a horde coming: tops it up to `n` around the hero. */
function keepHorde(kinds, n, radius, opts = {}) {
  const g = G();
  const alive = g.enemies.filter((e) => !e.dead && !e.boss).length;
  for (let i = alive; i < n; i++) {
    const a = Math.random() * TAU;
    st.monster(kinds[i % kinds.length], Math.cos(a) * radius, Math.sin(a) * radius * 0.7, opts);
  }
}

/** Strafes around a point (a boss), attacking. */
function strafe(t, cx, cy, r, speed = 0.9) {
  const p = G().player;
  const a = t * speed + 1.2;
  const tx = cx + Math.cos(a) * r;
  const ty = cy + Math.sin(a) * r * 0.7;
  st.walkTo(tx, ty, { sprint: true, attack: true, stop: 0.2 });
  return { p, tx, ty };
}

/** The opening and end shots look down on a fixed spot while the hero walks on. */
function hold(x, y) {
  const p = G().player;
  st.pan(x - p.x, y - p.y);
}

// --- The shots ----------------------------------------------------------------------------------

const S = {};
const scenes = {
  aerial: {
    enter() {
      st.zoom(3);
      st.setHour(6.4);
      const spot = clearing(-68, 64, 1);
      st.teleport(spot.x, spot.y);
      S.start = { x: spot.x, y: spot.y };
      equip(arsenal.rareSword);
      st.spawns(false);
    },
    tick(t) {
      // The camera drifts in from over the woods and settles on the hero by the water.
      const k = ease.inOut(Math.min(1, t / 12));
      st.drive({ x: 0.55, y: 0.18 });
      const p = G().player;
      st.pan(24 * (1 - k) + 2, 12 * (1 - k) - 1);
      if (t > 11.5) st.drive();
      return p;
    },
    draw(ov, t) {
      ov.fill('#000', 1 - ramp(t, 0, 2.2, ease.inOut));
      ov.line('Every world is brand new.', t - 0.8, 3.2, { y: ov.H * 0.47 });
      ov.line('Every weapon is one of a kind.', t - 4.4, 3.4, { y: ov.H * 0.47 });
    },
  },
  logo: {
    continues: 'aerial',
    enter(shot, prev) {
      if (prev?.id !== 'aerial') {
        scenes.aerial.enter();
        prerollScene(scenes.aerial, 8);
      }
      S.logoT0 = 8;
    },
    tick(t) {
      scenes.aerial.tick(t + 8);
      if (t < 0.05) {
        G().shake = 0.5;
        G().flash('#ffd24a', 0.4);
      }
    },
    draw(ov, t, shot) {
      ov.fill('#0b0714', 0.45 * ramp(t, 0, 0.3));
      ov.vignette(0.7);
      ov.fill('#ffffff', 0.8 * (1 - ramp(t, 0, 0.35)));
      ov.logo(t, { alpha: 1 - ramp(t, shot.dur - 0.35, shot.dur, ease.in) });
    },
  },

  // Explore -------------------------------------------------------------------------------------
  plains: {
    enter() {
      st.zoom(4);
      st.setHour(9.5);
      const spot = clearing(24, 26, 2);
      st.teleport(spot.x, spot.y);
      equip(arsenal.rareSword);
      st.monster('slime', 9, -2, { alert: false });
      st.monster('slime', 10, 1.5, { alert: false });
      st.monster('boar', 13, 3, { alert: false });
    },
    tick() {
      run(1, -0.12);
    },
  },
  forest: {
    enter() {
      st.zoom(4);
      st.setHour(19.1);
      st.teleport(74, -52);
      st.monster('wisp', 7, -4, { alert: false });
      st.monster('wisp', 10, 2, { alert: false });
    },
    tick() {
      run(0.9, -0.45);
    },
  },
  desert: {
    enter() {
      st.zoom(4);
      st.setHour(13);
      const spot = clearing(150, 0, 2);
      st.teleport(spot.x, spot.y);
      equip(arsenal.rareSword);
      st.monster('scorpion', 5, 0.5);
      st.monster('scorpion', 6.5, -1.5);
      st.monster('mummy', 9, 2);
    },
    tick() {
      run(1, 0.05, { attack: true, lead: 2 });
    },
  },
  snow: {
    enter() {
      st.zoom(4);
      st.setHour(11);
      const spot = clearing(62, 8, 2);
      st.teleport(spot.x, spot.y);
      for (let i = 0; i < 4; i++) st.monster('wolf', -5 - i * 1.2, -1 + (i % 2) * 2.5, { level: 10 });
    },
    tick() {
      run(1, 0.25, { lead: 1 });
    },
  },
  ashlands: {
    enter() {
      st.zoom(4);
      st.setHour(22);
      const spot = clearing(2, -112, 1);
      st.teleport(spot.x, spot.y);
      st.monster('imp', 6, -3);
      st.monster('imp', 8, 2);
    },
    tick() {
      run(0.85, -0.5, { attack: true });
    },
  },
  void: {
    enter() {
      st.zoom(4);
      st.setHour(23);
      const spot = clearing(107, 66, 1);
      st.teleport(spot.x, spot.y);
      st.monster('eye', 7, -3, { alert: false });
      st.monster('shade', 9, 2, { alert: false });
      st.monster('wisp', -4, -3, { alert: false });
    },
    tick() {
      run(1, 0.3);
    },
  },
  sail: {
    enter() {
      const g = G();
      st.zoom(4);
      st.setHour(16.5);
      g.save.tools.boat = 3;
      const w = g.world;
      const spot = findWhere(412, -30, (x, y) => w.seaAt(x, y) === SEA.SHALLOW && w.seaAt(x + 6, y) <= SEA.ISLE_BEACH, 80, 2);
      st.teleport(spot.x - 1, spot.y, { sail: true, exact: true });
      st.spawns(true);
      for (let i = 0; i < 3; i++) st.monster('shark', -3 + i * 3, 3 + (i % 2) * 2);
      S.serpent = null;
    },
    tick(t) {
      run(0.2, -1, { lead: 2 });
      if (t > 1.2 && !S.serpent) S.serpent = st.monster('serpent', -5, -6, { level: 14 });
    },
  },
  ride: {
    enter() {
      st.zoom(4);
      st.setHour(15);
      const spot = clearing(36, 66, 2, 'horse');
      st.teleport(spot.x, spot.y);
      st.ride('courser');
    },
    tick() {
      run(1, 0.08, { lead: 3 });
    },
    leave() {
      st.unride();
    },
  },

  // The far lands -------------------------------------------------------------------------------
  prism: {
    enter() {
      st.zoom(4);
      st.setHour(12.5);
      const spot = clearing(165, 243, 1);
      st.teleport(spot.x, spot.y);
      equip(arsenal.prismStaff);
      st.horde(['shardling', 'shardling', 'refractor'], 6, 6);
      st.monster('mirror_knight', 6, 1);
    },
    tick(t) {
      run(0.6, 0.2, { attack: true, sprint: false, lead: 1 });
      if (t > 1.0 && t < 1.05) cast();
    },
  },
  fen: {
    enter() {
      st.zoom(4);
      st.setHour(22.5);
      const spot = clearing(-303, 38, 1);
      st.teleport(spot.x, spot.y);
      equip(arsenal.rareSword);
      st.monster('glowmoth', 5, -3, { alert: false });
      st.monster('glowmoth', 7, 1, { alert: false });
      st.monster('bogling', 6, 3);
    },
    tick() {
      run(1, -0.1, { lead: 2 });
    },
  },
  skyreach: {
    enter() {
      const g = G();
      st.zoom(3);
      st.setHour(10.5);
      // A plank bridge between two islands, the clouds all round.
      st.teleport(259.5, 233.5, { exact: true });
      st.ride('courser');
      st.monster('gale_sprite', 6, -5, { alert: false });
      st.monster('cloud_ray', -6, 4, { alert: false });
    },
    tick() {
      run(1, 0, { lead: 4 });
    },
    leave() {
      st.unride();
    },
  },
  village: {
    enter() {
      const g = G();
      st.zoom(3);
      st.setHour(10);
      const v = g.world.firstVillage;
      st.teleport(v.x - 14, v.y + 3);
      S.to = { x: v.x + 2, y: v.y + 1 };
      equip(arsenal.rareSword);
    },
    tick() {
      st.walkTo(S.to.x, S.to.y, { sprint: false });
      st.pan(4, 0);
    },
  },
  market: {
    enter() {
      const g = G();
      st.zoom(3);
      st.setHour(16.5);
      const m = g.world.firstMarket;
      st.teleport(m.x - 10, m.y + 2);
      S.to = { x: m.x + 6, y: m.y + 1 };
    },
    tick() {
      st.walkTo(S.to.x, S.to.y, { sprint: false });
      st.pan(4, 0);
    },
  },
  ruins: {
    enter() {
      const g = G();
      st.zoom(4);
      st.setHour(17.6);
      const site = g.world.sitesNear(38, -200, 30).find((x) => x.type === 'ruins') ?? g.world.sitesNear(0, 0, 300).find((x) => x.type === 'ruins');
      S.site = site;
      st.teleport(site.x - 1.5, site.y + 4.5);
      equip(arsenal.emberBlade);
      g.save.world.found = (g.save.world.found ?? []).filter((k) => k !== site.key);
      S.searched = false;
    },
    tick(t) {
      const g = G();
      if (!S.searched) {
        st.walkTo(S.site.x - 0.3, S.site.y + 1.2, { sprint: false, stop: 0.2 });
        if (g.interactTarget?.type === 'ruins' || t > 0.7) {
          S.searched = true;
          if (g.interactTarget?.type === 'ruins') st.press('interact');
        }
      } else {
        st.drive({ attack: true });
      }
      st.pan(0, -1);
    },
  },

  // Weapons ------------------------------------------------------------------------------------
  chest: {
    enter() {
      const g = G();
      st.zoom(6);
      st.setHour(14);
      const w = g.world;
      // A chest in the plains, not opened yet.
      let chest = null;
      for (const r of [1, 2, 3]) {
        chest = w.objectsNear(-30, 30, r).find((o) => o.type === 'chest' && w.biomeAt(Math.floor(o.x), Math.floor(o.y)).id !== 'void');
        if (chest) break;
      }
      S.chest = chest;
      st.teleport(chest.x - 3, chest.y + 0.6);
      S.opened = false;
      S.skipped = false;
      equip(arsenal.rareSword);
      g.save.world.chests = g.save.world.chests.filter((k) => k !== chest.key);
      window.__vt.onAnimation = (a) => {
        if (a.effect?.target?.classList?.contains('case-strip')) a.playbackRate = 2;
      };
    },
    tick(t) {
      const g = G();
      if (!S.opened) {
        const d = st.walkTo(S.chest.x - 0.9, S.chest.y + 0.5, { sprint: false, stop: 0.15 });
        st.pan(0.6, -0.3);
        if (d < 0.2 || t > 0.9) {
          S.opened = true;
          st.drive();
          g.save.world.chests.push(S.chest.key);
          g.fx.emit('sparkle', S.chest.x, S.chest.y, 16, 0.6, 3);
          g.discoverWeapon(arsenal.found, { caseRoll: { min: 'common', max: 'legendary', title: 'Opening chest…' } });
          S.openAt = t;
        }
      } else if (!S.skipped && t - S.openAt > 2.75) {
        S.skipped = true;
        document.querySelector('.case-roll .skip')?.click();
      }
    },
    leave() {
      closeModals();
      window.__vt.onAnimation = null;
    },
  },
  gallery: {
    enter() {
      st.zoom(4);
      st.setHour(21);
      st.teleport(0.5, 3);
      S.cells = [];
    },
    tick() {},
    draw(ov, t, shot) {
      drawGallery(ov, t, shot.dur);
    },
  },
  evolve: {
    enter() {
      const g = G();
      st.zoom(6);
      st.setHour(20.2);
      st.camp(7);
      st.teleport(-4.5, 0.6, { exact: true });
      S.steps = evolutionSteps(arsenal.found);
      equip(S.steps[0].dna);
      S.at = 0;
      S.changedAt = 0;
      g.player.facing = 0;
    },
    tick(t) {
      const g = G();
      st.drive();
      st.pan(0, -0.6);
      // A step every 0.95 s, the last one with a bang.
      const want = Math.min(S.steps.length - 1, Math.floor((t - 0.35) / 0.95) + 1);
      if (t > 0.35 && want > S.at) {
        S.at = want;
        S.changedAt = t;
        const { dna, node } = S.steps[S.at];
        const p = g.player;
        // The weapon keeps its id: the DNA changes in place, as the game's evolve() does.
        equip(dna);
        g.fx.add({ type: 'ring', x: p.x, y: p.y, r0: 0.3, r1: 2 + S.at * 0.5, color: rarityColor(dna), dur: 0.6, fill: S.at >= 4 });
        g.fx.emit('glint', p.x, p.y - 0.5, 14 + S.at * 8, 1.2, 3, [rarityColor(dna), '#ffffff']);
        if (S.at >= 4) {
          g.flash(rarityColor(dna), 0.4);
          g.shake = 0.35;
        }
        if (S.at === S.steps.length - 1) g.fx.add({ type: 'pillar', x: p.x, y: p.y, r: 0.6, color: '#ffd24a', dur: 0.9 });
        if (node) g.player.attackAnim = { t: 0, dur: 0.35, angle: -0.3, dir: 1 };
      }
    },
    draw(ov, t) {
      drawEvolution(ov, t);
    },
  },

  // Legendary powers -------------------------------------------------------------------------------
  starfall: powerScene({ weapon: 'starStaff', hour: 22.5, at: [20, 30], kinds: ['skeleton', 'slime', 'brute'], n: 12, castAt: [0.12, 1.2] }),
  breath: powerScene({ weapon: 'emberBlade', hour: 20.3, at: [3, -128], kinds: ['imp', 'brute', 'slime'], n: 10, castAt: [0.1] }),
  zero: powerScene({ weapon: 'frostLance', hour: 11, at: [66, 18], kinds: ['wolf', 'yeti', 'wolf'], n: 12, castAt: [0.1] }),
  storms: powerScene({ weapon: 'stormHammer', hour: 17.8, at: [141, -139], kinds: ['harpy', 'golem', 'skeleton'], n: 11, castAt: [0.1] }),
  horizon: powerScene({ weapon: 'voidScythe', hour: 21.5, at: [110, 70], kinds: ['eye', 'shade', 'wisp'], n: 13, castAt: [0.1] }),
  blades: powerScene({ weapon: 'bladeFan', hour: 15, at: [-56, 64], kinds: ['spider', 'wisp', 'slime'], n: 12, castAt: [0.1, 1.15] }),

  // Bosses ---------------------------------------------------------------------------------------------
  'boss:inferno_titan': bossScene({ boss: 'inferno_titan', weapon: 'emberBlade', hour: 20.5, at: [147.5, 40], preroll: 2.2 }),
  'boss:frost_warden': bossScene({ boss: 'frost_warden', weapon: 'frostLance', hour: 11, at: [-62.5, 268], preroll: 2.6 }),
  'boss:storm_colossus': bossScene({ boss: 'storm_colossus', weapon: 'stormHammer', hour: 19.5, at: [-331.5, -198], preroll: 2.4 }),
  'boss:prism_warden': bossScene({ boss: 'prism_warden', weapon: 'starStaff', hour: 13, at: [165, 243], preroll: 2.8 }),
  'boss:aether_roc': bossScene({ boss: 'aether_roc', weapon: 'stormBow', hour: 9, at: null, biome: 'skyreach', near: [-159, 247], preroll: 3.2 }),
  'boss:tide_leviathan': bossScene({ boss: 'tide_leviathan', weapon: 'bladeFan', hour: 17, at: [801.5, -576], preroll: 2.8 }),

  // The camp --------------------------------------------------------------------------------------------
  build: {
    enter() {
      const g = G();
      st.zoom(3);
      st.setHour(10.5);
      st.camp(7);
      st.razeAll();
      st.teleport(0.5, 9);
      st.pal('mossling', 8);
      equip(arsenal.emberBlade);
      S.plan = fortressPlan();
      S.built = 0;
      // A few workers off to the woods.
      g.save.base.workers = [{ id: 1, role: 'wood' }, { id: 2, role: 'stone' }, { id: 3, role: 'wood' }, { id: 4, role: 'wood' }];
      g.workforce.sync();
    },
    tick(t) {
      const want = Math.floor(S.plan.length * ramp(t, 0.2, 3.3, ease.inOut));
      if (want > S.built) {
        st.raise(S.plan.slice(S.built, want));
        S.built = want;
      }
      st.drive({ x: 0.3 * Math.sin(t), y: 0 });
      hold(0.5, 0.5);
    },
  },
  defend: {
    enter() {
      const g = G();
      st.zoom(3);
      st.setHour(22);
      st.camp(7);
      st.razeAll();
      st.raise(fortressPlan(), { dust: false });
      st.teleport(0.5, 14.5);
      st.pal('emberpup', 8);
      equip(arsenal.emberBlade);
      S.waveT = 0;
      for (let i = 0; i < 16; i++) {
        const a = Math.PI * 0.15 + (i / 16) * Math.PI * 0.7;
        st.monster(['skeleton', 'brute', 'boar', 'slime'][i % 4], 0.5 + Math.cos(a) * 22 - 0.5, 0.5 + Math.sin(a) * 18, { rel: false, level: 14 });
      }
      st.spawns(false);
    },
    tick(t) {
      st.walkTo(0.5, 15.5, { sprint: false, attack: true });
      st.pan(0, -1.5);
      S.waveT -= DT;
      if (S.waveT <= 0) {
        S.waveT = 0.25;
        const a = Math.PI * 0.15 + Math.random() * Math.PI * 0.7;
        if (G().enemies.length < 24) st.monster(['skeleton', 'brute', 'boar', 'wolf'][Math.floor(Math.random() * 4)], 0.5 + Math.cos(a) * 24, 0.5 + Math.sin(a) * 19, { rel: false, level: 14 });
      }
      if (t > 2.4 && t < 2.42) cast();
    },
  },
  friends: {
    enter() {
      const g = G();
      st.zoom(4);
      st.setHour(16);
      const spot = clearing(282, 556, 3);
      st.teleport(spot.x, spot.y + 3);
      equip(arsenal.voidScythe);
      S.boss = st.boss('bone_king', 0, -4);
      st.friends([
        { name: 'Astrid', tag: 'ULV', cloak: '#c8364a', weapon: arsenal.frostLance, dx: -2.6, dy: -0.8 },
        { name: 'Kai', tag: 'ULV', cloak: '#3aa860', weapon: arsenal.stormBow, dx: 2.8, dy: 0.6 },
        { name: 'Noor', tag: 'ULV', cloak: '#d8a020', weapon: arsenal.starStaff, dx: 0.4, dy: 2.4 },
      ]);
    },
    preroll: 1.6,
    tick(t, dt) {
      const b = S.boss;
      const g = G();
      const c = b && !b.dead ? b : g.player;
      strafe(t, c.x, c.y, 4.2, 0.7);
      st.moveFriends(dt, { x: c.x, y: c.y + 0.5 });
      if (t > 1.3 && t < 1.32) cast();
      if (b && b.hp < b.maxHp * 0.35) b.hp = b.maxHp * 0.6;
    },
    leave() {
      G().others = null;
    },
  },

  montage: {
    enter() {
      S.cut = -1;
    },
    tick(t) {
      const cuts = MONTAGE;
      const i = Math.min(cuts.length - 1, Math.floor(t / (BAR / 4)));
      if (i !== S.cut) {
        S.cut = i;
        const c = cuts[i];
        const sc = scenes[c.id];
        S.sub = sc;
        S.subId = c.id;
        S.subOffset = c.at;
        cleanSlate();
        sc.enter({ id: c.id, dur: 2 }, null);
        prerollScene(sc, c.at);
        S.cutT = t;
      }
      S.sub.tick?.(t - S.cutT + S.subOffset, DT);
    },
    draw(ov, t) {
      // A flash on every cut.
      const into = t % (BAR / 4);
      ov.fill('#ffffff', 0.35 * (1 - ramp(into, 0, 0.12)));
    },
  },
  end: {
    enter() {
      st.zoom(3);
      st.setHour(19.2);
      st.camp(7);
      st.razeAll();
      st.raise(fortressPlan(), { dust: false });
      st.teleport(0.5, 4);
      equip(arsenal.emberBlade);
      st.pal('glimmerfox', 8);
    },
    tick(t) {
      st.drive({ x: 0, y: 0 });
      hold(0.5 + t * 0.35, 1 - t * 0.12);
    },
    draw(ov, t, shot) {
      ov.fill('#0b0714', 0.55 * ramp(t, 0, 0.6));
      ov.vignette(0.75);
      ov.fill('#ffffff', 0.85 * (1 - ramp(t, 0, 0.4)));
      const out = 1 - ramp(t, shot.dur - 1.4, shot.dur - 0.1, ease.inOut);
      ov.logo(t, { y: ov.H * 0.42, alpha: out, tagline: 'Find it. Forge it. Grow it into a legend.' });
      const k = Math.min(ramp(t, 1.6, 2.3), out);
      ov.text('PLAY FREE IN YOUR BROWSER', ov.W / 2, ov.H * 0.74, { px: 52, fill: ['#ffffff', '#9ee8ff'], alpha: k, outline: 9, shadow: 5, spacing: 6 });
      ov.text('Install on any device  ·  Works offline  ·  Multiplayer', ov.W / 2, ov.H * 0.74 + 62 * ov.u, { px: 32, weight: 500, fill: '#e8e0ff', alpha: Math.min(ramp(t, 2.0, 2.7), out), outline: 6, shadow: 4 });
    },
  },
};

/** The montage: quick cuts into the thick of earlier shots ({ id, at: seconds in }). */
const MONTAGE = [
  { id: 'starfall', at: 0.55 },
  { id: 'boss:inferno_titan', at: 1.2 },
  { id: 'sail', at: 1.4 },
  { id: 'breath', at: 0.5 },
  { id: 'ride', at: 1.2 },
  { id: 'horizon', at: 0.7 },
  { id: 'boss:prism_warden', at: 1.2 },
  { id: 'blades', at: 0.6 },
];

function powerScene({ weapon, hour, at, kinds, n, castAt = [0.1], biome = null }) {
  return {
    enter() {
      st.zoom(4);
      st.setHour(hour);
      const spot = clearing(at[0], at[1], 3);
      st.teleport(spot.x, spot.y);
      equip(arsenal[weapon]);
      st.horde(kinds, n, 5.5, { level: 14 });
      S.cast = 0;
    },
    preroll: 0.35,
    tick(t) {
      st.drive({ attack: true });
      keepHorde(kinds, Math.round(n * 0.6), 7, { level: 14 });
      st.pan(0, -0.5);
      if (S.cast < castAt.length && t >= castAt[S.cast]) {
        S.cast++;
        cast();
      }
    },
  };
}

function bossScene({ boss, weapon, hour, at, biome = null, near = null, preroll = 2.5 }) {
  return {
    enter() {
      const g = G();
      st.zoom(4);
      st.setHour(hour);
      let spot;
      if (at) spot = clearing(at[0], at[1], 4);
      else {
        const w = g.world;
        spot = findWhere(near[0], near[1], (x, y) => biomeIs(biome)(x, y) && [[0, 0], [5, 0], [-5, 0], [0, 4], [0, -4]].every(([dx, dy]) => w.isFree(x + dx, y + dy, 0.5, 'player')), 200, 2);
      }
      st.teleport(spot.x, spot.y + 3);
      equip(arsenal[weapon]);
      g.godMode = true;
      S.boss = st.boss(boss, 0, -4.5);
      S.center = { x: spot.x, y: spot.y };
      S.cast = false;
    },
    preroll,
    tick(t) {
      const g = G();
      const b = S.boss;
      const c = b && !b.dead ? b : S.center;
      strafe(t, c.x, c.y, 4.6, 0.8);
      st.pan((c.x - g.player.x) * 0.45, (c.y - g.player.y) * 0.45 - 0.5);
      if (!S.cast && t > preroll + 0.6) {
        S.cast = true;
        cast();
      }
      // A boss is never beaten in its shot (it has the whole fight ahead).
      if (b && b.hp < b.maxHp * 0.35) b.hp = b.maxHp * 0.6;
    },
    leave() {
      G().godMode = false;
    },
  };
}

/** The camp's walls: a ring of stone with four gates, towers and torches inside. */
function fortressPlan() {
  const out = [];
  const R = 15;
  const seen = new Set();
  for (let i = 0; i < 360; i++) {
    const a = (i / 360) * TAU;
    const x = Math.round(Math.cos(a) * R);
    const y = Math.round(Math.sin(a) * R * 0.92);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gate = (Math.abs(x) <= 1 && Math.abs(y) > 10) || (Math.abs(y) <= 1 && Math.abs(x) > 10);
    out.push({ id: gate ? 'iron_gate' : 'iron_wall', x, y });
  }
  // (In build order: around the ring from the south gate.)
  out.sort((p, q) => ((Math.atan2(p.y, p.x) - Math.PI / 2 + TAU * 2) % TAU) - ((Math.atan2(q.y, q.x) - Math.PI / 2 + TAU * 2) % TAU));
  const towers = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU + 0.31;
    const x = Math.round(Math.cos(a) * (R - 2.5));
    const y = Math.round(Math.sin(a) * (R - 2.5) * 0.92);
    towers.push({ id: i % 3 === 0 ? 'ballista' : i % 3 === 1 ? 'flame_turret' : 'arrow_turret', x, y });
    towers.push({ id: 'torch', x: Math.round(Math.cos(a + 0.3) * (R - 1.7)), y: Math.round(Math.sin(a + 0.3) * (R - 1.7) * 0.92) });
  }
  towers.push({ id: 'sunfire_obelisk', x: 9, y: 6 }, { id: 'sunfire_obelisk', x: -9, y: 6 });
  // A paved road from the south gate to the hearth.
  for (let y = 9; y <= 13; y++) for (const x of [0, 1]) out.push({ id: 'stone_floor', x, y });
  return [...out, ...towers];
}

// --- The two shots drawn on top -------------------------------------------------------------------

function rarityColor(dna) {
  return G().data.byId.rarities.get(dna.rarity)?.color ?? '#ffffff';
}

/** Rows of weapons, each one rolled from its own DNA, flipping over and over. */
function drawGallery(ov, t, dur) {
  const u = ov.u;
  const fade = envelope(t, dur, 0.25, 0.3);
  ov.fill('#0d0a18', 0.94 * fade);
  // A slow starfield of glints behind.
  const c = ov.ctx;
  c.save();
  for (let i = 0; i < 70; i++) {
    const x = ((i * 271.3 + t * (18 + (i % 5) * 9)) % (ov.W + 40)) - 20;
    const y = (i * 137.7) % ov.H;
    c.globalAlpha = fade * (0.15 + ((i * 7) % 10) / 30);
    c.fillStyle = i % 3 ? '#8fe3ff' : '#ffd24a';
    c.fillRect(x, y, 3 * u, 3 * u);
  }
  c.restore();
  const cols = 7;
  const rows = 3;
  const size = 196 * u;
  const gap = 26 * u;
  const x0 = ov.W / 2 - (cols * size + (cols - 1) * gap) / 2;
  const y0 = ov.H * 0.43 - (rows * size + (rows - 1) * gap) / 2;
  const list = arsenal.gallery;
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const i = r * cols + q;
      // Each slot rolls fast, then slows and settles, left to right.
      const settle = 1.4 + (q + r * 0.5) * 0.11;
      const rate = t < settle ? 12 : 0;
      const k = Math.floor(t < settle ? t * rate : settle * 12);
      const dna = list[(i * 13 + k * 7) % list.length];
      const color = rarityColor(dna);
      const pop = t >= settle ? 1 + 0.12 * (1 - ramp(t, settle, settle + 0.3)) : 1;
      const x = x0 + q * (size + gap);
      const y = y0 + r * (size + gap);
      const enter = ramp(t, i * 0.02, i * 0.02 + 0.3);
      const a = fade * enter;
      if (a <= 0) continue;
      const s = size * pop;
      ov.frame(x + (size - s) / 2, y + (size - s) / 2, s, s, color, { alpha: a, glow: dna.rarity === 'legendary' || dna.rarity === 'epic' });
      const icon = arsenal.icons.get(dna.id) ?? weaponIcon(dna, 48);
      arsenal.icons.set(dna.id, icon);
      ov.sprite(icon, x + size / 2, y + size / 2, (4.2 * u) * pop, { alpha: a });
    }
  }
  // Counting up to the seeds a weapon can be rolled from (32 bits of them).
  const count = Math.round(2 ** 32 * ramp(t, 0.3, 2.6, ease.inOut));
  ov.text(`${count.toLocaleString('en-US')} seeds for every kind of weapon`, ov.W / 2, y0 + rows * (size + gap) + 30 * u, { px: 30, weight: 500, fill: '#b8b0d8', alpha: fade * ramp(t, 0.3, 0.6), outline: 5, shadow: 2 });
}

/** The weapon grown step by step: big in a frame, its name and the step under it. */
function drawEvolution(ov, t) {
  const u = ov.u;
  const steps = S.steps;
  if (!steps) return;
  const cur = steps[S.at];
  const dna = cur.dna;
  const color = rarityColor(dna);
  const since = t - (S.changedAt || 0);
  const a = envelope(t, 3 * BAR, 0.3, 0.3);
  const cx = ov.W * 0.76;
  const cy = ov.H * 0.40;
  const box = 330 * u;
  const pop = 1 + 0.18 * (1 - ramp(since, 0, 0.35, ease.out));
  ov.fill('#000', 0);
  // Light behind the frame in the weapon's rarity colour.
  const c = ov.ctx;
  c.save();
  c.globalAlpha = a * 0.7;
  const gl = c.createRadialGradient(cx, cy, 0, cx, cy, box);
  gl.addColorStop(0, `${color}aa`);
  gl.addColorStop(1, `${color}00`);
  c.fillStyle = gl;
  c.fillRect(cx - box * 1.2, cy - box * 1.2, box * 2.4, box * 2.4);
  c.restore();
  ov.frame(cx - (box * pop) / 2, cy - (box * pop) / 2, box * pop, box * pop, color, { alpha: a, glow: true });
  const { canvas } = weaponSprite(dna);
  const fit = Math.min((box * 0.82) / canvas.height, (box * 0.82) / canvas.width);
  ov.sprite(canvas, cx, cy, fit * pop, { alpha: a, rot: Math.PI / 4 * (canvas.height > canvas.width * 1.3 ? 1 : 0) });
  // A white flash on each step.
  if (since < 0.2) {
    c.save();
    c.globalAlpha = a * (1 - since / 0.2) * 0.8;
    c.fillStyle = '#ffffff';
    c.fillRect(cx - (box * pop) / 2, cy - (box * pop) / 2, box * pop, box * pop);
    c.restore();
  }
  const rarity = G().data.byId.rarities.get(dna.rarity)?.name.toUpperCase() ?? '';
  ov.text(rarity, cx, cy + box / 2 + 54 * u, { px: 34, fill: color, alpha: a, outline: 6, shadow: 3, spacing: 8 });
  ov.text(dna.name.text, cx, cy + box / 2 + 104 * u, { px: 40, fill: '#ffffff', alpha: a, outline: 7, shadow: 4 });
  ov.text(cur.step, cx, cy - box / 2 - 30 * u, { px: 34, weight: 500, fill: S.at === steps.length - 1 ? '#ffd24a' : '#e8e0ff', alpha: a * ramp(since, 0, 0.2), outline: 6, shadow: 3 });
  // Five pips for the five steps.
  for (let i = 1; i < steps.length; i++) {
    const on = i <= S.at;
    const px = cx + (i - 3) * 46 * u;
    const py = cy + box / 2 + 150 * u;
    c.save();
    c.globalAlpha = a;
    c.translate(px, py);
    c.rotate(Math.PI / 4);
    c.fillStyle = '#120f1c';
    c.fillRect(-13 * u, -13 * u, 26 * u, 26 * u);
    c.fillStyle = on ? rarityColor(steps[i].dna) : '#3a3450';
    c.fillRect(-8 * u, -8 * u, 16 * u, 16 * u);
    c.restore();
  }
}

// --- Running the show ---------------------------------------------------------------------------------

let ov = null;
let shots = [];
let current = null;
let frame = 0;
let shotT0 = 0;

function closeModals() {
  const g = G();
  closeModal(true);
  g.discoveryOpen = false;
  g.discoveryQueue.length = 0;
  g.pauseReasons.clear();
}

function cleanSlate() {
  const g = G();
  closeModals();
  st.clearStage();
  st.unride();
  g.others = null;
  g.godMode = false;
  g.save.player.sailing = false;
  g.pal = null;
  g.save.pals.active = null;
  st.spawns(false);
  st.cinematic(true);
}

/** Runs a scene for `seconds` without filming (to start a shot in the thick of things). */
function prerollScene(scene, seconds) {
  const g = G();
  for (let t = 0; t < seconds; t += DT) {
    scene.tick?.(t, DT);
    st.holdStage();
    simulate(g);
  }
}

function simulate(g) {
  if (g.hitstop > 0 && !g.paused) g.hitstop -= DT;
  else if (!g.paused) g.update(DT);
}

function enter(shot, prev) {
  current?.scene?.leave?.();
  const scene = scenes[shot.id];
  if (!(scene.continues && prev?.id === scene.continues)) cleanSlate();
  scene.enter(shot, prev);
  current = { shot, scene };
  shotT0 = shot.start;
  if (scene.preroll) prerollScene(scene, scene.preroll);
}

/** Set up once, before the clock is frozen. */
export async function prepare() {
  await document.fonts.load('700 64px "Pixelify Sans"');
  await document.fonts.load('500 64px "Pixelify Sans"');
  const g = G();
  g.stop();
  ov = new Overlay();
  shots = schedule();
  st.cinematic(true);
  // A strong player: level 48, everything researched (nothing filmed is kept).
  g.save.player.level = 48;
  g.recomputeStats();
  arsenal.rareSword = st.makeWeapon({ archetype: 'sword', rarity: 'rare', seed: 0xb1ade, level: 30 });
  arsenal.found = st.makeWeapon({ archetype: 'sword', rarity: 'rare', seed: 0x7ea5, level: 30 });
  arsenal.prismStaff = awakened('wand', 'staff', 'arcane', 'starfall', 0x51a7);
  arsenal.starStaff = awakened('wand', 'staff', 'arcane', 'starfall', 0x5ad);
  arsenal.emberBlade = awakened('sword', 'titan', 'fire', 'dragon_breath', 0xe3b);
  arsenal.frostLance = awakened('spear', 'lance', 'ice', 'absolute_zero', 0xf05);
  arsenal.stormHammer = awakened('axe', 'quake', 'lightning', 'wrath_of_storms', 0x570);
  arsenal.voidScythe = awakened('sword', 'reaper', 'void', 'event_horizon', 0x01d);
  arsenal.bladeFan = awakened('throwing', 'warfan', 'bleed', 'thousand_blades', 0xb1a);
  arsenal.stormBow = awakened('bow', 'longbow', 'wind', 'wrath_of_storms', 0xb0);
  // The gallery: weapons of every kind and rarity.
  const kinds = g.data.archetypes.map((a) => a.id);
  const rarities = ['common', 'uncommon', 'rare', 'rare', 'epic', 'epic', 'legendary'];
  arsenal.gallery = [];
  for (let i = 0; i < 140; i++) {
    arsenal.gallery.push(st.makeWeapon({ archetype: kinds[i % kinds.length], rarity: rarities[(i * 5) % rarities.length], seed: 0x6a11e + i * 7919, level: 30 }));
  }
  arsenal.icons = new Map();
  st.takeControls();
}

/** Skips straight to a shot (for previews). */
export function seek(seconds) {
  current?.scene?.leave?.();
  frame = Math.round(seconds * FPS);
  current = null;
}

export const total = () => Math.round(DURATION * FPS);

/** One frame of the trailer: the shot's direction, a step of the game, the picture, the titles. */
export function step() {
  const g = G();
  const t = frame / FPS;
  frame++;
  const shot = shots.find((s) => t >= s.start - 1e-9 && t < s.end - 1e-9) ?? shots[shots.length - 1];
  if (current?.shot !== shot) enter(shot, current?.shot ?? null);
  const lt = t - shot.start;
  current.scene.tick?.(lt + (current.scene.preroll ?? 0), DT, shot);
  st.holdStage();
  simulate(g);
  g.renderer.draw(g);
  ov.clear();
  current.scene.draw?.(ov, lt, shot);
  if (shot.label) ov.label(shot.label, shot.kind, lt, shot.dur);
  const bar = t / BAR;
  for (const title of TITLES) {
    if (bar >= title.at && bar < title.at + title.bars) ov.title(title.text, title.sub, t - title.at * BAR, title.bars * BAR);
  }
  ov.letterbox(1);
  // The very end fades to black, bars and all.
  if (shot.id === 'end') ov.fill('#000', ramp(lt, shot.dur - 0.9, shot.dur, ease.in));
  return { t, shot: shot.id };
}
