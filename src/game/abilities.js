// Active abilities granted by Legendary (and some Epic) weapons. Values come
// from the weapon's DNA (damage, cooldown, area, duration, twist, element
// infusion). Cooldowns run on game time, which only advances while the game
// is actually running, and remaining cooldowns are persisted in the save —
// so backgrounding, suspending or reloading the PWA never skips or resets
// them.

import { dist2, normalize } from '../core/math.js';
import { applyStatus, statusForElement } from './status.js';
import { nearestEnemy, enemiesInRadius, weaponDamage, healPlayer } from './combat.js';

/** The ability the equipped weapon casts (a legendary's signature power). */
function abilityOf(game) {
  return game.weapon?.ability ?? game.weapon?.dna.ability ?? null;
}

export function abilityReadyIn(game) {
  const ab = abilityOf(game);
  if (!ab) return null;
  const readyAt = game.abilityReadyAt.get(game.weapon.dna.id) ?? 0;
  return Math.max(0, readyAt - game.time);
}

export function abilityProgress(game) {
  const ab = abilityOf(game);
  if (!ab) return null;
  const left = abilityReadyIn(game);
  return { left, total: ab.cooldown, ready: left <= 0 };
}

/** Called on load: restores persisted cooldowns relative to current game time. */
export function restoreCooldowns(game) {
  const saved = game.save.abilityState?.cooldowns ?? {};
  for (const [weaponId, remaining] of Object.entries(saved)) {
    game.abilityReadyAt.set(weaponId, game.time + Math.max(0, remaining));
  }
}

/** Snapshot of remaining cooldowns for the save. */
export function persistCooldowns(game) {
  const out = {};
  for (const [weaponId, readyAt] of game.abilityReadyAt) {
    const left = readyAt - game.time;
    if (left > 0.05) out[weaponId] = Math.round(left * 10) / 10;
  }
  game.save.abilityState.cooldowns = out;
}

function infuse(game, ab, targets, sourceDamage) {
  if (!ab.infuse) return;
  const st = statusForElement(game.data, ab.infuse);
  if (!st) return;
  for (const e of targets) if (Math.random() < 0.6) applyStatus(game, e, st, sourceDamage);
}

function dealAbilityDamage(game, ab, targets, amount, extra = {}) {
  let total = 0;
  for (const e of targets) {
    total += game.damageEnemy(e, amount, { element: ab.infuse ?? 'physical', depth: 1, source: 'ability', ...extra });
  }
  infuse(game, ab, targets, amount);
  if (ab.twist === 'vampiric' && total > 0) healPlayer(game, total * 0.2);
  return total;
}

function aimPoint(game, ab, angle, dist) {
  const p = game.player;
  if (ab.twist === 'seeking') {
    const t = nearestEnemy(game, p.x, p.y, 10);
    if (t) return { x: t.x, y: t.y };
  }
  const t = nearestEnemy(game, p.x + Math.cos(angle) * dist, p.y + Math.sin(angle) * dist, dist);
  if (t) return { x: t.x, y: t.y };
  return { x: p.x + Math.cos(angle) * dist, y: p.y + Math.sin(angle) * dist };
}

