// Bosses in multiplayer: every attack of single player's bosses
// (src/game/enemies.js bossPattern) with the same timings and numbers,
// aimed at the boss's target or spread over the players around it, and
// hurting everyone who stands where it lands. Telegraphs warn everyone.

import * as combat from './combat.js';
import { applyPlayerStatus } from './players.js';
import { spawnEnemy } from './enemies.js';
import { segmentDist2 } from '../src/core/math.js';
import { laserField, LASER_WIDTH } from '../src/game/lasers.js';

const FX_RADIUS = 34;
const r2 = (v) => Math.round(v * 100) / 100;

// --- Helpers -----------------------------------------------------------------------------

/** What everyone nearby sees and hears (the client plays these like ability effects). */
function fx(gs, x, y, ops) {
  gs.event(x, y, { k: 'fx', fx: 'boss', x: r2(x), y: r2(y), ops }, FX_RADIUS);
}
const add = (shape) => {
  const s = {};
  for (const [k, v] of Object.entries(shape)) s[k] = typeof v === 'number' ? r2(v) : v;
  return ['add', s];
};
const emit = (kind, x, y, n, spread = 0.3, speed = 1.5) => ['emit', kind, r2(x), r2(y), n, r2(spread), r2(speed)];
const snd = (name, opts) => (opts ? ['snd', name, opts] : ['snd', name]);

/** Living players in a circle (counting their own size). */
function playersIn(gs, x, y, r) {
  const out = [];
  for (const p of gs.playersNear(x, y, r + 1)) {
    if (!p.dead && (p.x - x) ** 2 + (p.y - y) ** 2 <= (r + p.r) ** 2) out.push(p);
  }
  return out;
}

/** Hurts everyone in a circle; optionally gives them a status too. */
function strike(gs, b, x, y, r, damage, element, status = null) {
  for (const p of playersIn(gs, x, y, r)) {
    combat.hurtPlayer(gs, p, damage, { element, fromX: x, fromY: y });
    if (status) applyPlayerStatus(gs, p, status, damage * 0.15);
  }
}

/** A warning on the ground; `then` runs when it goes off. */
function warn(gs, b, o, then) {
  return combat.spawnArea(gs, {
    kind: 'telegraph', damage: 0, quiet: true, enemy: b.id, color: b.color, ...o,
    after: () => {
      if (!b.dead && gs.enemies.has(b.id)) then?.();
    },
  });
}

function shot(gs, b, angle, { speed = 6, damage, size = 3, sprite = 'orb', element = b.element, color = null, status = null, x = b.x, y = b.y, range = 14 }) {
  combat.spawnProjectile(gs, {
    x, y, angle, speed, damage, range, element, sprite, size, enemy: b.id, status,
    color: color ?? gs.data.byId.elements.get(element)?.glow ?? b.color, kind: 'shot',
  });
}

function hazard(gs, b, x, y, r, dur, dps, element) {
  combat.spawnArea(gs, { kind: 'hazard', x, y, r, dur, damage: dps, element, enemy: b.id, color: gs.data.byId.elements.get(element)?.glow ?? b.color });
}

/** Players the boss is fighting (its target first). */
function fighters(gs, b, p) {
  const out = [p];
  for (const o of gs.playersNear(b.x, b.y, 24)) if (o !== p && !o.dead) out.push(o);
  return out;
}

/** A random one of the players the boss is fighting (its target half the time). */
function someone(gs, b, p) {
  if (Math.random() < 0.5) return p;
  const list = fighters(gs, b, p);
  return list[(Math.random() * list.length) | 0];
}

function norm(x, y) {
  const d = Math.sqrt(x * x + y * y) || 1;
  return { x: x / d, y: y / d };
}

function vanish(gs, e) {
  e.dead = true;
  gs.enemies.delete(e.id);
  fx(gs, e.x, e.y, [emit('void', e.x, e.y, 14, e.r * 2)]);
}

// --- The attacks -----------------------------------------------------------------------------

