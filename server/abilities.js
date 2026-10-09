// Weapon abilities and legendary signature powers in multiplayer: the same
// powers as single player (src/game/abilities.js), with the same numbers,
// run by the server. They hit monsters, never other players (a legendary
// power would decide a PvP fight on its own). Everyone nearby sees them:
// the server sends what to draw as effect events ('ab') and lingering
// areas, and clones as their own entities.
//
// Cooldowns run on real time and are kept with the character, so logging
// out or switching weapons never resets them.

import { heldWeapon, recomputeStats, markMe } from './players.js';
import { damageEnemy, heal, spawnProjectile, spawnArea } from './combat.js';
import { applyStatus } from './enemies.js';

const FX_RADIUS = 34;
const AREA_TICK = 0.3;

const r2 = (v) => Math.round(v * 100) / 100;

function glow(gs, element, fallback) {
  return gs.data.byId.elements.get(element)?.glow ?? fallback;
}

function particlesOf(gs, element, fallback) {
  return gs.data.byId.elements.get(element)?.particles ?? fallback;
}

/** Damage of the weapon that cast the power (its owner's attack power counts). */
function weaponDamage(c) {
  return c.w.stats.damage * (1 + c.p.stats.attackPower / 100);
}

// --- Queries ---------------------------------------------------------------------------

export function enemiesInRadius(gs, x, y, r) {
  const out = [];
  for (const e of gs.enemiesNear(x, y, r + 3)) {
    if (e.dead || e.submerged) continue;
    const rr = r + e.r;
    if ((e.x - x) ** 2 + (e.y - y) ** 2 <= rr * rr) out.push(e);
  }
  return out;
}