const ACTIONS = {
  meteor(game, ab, angle) {
    const { x, y } = aimPoint(game, ab, angle, 5);
    const color = game.data.byId.elements.get(ab.infuse)?.glow ?? '#ff8a2a';
    game.fx.add({ type: 'marker', x, y, r: ab.radius, color, dur: ab.duration || 0.6 });
    game.fx.add({ type: 'meteor', x, y, color, dur: ab.duration || 0.6 });
    game.schedule(ab.duration || 0.6, () => {
      const dmg = (weaponDamage(game) * ab.damage) / 100;
      dealAbilityDamage(game, ab, enemiesInRadius(game, x, y, ab.radius), dmg, { knockback: 3, fromX: x, fromY: y });
      game.fx.add({ type: 'ring', x, y, r0: 0.3, r1: ab.radius, color, dur: 0.35, fill: true });
      game.fx.emit(game.data.byId.elements.get(ab.infuse)?.particles ?? 'ember', x, y, 24, ab.radius, 4);
      game.shake = Math.max(game.shake, 0.4);
      game.audio.play('boom');
    });
  },
  blink(game, ab, angle) {
    const p = game.player;
    let tx = p.x;
    let ty = p.y;
    const target = ab.twist === 'seeking' ? nearestEnemy(game, p.x, p.y, ab.range + 2) : null;
    const dir = target ? normalize(target.x - p.x, target.y - p.y) : { x: Math.cos(angle), y: Math.sin(angle) };
    for (let s = 0.25; s <= ab.range; s += 0.25) {
      const nx = p.x + dir.x * s;
      const ny = p.y + dir.y * s;
      if (!game.world.isFree(nx, ny, p.r)) break;
      tx = nx;
      ty = ny;
    }
    game.fx.add({ type: 'line', points: [[p.x, p.y], [tx, ty]], color: '#cdb2ff', dur: 0.2 });
    game.fx.emit('arcane', p.x, p.y, 10, 0.5);
    p.x = tx;
    p.y = ty;
    p.invuln = Math.max(p.invuln, 0.35);
    const dmg = (weaponDamage(game) * ab.damage) / 100;
    dealAbilityDamage(game, ab, enemiesInRadius(game, tx, ty, ab.radius), dmg);
    game.fx.add({ type: 'ring', x: tx, y: ty, r0: 0.2, r1: ab.radius, color: '#cdb2ff', dur: 0.2 });
    game.audio.play('zap');
  },
  blackhole(game, ab, angle) {
    const { x, y } = aimPoint(game, ab, angle, 4);
    game.spawnArea('portal', {
      x, y, r: ab.radius * 0.6, dur: ab.duration, pull: 7, big: true, source: 'ability',
      dps: (weaponDamage(game) * ab.damage) / 100, element: ab.infuse ?? 'void',
    });
    game.audio.play('hum');
  },
  clone(game, ab) {
    const p = game.player;
    game.allies.push({
      kind: 'clone', x: p.x + 0.8, y: p.y, r: p.r, until: game.time + ab.duration, atkCd: 0.3,
      damagePct: ab.damage, facing: 0, vampiric: ab.twist === 'vampiric',
    });
    game.fx.emit('arcane', p.x, p.y, 16, 0.8);
    game.audio.play('zap');
  },
  quake(game, ab) {
    const p = game.player;
    game.spawnArea('quake', {
      x: p.x, y: p.y, r: ab.radius, dur: ab.duration || 0.8, element: ab.infuse ?? 'earth',
      hit: (weaponDamage(game) * ab.damage) / 100, vampiric: ab.twist === 'vampiric', color: '#d9a45c',
    });
    game.shake = Math.max(game.shake, 0.45);
    game.audio.play('boom');
  },
  phoenix(game, ab) {
    const p = game.player;
    const dmg = (weaponDamage(game) * ab.damage) / 100;
    dealAbilityDamage(game, ab, enemiesInRadius(game, p.x, p.y, ab.radius), dmg, { status: 'burn', knockback: 2 });
    healPlayer(game, game.pstats.maxHp * 0.25);
    game.fx.add({ type: 'ring', x: p.x, y: p.y, r0: 0.5, r1: ab.radius, color: '#ff8a2a', dur: 0.4, fill: true });
    game.fx.emit('ember', p.x, p.y, 30, ab.radius, 5);
    game.audio.play('boom');
  },
  storm(game, ab) {
    const p = game.player;
    const targets = enemiesInRadius(game, p.x, p.y, ab.radius).sort(() => Math.random() - 0.5).slice(0, ab.count);
    const dmg = (weaponDamage(game) * ab.damage) / 100;
    targets.forEach((e, i) => {
      game.schedule(i * 0.12, () => {
        if (e.dead) return;
        game.fx.add({ type: 'bolt', x: e.x, y: e.y, r: 0.8, color: '#fff27a', dur: 0.25 });
        dealAbilityDamage(game, ab, [e], dmg, { status: 'shock' });
        game.audio.play('zap', { throttle: 40 });
      });
    });
  },
  frostnova(game, ab) {
    const p = game.player;
    const targets = enemiesInRadius(game, p.x, p.y, ab.radius);
    const dmg = (weaponDamage(game) * ab.damage) / 100;
    dealAbilityDamage(game, ab, targets, dmg);
    for (const e of targets) {
      if (!e.dead) {
        applyStatus(game, e, 'freeze', dmg);
        if (e.status.freeze) e.status.freeze.until = game.time + ab.duration;
      }
    }
    game.fx.add({ type: 'ring', x: p.x, y: p.y, r0: 0.5, r1: ab.radius, color: '#a9e6ff', dur: 0.4, fill: true });
    game.fx.emit('frost', p.x, p.y, 30, ab.radius, 4);
    game.audio.play('zap');
  },
  bladering(game, ab) {
    game.spawnArea('bladering', {
      x: game.player.x, y: game.player.y, r: ab.radius, dur: ab.duration, count: ab.count,
      hit: (weaponDamage(game) * ab.damage) / 100, element: ab.infuse ?? 'physical', vampiric: ab.twist === 'vampiric',
      color: game.weapon.trail,
    });
    game.audio.play('whirl');
  },
  timewarp(game, ab) {
    const p = game.player;
    game.spawnArea('timewarp', { x: p.x, y: p.y, r: ab.radius, dur: ab.duration, slow: ab.slow, color: '#ff8cf5' });
    game.audio.play('hum');
  },

  // --- Legendary signature powers ------------------------------------------------

  /** Starfall: stars rain on the enemies around you, one after another. */
  starfall(game, ab) {
    const p = game.player;
    const dmg = (weaponDamage(game) * ab.damage) / 100;
    const color = ab.color;
    for (let i = 0; i < ab.count; i++) {
      game.schedule((i / ab.count) * ab.duration, () => {
        const foes = enemiesInRadius(game, p.x, p.y, ab.radius);
        const e = foes.length ? foes[i % foes.length] : null;
        const a = Math.random() * Math.PI * 2;
        const x = e ? e.x : p.x + Math.cos(a) * ab.radius * Math.random();
        const y = e ? e.y : p.y + Math.sin(a) * ab.radius * Math.random();
        game.fx.add({ type: 'meteor', x, y, color, dur: 0.3 });
        game.schedule(0.3, () => {
          dealAbilityDamage(game, ab, enemiesInRadius(game, x, y, 1.5), dmg, { knockback: 1, fromX: x, fromY: y });
          game.fx.add({ type: 'ring', x, y, r0: 0.2, r1: 1.6, color, dur: 0.3, fill: true });
          game.fx.emit('holy', x, y, 12, 0.8, 3);
          game.shake = Math.max(game.shake, 0.12);
          game.audio.play('boom', { throttle: 90 });
        });
      });
    }
  },

  /** Dragon's Breath: a cone of fire that follows your aim; the ground burns. */
  breath(game, ab) {
    const p = game.player;
    const ticks = Math.round(ab.duration / 0.12);
    const half = 0.5;
    for (let i = 0; i < ticks; i++) {
      game.schedule(i * 0.12, () => {
        if (p.dead) return;
        const a = game.target && !game.target.dead ? Math.atan2(game.target.y - p.y, game.target.x - p.x) : p.facing;
        p.facing = a;
        const dmg = (weaponDamage(game) * ab.damage) / 100;
        const hit = enemiesInRadius(game, p.x, p.y, ab.radius).filter((e) => {
          const da = Math.atan2(e.y - p.y, e.x - p.x) - a;
          return Math.cos(da) > Math.cos(half);
        });
        dealAbilityDamage(game, ab, hit, dmg, { status: 'burn' });
        for (let k = 0; k < 5; k++) {
          const d = Math.random() * ab.radius;
          const off = (Math.random() - 0.5) * 2 * half * (d / ab.radius);
          game.fx.emit(k % 2 ? 'ember' : 'spark', p.x + Math.cos(a + off) * d, p.y + Math.sin(a + off) * d, 2, 0.3, 2.5);
        }
        if (i % 4 === 0) {
          const d = ab.radius * 0.7;
          game.spawnArea('cloud', {
            x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d, r: 1.1, dur: 2.5, lava: true, source: 'ability',
            dps: (weaponDamage(game) * ab.damage) / 100, element: 'fire',
          });
        }
        game.audio.play('whirl', { throttle: 300 });
      });
    }
  },

  /** Absolute Zero: a blizzard that slows, then freezes and shatters everything. */
  zero(game, ab) {
    const p = game.player;
    game.spawnArea('field', {
      x: p.x, y: p.y, r: ab.radius, dur: ab.duration, follow: true, slow: 60, color: ab.color, particles: 'frost', spin: 5,
      onEnd: (area) => {
        const dmg = (weaponDamage(game) * ab.damage) / 100;
        const targets = enemiesInRadius(game, area.x, area.y, area.r);
        for (const e of targets) {
          applyStatus(game, e, 'freeze', dmg);
          if (e.status.freeze) e.status.freeze.until = game.time + 1.2;
        }
        dealAbilityDamage(game, ab, targets, dmg);
        game.fx.add({ type: 'ring', x: area.x, y: area.y, r0: 0.5, r1: area.r, color: '#dff6ff', dur: 0.45, fill: true });
        game.fx.emit('frost', area.x, area.y, 50, area.r, 5);
        game.flash('#dff6ff', 0.2);
        game.shake = Math.max(game.shake, 0.4);
        game.audio.play('zap');
      },
    });
    game.audio.play('whirl');
  },

  /** Wrath of Storms: three waves of chain lightning. */
  wrath(game, ab) {
    const p = game.player;
    for (let wave = 0; wave < 3; wave++) {
      game.schedule(wave * 0.55, () => {
        if (p.dead) return;
        const dmg = (weaponDamage(game) * ab.damage) / 100;
        let from = { x: p.x, y: p.y };
        const hit = new Set();
        for (let j = 0; j < ab.count; j++) {
          const range = j === 0 ? ab.radius : 4.5;
          const e = nearestEnemy(game, from.x, from.y, range, hit);
          if (!e) break;
          hit.add(e);
          const start = from;
          game.schedule(j * 0.05, () => {
            game.fx.add({ type: 'line', points: [[start.x, start.y], [e.x, e.y]], color: ab.color, dur: 0.22, jagged: true });
            if (!e.dead) dealAbilityDamage(game, ab, [e], dmg, { status: 'shock' });
          });
          from = { x: e.x, y: e.y };
        }
        if (hit.size) game.audio.play('zap', { throttle: 50 });
        game.fx.add({ type: 'bolt', x: p.x, y: p.y, r: 0.8, color: ab.color, dur: 0.25 });
      });
    }
  },

  /** Event Horizon: a singularity drags enemies in, then collapses. */
  horizon(game, ab, angle) {
    const { x, y } = aimPoint(game, ab, angle, 4.5);
    game.spawnArea('portal', {
      x, y, r: ab.radius * 0.7, dur: ab.duration, pull: 10, big: true, source: 'ability',
      dps: (weaponDamage(game) * ab.damage) / 1000, element: ab.infuse ?? 'void', color: ab.color,
    });
    game.audio.play('hum');
    game.schedule(ab.duration, () => {
      const dmg = (weaponDamage(game) * ab.damage) / 100;
      dealAbilityDamage(game, ab, enemiesInRadius(game, x, y, ab.radius * 1.3), dmg, { knockback: 3, fromX: x, fromY: y });
      game.fx.add({ type: 'ring', x, y, r0: ab.radius * 1.3, r1: 0.2, color: ab.color, dur: 0.25 });
      game.schedule(0.2, () => game.fx.add({ type: 'ring', x, y, r0: 0.3, r1: ab.radius * 1.5, color: '#e8d8ff', dur: 0.4, fill: true }));
      game.fx.emit('void', x, y, 50, ab.radius, 6);
      game.flash('#9a5cff', 0.25);
      game.shake = Math.max(game.shake, 0.6);
      game.audio.play('boom');
    });
  },

  /** Thousand Blades: a halo of spectral blades that hunt enemies one by one. */
  blades(game, ab) {
    const p = game.player;
    const dmg = (weaponDamage(game) * ab.damage) / 100;
    const color = game.weapon?.trail ?? ab.color;
    game.spawnArea('bladering', {
      x: p.x, y: p.y, r: 1.4, dur: 0.25 + ab.count * 0.09, count: Math.min(8, ab.count), hit: dmg * 0.3,
      element: ab.infuse ?? 'physical', color,
    });
    for (let i = 0; i < ab.count; i++) {
      game.schedule(0.25 + i * 0.09, () => {
        if (p.dead) return;
        // Blades spread over the enemies around you, nearest first.
        const foes = enemiesInRadius(game, p.x, p.y, ab.radius)
          .sort((m, n) => dist2(p.x, p.y, m.x, m.y) - dist2(p.x, p.y, n.x, n.y));
        const t = foes.length ? foes[i % foes.length] : null;
        const a = t ? Math.atan2(t.y - p.y, t.x - p.x) + (Math.random() - 0.5) * 0.3 : (i / ab.count) * Math.PI * 2;
        game.spawnProjectile({
          x: p.x + Math.cos(a) * 1.2, y: p.y + Math.sin(a) * 1.2, angle: a, speed: 13, damage: dmg, range: ab.radius + 2,
          size: 3, sprite: 'blade', owner: 'player', element: ab.infuse ?? 'physical', color, homing: 1, pierce: 1, depth: 1,
          source: 'ability',
        });
        game.audio.play('swish', { throttle: 60 });
      });
    }
  },

  /** Venom Bloom: a giant flower that pulses waves of poison. */
  bloom(game, ab, angle) {
    // It bursts up a few steps ahead of you, among the enemies.
    const { x, y } = aimPoint(game, ab, angle, 2.5);
    game.spawnArea('field', {
      x, y, r: ab.radius, dur: ab.duration, color: ab.color, particles: 'toxic', spin: 1.5, flower: true,
      pulse: ab.duration / ab.count,
      onPulse: (area) => {
        const dmg = (weaponDamage(game) * ab.damage) / 100;
        dealAbilityDamage(game, ab, enemiesInRadius(game, area.x, area.y, area.r), dmg, { status: 'poison' });
        game.fx.add({ type: 'ring', x: area.x, y: area.y, r0: 0.4, r1: area.r, color: ab.color, dur: 0.4 });
        game.audio.play('whirl', { throttle: 200 });
      },
    });
    game.fx.emit('leaf', x, y, 24, 1.2, 3);
    game.shake = Math.max(game.shake, 0.25);
  },

  /** Ascension: stronger, faster, and every strike sends out a shockwave. */
  ascend(game, ab) {
    const p = game.player;
    game.addBuff('attackPower', ab.damage, ab.duration);
    game.addBuff('attackSpeedPct', 30, ab.duration);
    game.addBuff('moveSpeedPct', 20, ab.duration);
    game.ascend = {
      until: game.time + ab.duration,
      color: ab.color,
      strike: (angle) => {
        const x = p.x + Math.cos(angle) * 1.6;
        const y = p.y + Math.sin(angle) * 1.6;
        const dmg = (weaponDamage(game) * 60) / 100;
        dealAbilityDamage(game, ab, enemiesInRadius(game, x, y, ab.radius), dmg, { knockback: 1.5, fromX: p.x, fromY: p.y });
        game.fx.add({ type: 'ring', x, y, r0: 0.3, r1: ab.radius, color: ab.color, dur: 0.25, fill: true });
      },
    };
    game.fx.add({ type: 'pillar', x: p.x, y: p.y, r: 1.2, color: ab.color, dur: 0.6 });
    game.fx.emit('arcane', p.x, p.y, 40, 1.2, 4);
    game.audio.play('levelup');
  },
};