/** Starts one attack; returns how long until the next. */
function pattern(gs, b, p, name) {
  const dmg = b.dmg * 0.8;
  const speed = b.phase === 2 ? 7 : 6;
  const color = b.color;
  const later = (t, fn) => gs.schedule(t, () => {
    if (!b.dead && gs.enemies.has(b.id)) fn();
  });
  switch (name) {
    case 'lasers': {
      // Laser fields around one of the fighters (as in single player).
      const t = someone(gs, b, p);
      for (const beam of laserField(t.x, t.y, b.phase)) {
        warn(gs, b, { shape: 'line', laser: true, x: beam.x, y: beam.y, x2: beam.x2, y2: beam.y2, r: LASER_WIDTH, dur: beam.delay, color: beam.color }, () => {
          fx(gs, beam.x, beam.y, [add({ type: 'line', points: [[beam.x, beam.y], [beam.x2, beam.y2]], color: beam.color, dur: 0.25, width: 4 }), snd('zap', { throttle: 80 })]);
          for (const o of gs.playersNear((beam.x + beam.x2) / 2, (beam.y + beam.y2) / 2, 15)) {
            if (o.dead || segmentDist2(o.x, o.y, beam.x, beam.y, beam.x2, beam.y2) > (LASER_WIDTH + o.r) ** 2) continue;
            combat.hurtPlayer(gs, o, b.dmg * 1.2, { element: b.element, fromX: b.x, fromY: b.y });
          }
        });
      }
      fx(gs, b.x, b.y, [snd('hum')]);
      return b.phase === 2 ? 3.2 : 2.6;
    }
    case 'ring': {
      const waves = b.phase === 2 ? 3 : 2;
      for (let w = 0; w < waves; w++) {
        later(w * 0.45, () => {
          const n = b.phase === 2 ? 18 : 14;
          for (let i = 0; i < n; i++) shot(gs, b, (i / n) * Math.PI * 2 + w * 0.2, { speed, damage: dmg });
        });
      }
      return 2;
    }
    case 'spiral': {
      const shots = b.phase === 2 ? 36 : 26;
      for (let i = 0; i < shots; i++) {
        later(i * 0.07, () => {
          const a = i * 0.55;
          shot(gs, b, a, { speed: speed * 0.9, damage: dmg });
          if (b.phase === 2) shot(gs, b, a + Math.PI, { speed: speed * 0.9, damage: dmg });
        });
      }
      return shots * 0.07 + 1.2;
    }
    case 'charge': {
      const n = norm(p.x - b.x, p.y - b.y);
      const len = 9;
      warn(gs, b, { shape: 'line', x: b.x, y: b.y, x2: b.x + n.x * len, y2: b.y + n.y * len, r: b.r, dur: 0.75 }, () => {
        b.state = 'charge';
        b.stateT = 0;
        b.chargeX = n.x;
        b.chargeY = n.y;
      });
      b.state = 'windup';
      b.stateT = 0;
      return 2.2;
    }
    case 'slam': {
      const t = someone(gs, b, p);
      const tx = t.x;
      const ty = t.y;
      const r = b.phase === 2 ? 3 : 2.4;
      warn(gs, b, { x: tx, y: ty, r, dur: 0.95 }, () => {
        fx(gs, tx, ty, [add({ type: 'ring', x: tx, y: ty, r0: 0.3, r1: r, color, dur: 0.3, fill: true }), ['shake', 0.35], snd('boom')]);
        strike(gs, b, tx, ty, r, b.dmg * 1.6, b.element);
        hazard(gs, b, tx, ty, r * 0.7, 3, b.dmg * 0.5, b.element);
      });
      return 2;
    }
    case 'summon': {
      const biome = gs.data.byId.biomes.get(b.def.biome) ?? gs.world.biomeAt(Math.floor(b.x), Math.floor(b.y));
      const ids = biome.enemies.filter((id) => !gs.data.byId.enemies.get(id)?.sea);
      const count = b.phase === 2 ? 4 : 3;
      for (let i = 0; i < count && ids.length; i++) {
        const a = (i / count) * Math.PI * 2;
        const x = b.x + Math.cos(a) * 2.5;
        const y = b.y + Math.sin(a) * 2.5;
        const spot = gs.world.findFreeSpot(x, y, 0.4, 'enemy', null);
        if (!spot) continue;
        minion(gs, b, ids[i % ids.length], spot.x, spot.y, p);
        fx(gs, spot.x, spot.y, [emit('smoke', spot.x, spot.y, 6, 0.5)]);
      }
      return 2.5;
    }
    case 'blink': {
      const a = Math.random() * Math.PI * 2;
      const spot = gs.world.findFreeSpot(p.x + Math.cos(a) * 5, p.y + Math.sin(a) * 5, b.r * 0.6, 'fly', { x: b.x, y: b.y });
      fx(gs, b.x, b.y, [emit('void', b.x, b.y, 16, b.r * 2)]);
      b.x = spot.x;
      b.y = spot.y;
      fx(gs, b.x, b.y, [emit('void', b.x, b.y, 16, b.r * 2)]);
      // Mirror images vanish when the real Herald moves.
      for (const e of gs.enemies.values()) if (e.cloneOf === b.id && !e.dead) vanish(gs, e);
      later(0.4, () => pattern(gs, b, p, 'ring'));
      return 2.4;
    }

    // --- Inferno Titan: meteors rain on the arena --------------------------------
    case 'meteors': {
      const n = b.phase === 2 ? 9 : 6;
      for (let i = 0; i < n; i++) {
        later(i * 0.14, () => {
          const t = i === 0 ? p : someone(gs, b, p);
          const a = Math.random() * Math.PI * 2;
          const d = i === 0 ? 0 : 1 + Math.random() * 4;
          const tx = t.x + Math.cos(a) * d;
          const ty = t.y + Math.sin(a) * d;
          warn(gs, b, { x: tx, y: ty, r: 1.3, dur: 1.05 }, () => {
            fx(gs, tx, ty, [
              add({ type: 'pillar', x: tx, y: ty, r: 0.5, color: '#ff9a3a', dur: 0.3 }),
              add({ type: 'ring', x: tx, y: ty, r0: 0.2, r1: 1.4, color: '#ff6a2a', dur: 0.3, fill: true }),
              emit('ember', tx, ty, 12, 0.8, 3), snd('boom', { throttle: 90 }), ['shake', 0.15],
            ]);
            strike(gs, b, tx, ty, 1.3, b.dmg * 1.1, 'fire');
            hazard(gs, b, tx, ty, 0.8, 2.2, b.dmg * 0.35, 'fire');
          });
        });
      }
      return 2.6;
    }

    // --- Frost Warden: breath, a closing ring of ice, spike lines ----------------
    case 'breath': {
      const aim = Math.atan2(p.y - b.y, p.x - b.x);
      const shots = b.phase === 2 ? 30 : 22;
      b.state = 'windup';
      b.stateT = 0;
      fx(gs, b.x, b.y, [emit('frost', b.x + Math.cos(aim) * b.r, b.y + Math.sin(aim) * b.r, 14, 0.6, 1.5)]);
      for (let i = 0; i < shots; i++) {
        later(0.45 + i * 0.05, () => {
          const sweep = -0.55 + (i / (shots - 1)) * 1.1;
          shot(gs, b, aim + sweep + (Math.random() - 0.5) * 0.12, { speed: 5.5, damage: dmg * 0.55, size: 2 });
          if (i === shots - 1) b.state = 'move';
        });
      }
      return 0.45 + shots * 0.05 + 1;
    }
    case 'icering': {
      const t = someone(gs, b, p);
      const cx = t.x;
      const cy = t.y;
      const n = 22;
      const gap = Math.floor(Math.random() * n);
      const gapSize = b.phase === 2 ? 3 : 4;
      fx(gs, cx, cy, [add({ type: 'ring', x: cx, y: cy, r0: 7, r1: 6.6, color: '#bfeaff', dur: 0.6 })]);
      later(0.5, () => {
        for (let i = 0; i < n; i++) {
          if ((i - gap + n) % n < gapSize) continue;
          const a = (i / n) * Math.PI * 2;
          shot(gs, b, a + Math.PI, {
            x: cx + Math.cos(a) * 7, y: cy + Math.sin(a) * 7, speed: 3.4, damage: dmg * 0.8, range: 8, element: 'ice', color: '#bfeaff', status: 'chill',
          });
        }
      });
      return 3;
    }
    case 'spikes': {
      const dirs = b.phase === 2 ? 8 : 4;
      const base = Math.atan2(p.y - b.y, p.x - b.x);
      for (let k = 0; k < dirs; k++) {
        const a = base + (k / dirs) * Math.PI * 2;
        for (let j = 0; j < 7; j++) {
          const d = b.r + 0.8 + j * 1.35;
          const tx = b.x + Math.cos(a) * d;
          const ty = b.y + Math.sin(a) * d;
          later(j * 0.09, () => warn(gs, b, { x: tx, y: ty, r: 0.75, dur: 0.7, color: '#bfeaff' }, () => {
            fx(gs, tx, ty, [add({ type: 'spike', x: tx, y: ty, color: '#bfeaff', dur: 0.35 }), emit('frost', tx, ty, 5, 0.4, 1.5)]);
            strike(gs, b, tx, ty, 0.75, b.dmg * 0.9, 'ice', 'chill');
          }));
        }
      }
      return 2.4;
    }

    // --- Storm Colossus: lightning where you stand, dashes, static orbs ----------
    case 'strikes': {
      const n = b.phase === 2 ? 8 : 5;
      for (let i = 0; i < n; i++) {
        later(i * 0.38, () => {
          const t = someone(gs, b, p);
          if (t.dead) return;
          // Leads you a little: keep moving.
          const tx = t.x + (t.moving ? Math.cos(t.facing) * 0.6 : 0);
          const ty = t.y + (t.moving ? Math.sin(t.facing) * 0.6 : 0);
          warn(gs, b, { x: tx, y: ty, r: 1.1, dur: 0.72, color: '#ffe45c' }, () => {
            fx(gs, tx, ty, [
              add({ type: 'line', points: [[r2(tx + (Math.random() - 0.5) * 2), r2(ty - 7)], [r2(tx), r2(ty)]], color: '#fffbd0', dur: 0.22, jagged: true }),
              add({ type: 'ring', x: tx, y: ty, r0: 0.2, r1: 1.2, color: '#ffe45c', dur: 0.25, fill: true }),
              emit('spark', tx, ty, 10, 0.6, 3), snd('zap', { throttle: 60 }),
            ]);
            strike(gs, b, tx, ty, 1.1, b.dmg * 1.05, 'lightning');
          });
        });
      }
      return n * 0.38 + 1.2;
    }
    case 'dash': {
      const dashes = b.phase === 2 ? 4 : 3;
      const one = (k) => {
        if (b.dead || k >= dashes) {
          if (!b.dead) b.state = 'move';
          return;
        }
        const n = norm(p.x - b.x, p.y - b.y);
        const len = 7;
        b.state = 'windup';
        b.stateT = 0;
        warn(gs, b, { shape: 'line', x: b.x, y: b.y, x2: b.x + n.x * len, y2: b.y + n.y * len, r: b.r * 0.8, dur: 0.38, color: '#ffe45c' }, () => {
          b.state = 'charge';
          b.stateT = 0.2; // a short, fast dash
          b.chargeX = n.x;
          b.chargeY = n.y;
          b.chargeSpeed = 17;
          later(0.42, () => one(k + 1));
        });
      };
      one(0);
      return dashes * 0.8 + 1.4;
    }
    case 'orbs':
      combat.spawnArea(gs, {
        kind: 'orbit', x: b.x, y: b.y, r: 2.8, dur: 7, count: b.phase === 2 ? 4 : 3, followEnemy: b.id,
        hit: b.dmg * 0.7, element: 'lightning', color: '#ffe45c', enemy: b.id, hitCd: new Map(),
      });
      fx(gs, b.x, b.y, [snd('zap')]);
      return 2.2;
    case 'chain': {
      const aim = Math.atan2(p.y - b.y, p.x - b.x);
      const n = b.phase === 2 ? 7 : 5;
      for (let i = 0; i < n; i++) shot(gs, b, aim + (i - (n - 1) / 2) * 0.16, { speed: 11, damage: dmg * 0.7, size: 2 });
      fx(gs, b.x, b.y, [snd('zap')]);
      return 1.6;
    }

    // --- Void Herald: mirror images and a pulling singularity --------------------
    case 'clones': {
      const n = b.phase === 2 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const spot = gs.world.findFreeSpot(p.x + Math.cos(a) * 5, p.y + Math.sin(a) * 5, 0.5, 'fly', { x: b.x, y: b.y });
        const c = spawnEnemy(gs, 'wisp', spot.x, spot.y, { level: b.level });
        if (!c) continue;
        Object.assign(c, {
          r: b.r * 0.9, hp: Math.round(b.maxHp * 0.05), maxHp: Math.round(b.maxHp * 0.05), dmg: b.dmg * 0.6,
          minion: true, xp: 0, cloneOf: b.id, cloneDefIdx: b.defIdx, expireAt: gs.time + 10, color: b.color, target: p.id, alertUntil: gs.time + 30,
        });
        fx(gs, spot.x, spot.y, [emit('void', spot.x, spot.y, 16, 1)]);
      }
      // The real Herald slips to a new spot too, so you have to look.
      later(0.2, () => {
        const a = Math.random() * Math.PI * 2;
        fx(gs, b.x, b.y, [emit('void', b.x, b.y, 12, b.r * 2)]);
        const spot = gs.world.findFreeSpot(p.x + Math.cos(a) * 5, p.y + Math.sin(a) * 5, 0.5, 'fly', { x: b.x, y: b.y });
        b.x = spot.x;
        b.y = spot.y;
      });
      return 3.2;
    }
    case 'gravity':
      combat.spawnArea(gs, {
        kind: 'gravity', x: (b.x + p.x) / 2, y: (b.y + p.y) / 2, r: 3.4, dur: 3.6, pull: b.phase === 2 ? 3.2 : 2.5,
        damage: b.dmg * 0.9, element: 'void', color: '#9a5cff', enemy: b.id,
      });
      fx(gs, b.x, b.y, [snd('whirl')]);
      return 3;

    // --- Bone King: the dead rise around you, fans of bone, delayed curses -------
    case 'raise': {
      const n = b.phase === 2 ? 4 : 3;
      for (let i = 0; i < n; i++) {
        const t = someone(gs, b, p);
        const a = (i / n) * Math.PI * 2 + Math.random();
        const spot = gs.world.findFreeSpot(t.x + Math.cos(a) * 3.2, t.y + Math.sin(a) * 3.2, 0.4, 'enemy', null);
        if (!spot) continue;
        warn(gs, b, { x: spot.x, y: spot.y, r: 0.6, dur: 0.9, color: '#e8e4d4' }, () => {
          minion(gs, b, 'skeleton', spot.x, spot.y, t);
          fx(gs, spot.x, spot.y, [emit('dust', spot.x, spot.y, 10, 0.5, 2)]);
        });
      }
      return 2.6;
    }
    case 'bonefan': {
      const volleys = b.phase === 2 ? 3 : 2;
      for (let v = 0; v < volleys; v++) {
        later(v * 0.5, () => {
          const aim = Math.atan2(p.y - b.y, p.x - b.x) + (v % 2 ? 0.085 : 0);
          for (let i = 0; i < 7; i++) shot(gs, b, aim + (i - 3) * 0.17, { speed: 7.5, damage: dmg * 0.8, size: 2, sprite: 'bone' });
        });
      }
      return volleys * 0.5 + 1.2;
    }
    case 'curse': {
      const n = b.phase === 2 ? 5 : 3;
      for (let i = 0; i < n; i++) {
        later(i * 0.3, () => {
          const t = someone(gs, b, p);
          if (t.dead) return;
          const tx = t.x;
          const ty = t.y;
          warn(gs, b, { x: tx, y: ty, r: 1.5, dur: 1.1, color: '#d0263a' }, () => {
            fx(gs, tx, ty, [add({ type: 'ring', x: tx, y: ty, r0: 0.3, r1: 1.6, color: '#d0263a', dur: 0.3, fill: true }), emit('hit', tx, ty, 8, 0.6, 2)]);
            strike(gs, b, tx, ty, 1.5, b.dmg * 1.1, 'physical', 'bleed');
          });
        });
      }
      return n * 0.3 + 1.6;
    }

    // --- Thornmother: roots race towards you, spore clouds, she re-roots ---------
    case 'roots': {
      const lines = b.phase === 2 ? 5 : 3;
      const aim = Math.atan2(p.y - b.y, p.x - b.x);
      for (let k = 0; k < lines; k++) {
        const a = aim + (k - (lines - 1) / 2) * 0.32;
        for (let j = 0; j < 9; j++) {
          const d = b.r + 0.6 + j * 1.2;
          const tx = b.x + Math.cos(a) * d;
          const ty = b.y + Math.sin(a) * d;
          later(j * 0.11, () => warn(gs, b, { x: tx, y: ty, r: 0.7, dur: 0.55, color: '#6ac04a' }, () => {
            fx(gs, tx, ty, [add({ type: 'spike', x: tx, y: ty, color: '#7a5232', dur: 0.4 }), emit('leaf', tx, ty, 3, 0.4, 1.5)]);
            strike(gs, b, tx, ty, 0.7, b.dmg * 0.9, 'poison', 'poison');
          }));
        }
      }
      return 2.6;
    }
    case 'spores': {
      const n = b.phase === 2 ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const t = i === 0 ? p : someone(gs, b, p);
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
        const d = i === 0 ? 0 : 1.6 + Math.random() * 2.4;
        const tx = t.x + Math.cos(a) * d;
        const ty = t.y + Math.sin(a) * d;
        warn(gs, b, { x: tx, y: ty, r: 1.3, dur: 0.8, color: '#9ae05a' }, () => hazard(gs, b, tx, ty, 1.3, 4.5, b.dmg * 0.45, 'poison'));
      }
      return 2.4;
    }
    case 'reroot': {
      // She sinks into the ground and bursts up somewhere else, roots first.
      const a = Math.random() * Math.PI * 2;
      const spot = gs.world.findFreeSpot(p.x + Math.cos(a) * 6, p.y + Math.sin(a) * 6, b.r * 0.6, 'fly', { x: b.x, y: b.y });
      fx(gs, b.x, b.y, [emit('leaf', b.x, b.y, 18, b.r * 1.5, 2)]);
      b.submerged = true;
      b.state = 'windup';
      b.stateT = 0;
      warn(gs, b, { x: spot.x, y: spot.y, r: b.r + 0.6, dur: 1, color: '#6ac04a' }, () => {
        b.x = spot.x;
        b.y = spot.y;
        b.submerged = false;
        b.state = 'move';
        fx(gs, b.x, b.y, [['shake', 0.3], emit('leaf', b.x, b.y, 20, b.r * 1.5, 3)]);
        strike(gs, b, b.x, b.y, b.r + 0.6, b.dmg * 1.3, 'poison');
      });
      return 2.2;
    }

    // --- Sand Wyrm: dives under the sand, quakes, spits sand ---------------------
    case 'burrow': {
      b.submerged = true;
      b.state = 'windup';
      b.stateT = 0;
      fx(gs, b.x, b.y, [emit('dust', b.x, b.y, 20, b.r * 1.5, 3), snd('boom')]);
      const erupt = (k) => {
        const t = someone(gs, b, p);
        const tx = t.x;
        const ty = t.y;
        warn(gs, b, { x: tx, y: ty, r: 2, dur: 1.05, color: '#d8a858' }, () => {
          b.x = tx;
          b.y = ty;
          fx(gs, tx, ty, [['shake', 0.45], add({ type: 'ring', x: tx, y: ty, r0: 0.4, r1: 2.4, color: '#d8a858', dur: 0.35, fill: true }), emit('dust', tx, ty, 26, 1.6, 4)]);
          strike(gs, b, tx, ty, 2, b.dmg * 1.6, 'earth');
          // Debris flies out in a ring.
          for (let i = 0; i < 10; i++) shot(gs, b, (i / 10) * Math.PI * 2, { speed: 5, damage: dmg * 0.6, size: 2 });
          if (b.phase === 2 && k === 0) {
            later(0.6, () => erupt(1));
          } else {
            b.submerged = false;
            b.state = 'move';
          }
        });
      };
      later(0.9, () => erupt(0));
      return b.phase === 2 ? 4.4 : 3.2;
    }
    case 'quake': {
      const waves = b.phase === 2 ? 4 : 3;
      for (let w = 0; w < waves; w++) {
        later(w * 0.7, () => {
          const cx = b.x;
          const cy = b.y;
          fx(gs, cx, cy, [['shake', 0.2], add({ type: 'ring', x: cx, y: cy, r0: b.r, r1: 9, color: '#d8a858', dur: 1.1 }), snd('boom', { throttle: 200 })]);
          // The ripple hits whatever it passes (once): step over the gap between rings.
          const hit = new Set();
          for (let k = 1; k <= 10; k++) {
            later(k * 0.11, () => {
              const rad = b.r + (9 - b.r) * (k / 10);
              for (const o of gs.playersNear(cx, cy, rad + 1)) {
                if (o.dead || hit.has(o.id)) continue;
                const d = Math.sqrt((o.x - cx) ** 2 + (o.y - cy) ** 2);
                if (Math.abs(d - rad) < 0.55) {
                  hit.add(o.id);
                  combat.hurtPlayer(gs, o, b.dmg * 0.9, { element: 'earth', fromX: cx, fromY: cy });
                }
              }
            });
          }
        });
      }
      return waves * 0.7 + 1.4;
    }
    case 'sandspit': {
      const shots = b.phase === 2 ? 5 : 3;
      for (let i = 0; i < shots; i++) {
        later(i * 0.35, () => {
          const t = someone(gs, b, p);
          if (t.dead) return;
          const tx = t.x + (t.moving ? Math.cos(t.facing) * 1.5 : 0);
          const ty = t.y + (t.moving ? Math.sin(t.facing) * 1.5 : 0);
          warn(gs, b, { x: tx, y: ty, r: 1.4, dur: 0.9, color: '#e8c890' }, () => {
            fx(gs, tx, ty, [emit('dust', tx, ty, 14, 1, 3)]);
            strike(gs, b, tx, ty, 1.4, b.dmg, 'earth');
            hazard(gs, b, tx, ty, 1.1, 2.5, b.dmg * 0.3, 'earth');
          });
        });
      }
      return shots * 0.35 + 1.4;
    }

    // --- Tide Leviathan: walls of water, geysers, whirlpools ----------------------
    case 'wave': {
      const waves = b.phase === 2 ? 3 : 2;
      for (let w = 0; w < waves; w++) {
        later(w * 1.1, () => {
          const t = someone(gs, b, p);
          if (t.dead) return;
          // A wall of water rolls in from one side, with a gap to slip through.
          const from = Math.random() * Math.PI * 2;
          const dirX = -Math.cos(from);
          const dirY = -Math.sin(from);
          const ox = t.x + Math.cos(from) * 8;
          const oy = t.y + Math.sin(from) * 8;
          const gap = Math.floor(Math.random() * 9) - 4;
          for (let k = -7; k <= 7; k++) {
            if (Math.abs(k - gap) <= 1) continue;
            shot(gs, b, Math.atan2(dirY, dirX), {
              x: ox - dirY * k * 0.9, y: oy + dirX * k * 0.9, speed: 4.2, damage: dmg * 0.8, range: 17, element: 'ice', color: '#9ad8f4', status: 'chill',
            });
          }
          fx(gs, ox, oy, [emit('splash', ox, oy, 12, 3, 2)]);
        });
      }
      return waves * 1.1 + 2;
    }
    case 'geysers': {
      const n = b.phase === 2 ? 7 : 5;
      const t = someone(gs, b, p);
      const cx = t.x;
      const cy = t.y;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
        const d = i === 0 ? 0 : 2.2;
        const tx = cx + Math.cos(a) * d;
        const ty = cy + Math.sin(a) * d;
        later(i * 0.12, () => warn(gs, b, { x: tx, y: ty, r: 1, dur: 0.9, color: '#7ad8ff' }, () => {
          fx(gs, tx, ty, [add({ type: 'pillar', x: tx, y: ty, r: 0.8, color: '#bfe8ff', dur: 0.4 }), emit('splash', tx, ty, 14, 0.5, 4)]);
          strike(gs, b, tx, ty, 1, b.dmg * 1.05, 'ice', 'chill');
        }));
      }
      return 2.6;
    }
    case 'whirlpool': {
      const t = someone(gs, b, p);
      combat.spawnArea(gs, {
        kind: 'gravity', x: t.x + (Math.random() - 0.5) * 2, y: t.y + (Math.random() - 0.5) * 2, r: 3.2, dur: 3.4,
        pull: b.phase === 2 ? 3 : 2.3, damage: b.dmg * 0.8, element: 'ice', color: '#3a9ad8', enemy: b.id,
      });
      fx(gs, b.x, b.y, [snd('whirl')]);
      return 3;
    }
    default:
      return 1.5;
  }
}

