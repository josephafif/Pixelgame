// Status effects on enemies (burn, chill/freeze, shock, poison, bleed,
// rift, stagger, gust, smite, mark). Definitions live in game data; this
// module applies and ticks them.

import { normalize } from '../core/math.js';

const DOT_INTERVAL = 0.5;

export function statusForElement(data, element) {
  return data.byId.elements.get(element)?.status ?? null;
}

/**
 * @param {object} game
 * @param {object} e enemy
 * @param {string} id status id
 * @param {number} sourceDamage damage of the hit that caused it (scales DoTs)
 */
export function applyStatus(game, e, id, sourceDamage = 0) {
  const def = game.data.statuses[id];
  if (!def || e.dead) return;
  const now = game.time;
  const s = e.status;
  const until = now + def.duration;
  const dot = Math.max(1, (sourceDamage * (def.dotPct ?? 0)) / 100);
  switch (id) {
    case 'burn':
      s.burn = { until, dps: Math.max(dot, s.burn?.until > now ? s.burn.dps : 0) };
      game.fx.emit('ember', e.x, e.y - e.r, 3);
      break;
    case 'poison':
    case 'bleed': {
      const prev = s[id]?.until > now ? s[id] : null;
      s[id] = { until, stacks: Math.min(def.maxStacks, (prev?.stacks ?? 0) + 1), dps: Math.max(dot, prev?.dps ?? 0) };
      game.fx.emit(id === 'poison' ? 'toxic' : 'blood', e.x, e.y - e.r, 3);
      break;
    }
    case 'rift':
      s.rift = { until, dps: dot };
      game.fx.emit('void', e.x, e.y, 4);
      break;
    case 'chill': {
      const stacks = (s.chill?.until > now ? s.chill.stacks : 0) + 1;
      if (stacks >= def.freezeAt && !e.boss) {
        s.chill = null;
        applyStatus(game, e, 'freeze', sourceDamage);
      } else {
        s.chill = { until, stacks };
      }
      game.fx.emit('frost', e.x, e.y - e.r, 3);
      break;
    }
    case 'freeze':
      if (e.boss) {
        s.chill = { until, stacks: 1 };
      } else {
        s.freeze = { until };
        s.chill = { until: until + 1, stacks: 0 };
      }
      game.fx.emit('frost', e.x, e.y, 8, 0.6);
      break;
    case 'shock':
      s.shock = { until };
      game.fx.emit('spark', e.x, e.y - e.r, 4);
      break;
    case 'stagger':
      if (!e.boss && !(s.staggerImmune > now)) {
        s.stun = { until };
        s.staggerImmune = now + (def.immunity ?? 2);
      }
      game.fx.emit('dust', e.x, e.y, 4);
      break;
    case 'gust': {
      if (e.boss) break;
      const n = normalize(e.x - game.player.x, e.y - game.player.y);
      e.kx += n.x * def.knockback * 4;
      e.ky += n.y * def.knockback * 4;
      game.fx.emit('leaf', e.x, e.y, 4);
      break;
    }
    case 'smite':
      game.schedule(0.2, () => {
        if (e.dead) return;
        game.fx.add({ type: 'pillar', x: e.x, y: e.y, r: 0.6, color: '#fff3b0', dur: 0.3 });
        game.damageEnemy(e, (sourceDamage * def.bonusPct) / 100, { element: 'holy', depth: 2, source: 'proc' });
      });
      break;
    case 'mark':
      s.mark = { until };
      break;
    default:
      break;
  }
}

export function tickStatuses(game, e, dt) {
  const s = e.status;
  const now = game.time;
  let dps = 0;
  if (s.burn?.until > now) dps += s.burn.dps;
  if (s.poison?.until > now) dps += s.poison.dps * s.poison.stacks;
  if (s.bleed?.until > now) dps += s.bleed.dps * s.bleed.stacks * (Math.hypot(e.vx, e.vy) > 0.2 ? 1.3 : 1);
  if (s.rift?.until > now) dps += s.rift.dps;
  if (dps > 0) {
    e.dotTimer = (e.dotTimer ?? 0) + dt;
    if (e.dotTimer >= DOT_INTERVAL) {
      e.dotTimer -= DOT_INTERVAL;
      game.damageEnemy(e, dps * DOT_INTERVAL, { depth: 2, source: 'dot', quiet: false, color: '#ff9a5a' });
    }
  } else {
    e.dotTimer = 0;
  }
  let slow = 1;
  if (s.chill?.until > now) slow *= 1 - game.data.statuses.chill.slow / 100;
  if (s.rift?.until > now) slow *= 1 - game.data.statuses.rift.slow / 100;
  if (e.warpUntil > now) slow *= 1 - e.warpSlow / 100;
  e.slowMult = slow;
  e.stunned = s.freeze?.until > now || s.stun?.until > now;
  e.frozen = s.freeze?.until > now;
  // Tint shows the most important active status.
  e.tint = e.frozen ? '#dff6ff'
    : s.burn?.until > now ? '#ff7b25'
      : s.shock?.until > now ? '#ffe45c'
        : s.poison?.until > now ? '#79d23c'
          : s.chill?.until > now ? '#8fd6ff'
            : s.rift?.until > now ? '#9a5cff'
              : s.bleed?.until > now ? '#d0263a' : null;
}

export function isChilled(game, e) {
  return e.status.chill?.until > game.time || e.status.freeze?.until > game.time;
}