/** Casts the equipped weapon's ability if it is ready. */
export function castAbility(game, angle) {
  const ab = abilityOf(game);
  if (!ab || game.player.dead) return false;
  if (abilityReadyIn(game) > 0) return false;
  const action = ACTIONS[ab.action];
  if (!action) return false;
  game.abilityReadyAt.set(game.weapon.dna.id, game.time + ab.cooldown);
  if (ab.legendary) {
    // A legendary power announces itself.
    const p = game.player;
    game.flash(ab.color ?? '#ffd24a', 0.25);
    game.fx.text(p.x, p.y - 1.6, ab.name.toUpperCase(), ab.color ?? '#ffd24a', 1.4);
    game.fx.add({ type: 'ring', x: p.x, y: p.y, r0: 0.3, r1: 2.2, color: ab.color ?? '#ffd24a', dur: 0.35 });
    game.audio.play('discover', { rarity: 4 });
  }
  action(game, ab, angle);
  if (ab.twist === 'twin' && ab.action !== 'phoenix') game.schedule(0.5, () => action(game, ab, angle));
  game.vibrate(ab.legendary ? 40 : 20);
  return true;
}

/** Phoenix: while its ability is ready, the first death is prevented. */
export function tryPhoenixRevive(game) {
  const ab = abilityOf(game);
  if (!ab || ab.action !== 'phoenix' || abilityReadyIn(game) > 0) return false;
  const p = game.player;
  p.hp = Math.max(1, game.pstats.maxHp * 0.5);
  p.invuln = 1.5;
  game.abilityReadyAt.set(game.weapon.dna.id, game.time + ab.cooldown);
  ACTIONS.phoenix(game, ab, p.facing);
  game.emit('toast', { text: 'Phoenix: you rise from the ashes!', kind: 'legendary' });
  return true;
}