export function nearestEnemy(gs, x, y, maxDist, exclude = null) {
  let best = null;
  let bestD = maxDist * maxDist;
  for (const e of gs.enemiesNear(x, y, maxDist)) {
    if (e.dead || e.submerged || exclude?.has(e)) continue;
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

// --- What everyone sees ------------------------------------------------------------------

/**
 * Effects for the clients around (x, y): a list of [op, ...args] that the
 * client plays (src/mp/mp-game.js #abilityFx). Shakes, flashes and
 * vibration only reach the caster.
 */
function show(c, x, y, ops) {
  c.gs.event(x, y, { k: 'fx', fx: 'ab', by: c.p.id, x: r2(x), y: r2(y), ops }, FX_RADIUS);
}

const add = (shape) => {
  const s = {};
  for (const [k, v] of Object.entries(shape)) s[k] = typeof v === 'number' ? r2(v) : v;
  return ['add', s];
};
const emit = (kind, x, y, n, spread = 0.3, speed = 1.5) => ['emit', kind, r2(x), r2(y), n, r2(spread), r2(speed)];
const snd = (name, opts) => (opts ? ['snd', name, opts] : ['snd', name]);

// --- Damage --------------------------------------------------------------------------------

function infuse(c, targets, sourceDamage) {
  const st = c.ab.infuse ? c.gs.data.byId.elements.get(c.ab.infuse)?.status : null;
  if (!st) return;
  for (const e of targets) if (!e.dead && Math.random() < 0.6) applyStatus(c.gs, e, st, sourceDamage, c.p);
}

function deal(c, targets, amount, extra = {}) {
  let total = 0;
  for (const e of targets) {
    total += damageEnemy(c.gs, e, amount, {
      attacker: c.p, element: c.ab.infuse ?? 'physical', depth: 1, source: 'ability', canCrit: false, ...extra,
    });
  }
  infuse(c, targets, amount);
  if (c.ab.twist === 'vampiric' && total > 0) heal(c.gs, c.p, total * 0.2);
  return total;
}

function aimPoint(c, angle, dist) {
  const { gs, p, ab } = c;
  if (ab.twist === 'seeking') {
    const t = nearestEnemy(gs, p.x, p.y, 10);
    if (t) return { x: t.x, y: t.y };
  }
  const t = nearestEnemy(gs, p.x + Math.cos(angle) * dist, p.y + Math.sin(angle) * dist, dist);
  if (t) return { x: t.x, y: t.y };
  return { x: p.x + Math.cos(angle) * dist, y: p.y + Math.sin(angle) * dist };
}

function area(c, kind, o) {
  return spawnArea(c.gs, { kind, ability: true, owner: c.p.id, caster: c.p, element: 'physical', ...o });
}

// --- The powers -----------------------------------------------------------------------------

const ACTIONS = {
  meteor(c, angle) {
    const { gs, ab } = c;
    const { x, y } = aimPoint(c, angle, 5);
    const color = glow(gs, ab.infuse, '#ff8a2a');
    const dur = ab.duration || 0.6;
    show(c, x, y, [add({ type: 'marker', x, y, r: ab.radius, color, dur }), add({ type: 'meteor', x, y, color, dur })]);
    gs.schedule(dur, () => {
      deal(c, enemiesInRadius(gs, x, y, ab.radius), (weaponDamage(c) * ab.damage) / 100, { knockback: 3, fromX: x, fromY: y });
      show(c, x, y, [
        add({ type: 'ring', x, y, r0: 0.3, r1: ab.radius, color, dur: 0.35, fill: true }),
        emit(particlesOf(gs, ab.infuse, 'ember'), x, y, 24, ab.radius, 4),
        ['shake', 0.4], snd('boom'),
      ]);
    });
  },

  blink(c, angle) {
    const { gs, p, ab } = c;
    let tx = p.x;
    let ty = p.y;
    const target = ab.twist === 'seeking' ? nearestEnemy(gs, p.x, p.y, ab.range + 2) : null;
    let dx = Math.cos(angle);
    let dy = Math.sin(angle);
    if (target) {
      const d = Math.hypot(target.x - p.x, target.y - p.y) || 1;
      dx = (target.x - p.x) / d;
      dy = (target.y - p.y) / d;
    }
    // Your clan's gates let you through, as when you walk.
    gs.world.gateFilter = (st) => Boolean(st.clanId) && st.clanId === p.clanId;
    try {
      for (let s = 0.25; s <= ab.range; s += 0.25) {
        const nx = p.x + dx * s;
        const ny = p.y + dy * s;
        if (!gs.world.isFree(nx, ny, p.r)) break;
        tx = nx;
        ty = ny;
      }
    } finally {
      gs.world.gateFilter = null;
    }
    show(c, p.x, p.y, [add({ type: 'line', points: [[r2(p.x), r2(p.y)], [r2(tx), r2(ty)]], color: '#cdb2ff', dur: 0.2 }), emit('arcane', p.x, p.y, 10, 0.5)]);
    p.x = tx;
    p.y = ty;
    p.blinkTick = gs.tick;
    p.invulnUntil = Math.max(p.invulnUntil ?? 0, Date.now() + 350);
    deal(c, enemiesInRadius(gs, tx, ty, ab.radius), (weaponDamage(c) * ab.damage) / 100);
    show(c, tx, ty, [add({ type: 'ring', x: tx, y: ty, r0: 0.2, r1: ab.radius, color: '#cdb2ff', dur: 0.2 }), snd('zap')]);
  },

  blackhole(c, angle) {
    const { gs, ab } = c;
    const { x, y } = aimPoint(c, angle, 4);
    const element = ab.infuse ?? 'void';
    area(c, 'portal', {
      x, y, r: ab.radius * 0.6, dur: ab.duration, pull: 7, big: true, dps: (weaponDamage(c) * ab.damage) / 100, element, color: glow(gs, element, '#9a5cff'),
    });
    show(c, x, y, [snd('hum')]);
  },

  clone(c) {
    const { gs, p, ab } = c;
    const a = {
      id: gs.newId(), kind: 'clone', owner: p.id, x: p.x + 0.8, y: p.y, r: p.r, until: gs.time + ab.duration, atkCd: 0.3,
      damagePct: ab.damage, facing: 0, vampiric: ab.twist === 'vampiric', anim: 0, w: c.w,
    };
    gs.allies.set(a.id, a);
    show(c, p.x, p.y, [emit('arcane', p.x, p.y, 16, 0.8), snd('zap')]);
  },

  quake(c) {
    const { p, ab } = c;
    area(c, 'quake', {
      x: p.x, y: p.y, r: ab.radius, dur: ab.duration || 0.8, element: ab.infuse ?? 'earth',
      hit: (weaponDamage(c) * ab.damage) / 100, vampiric: ab.twist === 'vampiric', color: '#d9a45c', hitSet: new Set(),
    });
    show(c, p.x, p.y, [['shake', 0.45], snd('boom')]);
  },

  phoenix(c) {
    const { gs, p, ab } = c;
    deal(c, enemiesInRadius(gs, p.x, p.y, ab.radius), (weaponDamage(c) * ab.damage) / 100, { status: 'burn', knockback: 2, fromX: p.x, fromY: p.y });
    heal(gs, p, p.maxHp * 0.25);
    show(c, p.x, p.y, [
      add({ type: 'ring', x: p.x, y: p.y, r0: 0.5, r1: ab.radius, color: '#ff8a2a', dur: 0.4, fill: true }),
      emit('ember', p.x, p.y, 30, ab.radius, 5), snd('boom'),
    ]);
  },

  storm(c) {
    const { gs, p, ab } = c;
    const targets = enemiesInRadius(gs, p.x, p.y, ab.radius).sort(() => Math.random() - 0.5).slice(0, ab.count);
    const dmg = (weaponDamage(c) * ab.damage) / 100;
    targets.forEach((e, i) => {
      gs.schedule(i * 0.12, () => {
        if (e.dead) return;
        show(c, e.x, e.y, [add({ type: 'bolt', x: e.x, y: e.y, r: 0.8, color: '#fff27a', dur: 0.25 }), snd('zap', { throttle: 40 })]);
        deal(c, [e], dmg, { status: 'shock' });
      });
    });
  },

  frostnova(c) {
    const { gs, p, ab } = c;
    const targets = enemiesInRadius(gs, p.x, p.y, ab.radius);
    const dmg = (weaponDamage(c) * ab.damage) / 100;
    deal(c, targets, dmg);
    for (const e of targets) {
      if (e.dead) continue;
      applyStatus(gs, e, 'freeze', dmg, p);
      if (e.statuses.freeze) e.statuses.freeze.until = gs.time + ab.duration;
    }
    show(c, p.x, p.y, [
      add({ type: 'ring', x: p.x, y: p.y, r0: 0.5, r1: ab.radius, color: '#a9e6ff', dur: 0.4, fill: true }),
      emit('frost', p.x, p.y, 30, ab.radius, 4), snd('zap'),
    ]);
  },

  bladering(c) {
    const { p, ab } = c;
    area(c, 'bladering', {
      x: p.x, y: p.y, r: ab.radius, dur: ab.duration, count: ab.count, follow: true,
      hit: (weaponDamage(c) * ab.damage) / 100, element: ab.infuse ?? 'physical', vampiric: ab.twist === 'vampiric',
      color: c.w.trail, cooldowns: new Map(),
    });
    show(c, p.x, p.y, [snd('whirl')]);
  },

  timewarp(c) {
    const { p, ab } = c;
    area(c, 'timewarp', { x: p.x, y: p.y, r: ab.radius, dur: ab.duration, slow: ab.slow, color: '#ff8cf5' });
    show(c, p.x, p.y, [snd('hum')]);
  },

  // --- Legendary signature powers ------------------------------------------------

  starfall(c) {
    const { gs, p, ab } = c;
    const color = ab.color;
    for (let i = 0; i < ab.count; i++) {
      gs.schedule((i / ab.count) * ab.duration, () => {
        const foes = enemiesInRadius(gs, p.x, p.y, ab.radius);
        const e = foes.length ? foes[i % foes.length] : null;
        const a = Math.random() * Math.PI * 2;
        const x = e ? e.x : p.x + Math.cos(a) * ab.radius * Math.random();
        const y = e ? e.y : p.y + Math.sin(a) * ab.radius * Math.random();
        show(c, x, y, [add({ type: 'meteor', x, y, color, dur: 0.3 })]);
        gs.schedule(0.3, () => {
          deal(c, enemiesInRadius(gs, x, y, 1.5), (weaponDamage(c) * ab.damage) / 100, { knockback: 1, fromX: x, fromY: y });
          show(c, x, y, [
            add({ type: 'ring', x, y, r0: 0.2, r1: 1.6, color, dur: 0.3, fill: true }),
            emit('holy', x, y, 12, 0.8, 3), ['shake', 0.12], snd('boom', { throttle: 90 }),
          ]);
        });
      });
    }
  },

  breath(c) {
    const { gs, p, ab } = c;
    const ticks = Math.round(ab.duration / 0.12);
    const half = 0.5;
    for (let i = 0; i < ticks; i++) {
      gs.schedule(i * 0.12, () => {
        if (p.dead || !gs.players.has(p.id)) return;
        const t = c.targetId ? gs.enemies.get(c.targetId) : null;
        const a = t && !t.dead ? Math.atan2(t.y - p.y, t.x - p.x) : p.facing;
        const dmg = (weaponDamage(c) * ab.damage) / 100;
        const hit = enemiesInRadius(gs, p.x, p.y, ab.radius).filter((e) => Math.cos(Math.atan2(e.y - p.y, e.x - p.x) - a) > Math.cos(half));
        deal(c, hit, dmg, { status: 'burn' });
        const ops = [['cone', r2(p.x), r2(p.y), r2(a), r2(ab.radius), half], snd('whirl', { throttle: 300 })];
        if (i % 4 === 0) {
          const d = ab.radius * 0.7;
          area(c, 'cloud', {
            x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d, r: 1.1, dur: 2.5, lava: true, dps: dmg, element: 'fire', color: '#ff5a1a',
          });
        }
        show(c, p.x, p.y, ops);
      });
    }
  },

  zero(c) {
    const { gs, ab } = c;
    area(c, 'field', {
      x: c.p.x, y: c.p.y, r: ab.radius, dur: ab.duration, follow: true, slow: 60, color: ab.color, spin: 5,
      onEnd: (ar) => {
        const dmg = (weaponDamage(c) * ab.damage) / 100;
        const targets = enemiesInRadius(gs, ar.x, ar.y, ar.r);
        for (const e of targets) {
          applyStatus(gs, e, 'freeze', dmg, c.p);
          if (e.statuses.freeze) e.statuses.freeze.until = gs.time + 1.2;
        }
        deal(c, targets, dmg);
        show(c, ar.x, ar.y, [
          add({ type: 'ring', x: ar.x, y: ar.y, r0: 0.5, r1: ar.r, color: '#dff6ff', dur: 0.45, fill: true }),
          emit('frost', ar.x, ar.y, 50, ar.r, 5), ['flash', '#dff6ff', 0.2], ['shake', 0.4], snd('zap'),
        ]);
      },
    });
    show(c, c.p.x, c.p.y, [snd('whirl')]);
  },

  wrath(c) {
    const { gs, p, ab } = c;
    for (let wave = 0; wave < 3; wave++) {
      gs.schedule(wave * 0.55, () => {
        if (p.dead) return;
        const dmg = (weaponDamage(c) * ab.damage) / 100;
        let from = { x: p.x, y: p.y };
        const hit = new Set();
        const ops = [add({ type: 'bolt', x: p.x, y: p.y, r: 0.8, color: ab.color, dur: 0.25 })];
        for (let j = 0; j < ab.count; j++) {
          const e = nearestEnemy(gs, from.x, from.y, j === 0 ? ab.radius : 4.5, hit);
          if (!e) break;
          hit.add(e);
          const start = from;
          gs.schedule(j * 0.05, () => {
            show(c, e.x, e.y, [add({ type: 'line', points: [[r2(start.x), r2(start.y)], [r2(e.x), r2(e.y)]], color: ab.color, dur: 0.22, jagged: true })]);
            if (!e.dead) deal(c, [e], dmg, { status: 'shock' });
          });
          from = { x: e.x, y: e.y };
        }
        if (hit.size) ops.push(snd('zap', { throttle: 50 }));
        show(c, p.x, p.y, ops);
      });
    }
  },

  horizon(c, angle) {
    const { gs, ab } = c;
    const { x, y } = aimPoint(c, angle, 4.5);
    area(c, 'portal', {
      x, y, r: ab.radius * 0.7, dur: ab.duration, pull: 10, big: true,
      dps: (weaponDamage(c) * ab.damage) / 1000, element: ab.infuse ?? 'void', color: ab.color,
    });
    show(c, x, y, [snd('hum')]);
    gs.schedule(ab.duration, () => {
      deal(c, enemiesInRadius(gs, x, y, ab.radius * 1.3), (weaponDamage(c) * ab.damage) / 100, { knockback: 3, fromX: x, fromY: y });
      show(c, x, y, [
        add({ type: 'ring', x, y, r0: ab.radius * 1.3, r1: 0.2, color: ab.color, dur: 0.25 }),
        emit('void', x, y, 50, ab.radius, 6), ['flash', '#9a5cff', 0.25], ['shake', 0.6], snd('boom'),
      ]);
      gs.schedule(0.2, () => show(c, x, y, [add({ type: 'ring', x, y, r0: 0.3, r1: ab.radius * 1.5, color: '#e8d8ff', dur: 0.4, fill: true })]));
    });
  },

  blades(c) {
    const { gs, p, ab } = c;
    const dmg = (weaponDamage(c) * ab.damage) / 100;
    const color = c.w.trail ?? ab.color;
    area(c, 'bladering', {
      x: p.x, y: p.y, r: 1.4, dur: 0.25 + ab.count * 0.09, count: Math.min(8, ab.count), hit: dmg * 0.3, follow: true,
      element: ab.infuse ?? 'physical', color, cooldowns: new Map(),
    });
    for (let i = 0; i < ab.count; i++) {
      gs.schedule(0.25 + i * 0.09, () => {
        if (p.dead || !gs.players.has(p.id)) return;
        // Blades spread over the enemies around you, nearest first.
        const foes = enemiesInRadius(gs, p.x, p.y, ab.radius)
          .sort((m, n) => (m.x - p.x) ** 2 + (m.y - p.y) ** 2 - ((n.x - p.x) ** 2 + (n.y - p.y) ** 2));
        const t = foes.length ? foes[i % foes.length] : null;
        const a = t ? Math.atan2(t.y - p.y, t.x - p.x) + (Math.random() - 0.5) * 0.3 : (i / ab.count) * Math.PI * 2;
        spawnProjectile(gs, {
          x: p.x + Math.cos(a) * 1.2, y: p.y + Math.sin(a) * 1.2, angle: a, speed: 13, damage: dmg, range: ab.radius + 2,
          size: 3, sprite: 'blade', owner: p.id, element: ab.infuse ?? 'physical', color, homing: 1, pierce: 1, source: 'ability',
        });
        show(c, p.x, p.y, [snd('swish', { throttle: 60 })]);
      });
    }
  },

  bloom(c, angle) {
    const { gs, ab } = c;
    const { x, y } = aimPoint(c, angle, 2.5);
    area(c, 'field', {
      x, y, r: ab.radius, dur: ab.duration, color: ab.color, spin: 1.5, flower: true, pulse: ab.duration / ab.count,
      onPulse: (ar) => {
        deal(c, enemiesInRadius(gs, ar.x, ar.y, ar.r), (weaponDamage(c) * ab.damage) / 100, { status: 'poison' });
        show(c, ar.x, ar.y, [add({ type: 'ring', x: ar.x, y: ar.y, r0: 0.4, r1: ar.r, color: ab.color, dur: 0.4 }), snd('whirl', { throttle: 200 })]);
      },
    });
    show(c, x, y, [emit('leaf', x, y, 24, 1.2, 3), ['shake', 0.25]]);
  },

  ascend(c) {
    const { gs, p, ab } = c;
    addBuff(gs, p, 'attackPower', ab.damage, ab.duration);
    addBuff(gs, p, 'attackSpeedPct', 30, ab.duration);
    addBuff(gs, p, 'moveSpeedPct', 20, ab.duration);
    p.ascend = { until: gs.time + ab.duration, color: ab.color, c };
    p.infoRev = (p.infoRev ?? 0) + 1;
    show(c, p.x, p.y, [
      add({ type: 'pillar', x: p.x, y: p.y, r: 1.2, color: ab.color, dur: 0.6 }),
      emit('arcane', p.x, p.y, 40, 1.2, 4), ['ascend', ab.duration, ab.color], snd('levelup'),
    ]);
  },
};

function addBuff(gs, p, stat, value, duration) {
  const existing = p.buffs.find((b) => b.stat === stat && b.source === 'ability');
  if (existing) existing.until = gs.time + duration;
  else p.buffs.push({ stat, value, until: gs.time + duration, source: 'ability' });
  recomputeStats(gs, p);
}

/** Ascension: every strike also sends out a shockwave (called by the attack code). */
export function ascendStrike(gs, p, angle) {
  const asc = p.ascend;
  if (!asc || asc.until <= gs.time) return;
  const c = asc.c;
  const x = p.x + Math.cos(angle) * 1.6;
  const y = p.y + Math.sin(angle) * 1.6;
  deal(c, enemiesInRadius(gs, x, y, c.ab.radius), (weaponDamage(c) * 60) / 100, { knockback: 1.5, fromX: p.x, fromY: p.y });
  show(c, x, y, [add({ type: 'ring', x, y, r0: 0.3, r1: c.ab.radius, color: asc.color, dur: 0.25, fill: true })]);
}

// --- Casting ---------------------------------------------------------------------------------

function cooldowns(p) {
  p.ch.extra.abilityCd ??= {};
  return p.ch.extra.abilityCd;
}

/** Seconds until the held weapon's power is ready (0 = ready), or null without one. */
export function readyIn(p, now = Date.now()) {
  const w = heldWeapon(p);
  if (!w?.ability) return null;
  return Math.max(0, ((cooldowns(p)[w.dna.id] ?? 0) - now) / 1000);
}

/** All running cooldowns for the client: { weaponId: seconds left }. */
export function cooldownPayload(p, now = Date.now()) {
  const all = {};
  const cds = cooldowns(p);
  for (const [id, at] of Object.entries(cds)) {
    if (at > now) all[id] = r2((at - now) / 1000);
    else delete cds[id];
  }
  return { t: 'abcd', all };
}

function startCooldown(gs, p, w, ab, now) {
  cooldowns(p)[w.dna.id] = now + ab.cooldown * 1000;
  gs.send(p, { t: 'abcd', id: w.dna.id, left: ab.cooldown });
}

/** The player pressed the ability button. */
export function cast(gs, p, aim, targetId, now = Date.now()) {
  const w = heldWeapon(p);
  const ab = w?.ability;
  if (!ab || p.dead) return false;
  const action = ACTIONS[ab.action];
  if (!action) return false;
  if (readyIn(p, now) > 0) return false;
  startCooldown(gs, p, w, ab, now);
  const c = { gs, p, w, ab, targetId };
  if (ab.legendary) {
    // A legendary power announces itself.
    const color = ab.color ?? '#ffd24a';
    show(c, p.x, p.y, [
      ['flash', color, 0.25],
      ['text', r2(p.x), r2(p.y - 1.6), ab.name.toUpperCase(), color, 1.4],
      add({ type: 'ring', x: p.x, y: p.y, r0: 0.3, r1: 2.2, color, dur: 0.35 }),
      snd('discover', { rarity: 4 }),
    ]);
  }
  action(c, aim);
  if (ab.twist === 'twin' && ab.action !== 'phoenix') gs.schedule(0.5, () => {
    if (!p.dead && gs.players.has(p.id)) action(c, aim);
  });
  show(c, p.x, p.y, [['vib', ab.legendary ? 40 : 20]]);
  markMe(p);
  return true;
}

/** Phoenix: while its power is ready, the first death is prevented. */
export function tryPhoenixRevive(gs, p, now = Date.now()) {
  const w = heldWeapon(p);
  const ab = w?.ability;
  if (!ab || ab.action !== 'phoenix' || readyIn(p, now) > 0) return false;
  p.hp = Math.max(1, p.maxHp * 0.5);
  p.invulnUntil = now + 1500;
  startCooldown(gs, p, w, ab, now);
  ACTIONS.phoenix({ gs, p, w, ab, targetId: 0 }, p.facing);
  gs.toast(p, 'Fenix: du reser dig ur askan!', 'legendary');
  return true;
}

// --- Clones --------------------------------------------------------------------------------

/** Clones follow their caster and fight the monsters around. */
export function updateAllies(gs, dt) {
  for (const a of gs.allies.values()) {
    const p = gs.players.get(a.owner);
    if (!p || p.dead || gs.time >= a.until) {
      gs.allies.delete(a.id);
      gs.event(a.x, a.y, { k: 'fx', fx: 'ab', by: a.owner, x: r2(a.x), y: r2(a.y), ops: [emit('arcane', a.x, a.y, 10, 0.5)] }, FX_RADIUS);
      continue;
    }
    const target = nearestEnemy(gs, a.x, a.y, 8);
    let tx = p.x - 1;
    let ty = p.y;
    if (target) {
      tx = target.x;
      ty = target.y;
    }
    const d = Math.hypot(tx - a.x, ty - a.y);
    const reach = Math.min(a.w.stats.range, 3);
    a.moving = false;
    if (d > (target ? reach * 0.8 : 1.2)) {
      const nx = (tx - a.x) / (d || 1);
      const ny = (ty - a.y) / (d || 1);
      a.x += nx * p.stats.moveSpeed * 1.1 * dt;
      a.y += ny * p.stats.moveSpeed * 1.1 * dt;
      a.facing = Math.atan2(ny, nx);
      a.moving = true;
    }
    a.atkCd -= dt;
    if (target && d <= reach + target.r && a.atkCd <= 0) {
      a.atkCd = 1 / a.w.stats.attackSpeed;
      a.facing = Math.atan2(target.y - a.y, target.x - a.x);
      a.anim = (a.anim + 1) & 255;
      const dmg = (a.w.stats.damage * (1 + p.stats.attackPower / 100) * a.damagePct) / 100;
      const dealt = damageEnemy(gs, target, dmg, { attacker: p, element: a.w.element, depth: 1, source: 'ally', canCrit: false });
      if (a.vampiric) heal(gs, p, dealt * 0.2);
    }
  }
}

// --- Areas ------------------------------------------------------------------------------------

function damageInside(gs, a, amount) {
  for (const e of enemiesInRadius(gs, a.x, a.y, a.r)) {
    damageEnemy(gs, e, amount, { attacker: a.caster, element: a.element, depth: 2, source: 'ability', canCrit: false });
    if (a.element !== 'physical' && Math.random() < 0.3) {
      const st = gs.data.byId.elements.get(a.element)?.status;
      if (st && !e.dead) applyStatus(gs, e, st, amount * 3, a.caster);
    }
  }
}

function warp(gs, a, slow) {
  for (const e of enemiesInRadius(gs, a.x, a.y, a.r)) {
    e.warpUntil = gs.time + 0.2;
    e.warpSlow = slow;
  }
}

/** One tick of an ability's lingering area (called by combat.updateAreas after a.t moved on). */
export function updateArea(gs, a, dt) {
  const owner = gs.players.get(a.owner);
  if (a.follow) {
    if (!owner || owner.dead) {
      a.t = a.dur;
      return;
    }
    a.x = owner.x;
    a.y = owner.y;
  }
  a.tick = (a.tick ?? 0) + dt;
  const tick = a.tick >= AREA_TICK;
  if (tick) a.tick -= AREA_TICK;
  switch (a.kind) {
    case 'portal':
      for (const e of gs.enemiesNear(a.x, a.y, a.r * 1.4)) {
        if (e.dead) continue;
        const d2 = (a.x - e.x) ** 2 + (a.y - e.y) ** 2;
        const reach = a.r * 1.4;
        if (d2 > reach * reach || d2 < 0.01) continue;
        const d = Math.sqrt(d2);
        const strength = a.pull * (e.boss ? 0.15 : 1) * dt;
        e.x += ((a.x - e.x) / d) * strength;
        e.y += ((a.y - e.y) / d) * strength;
      }
      if (tick) damageInside(gs, a, a.dps * AREA_TICK);
      break;
    case 'cloud':
      if (tick) damageInside(gs, a, a.dps * AREA_TICK);
      break;
    case 'timewarp':
      warp(gs, a, a.slow);
      break;
    case 'bladering': {
      const n = a.count ?? 3;
      for (let k = 0; k < n; k++) {
        const ang = a.t * 5 + (k / n) * Math.PI * 2;
        const bx = a.x + Math.cos(ang) * a.r;
        const by = a.y + Math.sin(ang) * a.r;
        for (const e of gs.enemiesNear(bx, by, 2)) {
          if (e.dead) continue;
          const rr = e.r + 0.4;
          if ((bx - e.x) ** 2 + (by - e.y) ** 2 > rr * rr) continue;
          const key = `${k}:${e.id}`;
          if ((a.cooldowns.get(key) ?? 0) > gs.time) continue;
          a.cooldowns.set(key, gs.time + 0.35);
          damageEnemy(gs, e, a.hit, { attacker: owner ?? null, element: a.element, depth: 1, source: 'ability', canCrit: false });
          if (a.vampiric && owner) heal(gs, owner, a.hit * 0.2);
        }
      }
      break;
    }
    case 'quake': {
      const radius = a.r * Math.min(1, a.t / a.dur);
      for (const e of enemiesInRadius(gs, a.x, a.y, radius)) {
        if (a.hitSet.has(e.id)) continue;
        a.hitSet.add(e.id);
        damageEnemy(gs, e, a.hit, {
          attacker: owner ?? null, element: a.element, depth: 1, source: 'ability', canCrit: false, status: 'stagger', knockback: 2, fromX: a.x, fromY: a.y,
        });
        if (a.vampiric && owner) heal(gs, owner, a.hit * 0.2);
      }
      break;
    }
    case 'field':
      if (a.slow) warp(gs, a, a.slow);
      if (a.pulse) {
        a.pulseT = (a.pulseT ?? 0) - dt;
        if (a.pulseT <= 0) {
          a.pulseT = a.pulse;
          a.onPulse?.(a);
        }
      }
      if (a.t >= a.dur && !a.ended) {
        a.ended = true;
        a.onEnd?.(a);
      }
      break;
    default:
      break;
  }
}

/** Speed factor for monster shots inside a Time Warp. */
export function shotSlowAt(gs, x, y) {
  for (const a of gs.areas.values()) {
    if (a.kind === 'timewarp' && (a.x - x) ** 2 + (a.y - y) ** 2 <= a.r * a.r) return 1 - a.slow / 100;
  }
  return 1;
}

export const _test = { ACTIONS };