function minion(gs, b, kind, x, y, target) {
  const m = spawnEnemy(gs, kind, x, y, { level: Math.max(1, b.level - 2) });
  if (!m) return null;
  m.minion = true; // no loot: the boss is the prize
  m.target = target?.id ?? 0;
  m.alertUntil = gs.time + 30;
  return m;
}

// --- The boss's own movement --------------------------------------------------------------

function pickTarget(gs, b) {
  let t = b.target ? gs.players.get(b.target) : null;
  if (!t || t.dead || (t.x - b.x) ** 2 + (t.y - b.y) ** 2 > 30 * 30 || Math.random() < 0.004) {
    t = gs.nearestPlayer(b.x, b.y, 30);
  }
  b.target = t?.id ?? 0;
  return t;
}

export function updateBoss(gs, b, dt) {
  const p = pickTarget(gs, b);
  if (b.phase === 1 && b.hp < b.maxHp * 0.5) {
    b.phase = 2;
    gs.event(b.x, b.y, { k: 'boss', id: b.id, name: b.def.name, active: true, enraged: true }, 60);
  }
  b.stateT += dt;
  if (!p) {
    b.vx = b.vy = 0;
    return;
  }
  const d = Math.sqrt((p.x - b.x) ** 2 + (p.y - b.y) ** 2) || 1;
  if (b.state === 'charge') {
    const cs = b.chargeSpeed ?? 13;
    b.vx = b.chargeX * cs;
    b.vy = b.chargeY * cs;
    // The Titan's charge leaves burning ground; the Colossus leaves sparks.
    const trail = b.def.trail;
    if (trail && (b.trailT = (b.trailT ?? 0) - dt) <= 0) {
      b.trailT = 0.09;
      hazard(gs, b, b.x, b.y, 0.8, trail === 'fire' ? 3 : 1.2, b.dmg * 0.4, trail);
    }
    if (b.stateT > 0.55) {
      b.state = 'move';
      b.vx = b.vy = 0;
      b.chargeSpeed = null;
    }
  } else if (b.state === 'windup') {
    b.vx = b.vy = 0;
  } else {
    // Close in (not too close), and never too far from its altar.
    const far = (b.x - b.anchorX) ** 2 + (b.y - b.anchorY) ** 2 > 18 * 18;
    const speed = b.speed * (b.slowMult ?? 1) * (b.phase === 2 ? 1.25 : 1);
    if (far) {
      const n = norm(b.anchorX - b.x, b.anchorY - b.y);
      b.vx = n.x * speed;
      b.vy = n.y * speed;
    } else {
      const want = d > 3.5 ? 1 : 0;
      b.vx = ((p.x - b.x) / d) * speed * want;
      b.vy = ((p.y - b.y) / d) * speed * want;
    }
    b.patternCd -= dt * (b.phase === 2 ? 1.35 : 1);
    if (b.patternCd <= 0) {
      const list = b.def.patterns;
      const name = list[b.patternIdx % list.length];
      b.patternIdx += Math.random() < 0.3 ? 2 : 1;
      b.anim = (b.anim + 1) & 255;
      b.castT = gs.time;
      b.patternCd = pattern(gs, b, p, name);
    }
  }
  if (Math.abs(b.vx) > 0.05) b.facing = b.vx > 0 ? 1 : -1;
  // The Frost Warden's aura chills anyone who stays close.
  if (b.def.aura === 'chill' && (b.auraCd ?? 0) <= gs.time) {
    b.auraCd = gs.time + 1;
    for (const o of playersIn(gs, b.x, b.y, 4.5)) applyPlayerStatus(gs, o, 'chill');
  }
  if (b.submerged) return;
  for (const o of gs.playersNear(b.x, b.y, b.r + 1)) {
    if (o.dead || (o.bossHitAt ?? 0) > gs.time) continue;
    if ((o.x - b.x) ** 2 + (o.y - b.y) ** 2 < (b.r + o.r) ** 2) {
      o.bossHitAt = gs.time + 0.8;
      combat.hurtPlayer(gs, o, b.dmg * (b.state === 'charge' ? 1.6 : 1), { element: b.element, fromX: b.x, fromY: b.y, knock: 8 });
    }
  }
}