/** Clone allies: follow the player and attack nearby enemies. */
export function updateAllies(game, dt) {
  const p = game.player;
  for (let i = game.allies.length - 1; i >= 0; i--) {
    const a = game.allies[i];
    if (game.time >= a.until || p.dead) {
      game.fx.emit('arcane', a.x, a.y, 10, 0.5);
      game.allies.splice(i, 1);
      continue;
    }
    const target = nearestEnemy(game, a.x, a.y, 8);
    let tx = p.x - 1;
    let ty = p.y;
    if (target) {
      tx = target.x;
      ty = target.y;
    }
    const d = Math.sqrt(dist2(a.x, a.y, tx, ty));
    const reach = Math.min(game.weapon.stats.range, 3);
    if (d > (target ? reach * 0.8 : 1.2)) {
      const n = normalize(tx - a.x, ty - a.y);
      a.x += n.x * game.pstats.moveSpeed * 1.1 * dt;
      a.y += n.y * game.pstats.moveSpeed * 1.1 * dt;
      a.facing = Math.atan2(n.y, n.x);
    }
    a.atkCd -= dt;
    if (target && d <= reach + target.r && a.atkCd <= 0) {
      a.atkCd = 1 / game.weapon.stats.attackSpeed;
      a.facing = Math.atan2(target.y - a.y, target.x - a.x);
      a.attackT = game.time;
      const dmg = (weaponDamage(game) * a.damagePct) / 100;
      const dealt = game.damageEnemy(target, dmg, { element: game.weapon.element, depth: 1, source: 'ally' });
      if (a.vampiric) healPlayer(game, dealt * 0.2);
      game.fx.add({ type: 'slash', x: a.x, y: a.y, angle: a.facing, arc: 2, r: reach, color: '#cdb2ff', dur: 0.14, ghost: true });
    }
  }
}