// --- Lingering boss areas: static orbs, singularities and whirlpools ------------------------

/** One tick of an 'orbit' or 'gravity' area (called by combat.updateAreas). */
export function updateArea(gs, a, dt) {
  if (a.kind === 'orbit') {
    const owner = gs.enemies.get(a.followEnemy);
    if (!owner || owner.dead) {
      a.t = a.dur;
      return;
    }
    a.x = owner.x;
    a.y = owner.y;
    const n = a.count ?? 3;
    for (let k = 0; k < n; k++) {
      const ang = a.t * 2.2 + (k / n) * Math.PI * 2;
      const bx = a.x + Math.cos(ang) * a.r;
      const by = a.y + Math.sin(ang) * a.r;
      for (const p of gs.playersNear(bx, by, 1.5)) {
        if (p.dead || (a.hitCd.get(p.id) ?? 0) > gs.time) continue;
        if ((bx - p.x) ** 2 + (by - p.y) ** 2 <= (0.45 + p.r) ** 2) {
          a.hitCd.set(p.id, gs.time + 0.6);
          combat.hurtPlayer(gs, p, a.hit, { element: a.element, fromX: bx, fromY: by });
        }
      }
    }
    return;
  }
  if (a.kind === 'gravity') {
    // A singularity drags you towards its heart, which burns. The pull is
    // knockback, so your own screen predicts it like any other shove.
    a.tickT = (a.tickT ?? 0) - dt;
    const tick = a.tickT <= 0;
    if (tick) a.tickT = 0.3;
    const reach = a.r * 1.6;
    for (const p of gs.playersNear(a.x, a.y, reach)) {
      if (p.dead) continue;
      const dx = a.x - p.x;
      const dy = a.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= reach * reach || d2 < 0.01) continue;
      const d = Math.sqrt(d2);
      const k = a.pull * 0.2835; // a steady pull of `pull` tiles/s on top of the knockback's decay
      p.kx += (dx / d) * k;
      p.ky += (dy / d) * k;
      if (tick && d2 <= 1.1 * 1.1) combat.hurtPlayer(gs, p, a.damage * 0.3, { element: a.element, dot: true });
    }
  }
}

/** Mirror images fade after a while. */
export function expireClones(gs) {
  for (const e of gs.enemies.values()) {
    if (e.cloneOf && (e.expireAt <= gs.time || !gs.enemies.has(e.cloneOf))) vanish(gs, e);
  }
}
export const _test = { pattern };
