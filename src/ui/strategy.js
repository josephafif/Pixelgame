// The strategy map (N): the real map of the world (the land you have
// explored, as on the world map) with the territories on it — the land
// around each outpost, in its holder's colour — your soldiers and squads
// where they are, and the factions' armies on the march. It is for the
// overview and for giving orders: pick a squad (on the map or in the list),
// then a place on the map: attack, defend or patrol an outpost, or move
// anywhere. The fighting itself happens in the world, where you see it.
// Below the map: the squads, your soldiers (gear, squad) and recruits to
// train. Works the same in single player and multiplayer: the game gives
// strategyView() and armyAction() (campaign.js / server/army.js).

import { h, clear } from './dom.js';
import { icon, costChips } from './icons.js';
import { openModal } from './modal.js';
import { drawExplored } from './map.js';
import { CHUNK } from '../game/world.js';
import { ORDER_NAMES, ORDER_NAMES_SV, STANCES, STANCE_NAMES, STANCE_NAMES_SV } from '../game/army.js';
import { PERSONALITY_NAMES, PERSONALITY_NAMES_SV } from '../game/factions.js';
import { regionAt, regionOutline, HOME_REGION } from '../game/territory.js';

export const SQUAD_COLORS = ['#ffd24a', '#7ae0ff', '#ff8a5a', '#c09aff', '#8ef0a0', '#ff7ad8'];
const OWN = '#3fa86a';
const HOME = '#ffd24a';
const INK = '#0e0c18';

const TEXT = {
  en: {
    title: 'Strategy map', squads: 'Squads', soldiers: 'Soldiers', recruits: 'Train recruits', newSquad: 'New squad',
    noSquads: 'No squads yet. Make one, then put soldiers in it.', noSoldiers: 'No soldiers yet: train workers at the Training Grounds below.',
    noRecruits: 'No workers to train. Hire some at the Workers’ Lodge.', pick: 'Pick a squad, then a place on the map.',
    pickSquad: 'Pick a squad first (tap it in the list or on the map).', none: '(none)', disband: 'Disband', back: 'Back to work',
    gear: 'Gear', rank: 'Rank', train: 'Train', barracks: 'Barracks', squad: 'Squad', stance: 'Stance',
    own: 'Your territory', neutral: 'Neutral outpost', foreign: 'Held by', contested: 'Being taken', attacked: 'Under attack!', home: 'Your camp',
    wild: 'Open land: no outpost holds it', strength: 'Guards', move: 'Move here', away: 'tiles away',
    legend: 'Green: yours · coloured: a faction’s · dashed: neutral · yellow: being taken · flashing red: under attack · ◆ an army on the march',
    training: 'training', bestGear: 'best gear', members: 'soldiers', zoomIn: 'Zoom in', zoomOut: 'Zoom out', me: 'Me', camp: 'Camp',
    factions: 'Factions', squares: 'territories', ai: 'cunning', fallen: 'fallen', armies: 'armies on the march near you', toYou: 'coming for your land',
    tiers: { camp: 'camp', stronghold: 'stronghold', hq: 'headquarters' },
  },
  sv: {
    title: 'Strategikarta', squads: 'Trupper', soldiers: 'Soldater', recruits: 'Träna rekryter', newSquad: 'Ny trupp',
    noSquads: 'Inga trupper än. Skapa en och sätt soldater i den.', noSoldiers: 'Inga soldater än: träna arbetare vid träningsplatsen nedan.',
    noRecruits: 'Inga arbetare att träna. Anställ vid arbetarstugan.', pick: 'Välj en trupp och peka sedan ut en plats på kartan.',
    pickSquad: 'Välj en trupp först (i listan eller på kartan).', none: '(ingen)', disband: 'Upplös', back: 'Tillbaka till jobbet',
    gear: 'Utrustning', rank: 'Grad', train: 'Träna', barracks: 'Kasern', squad: 'Trupp', stance: 'Hållning',
    own: 'Ert territorium', neutral: 'Neutral utpost', foreign: 'Hålls av', contested: 'Tas just nu', attacked: 'Under attack!', home: 'Er bas',
    wild: 'Öppen mark: ingen utpost håller den', strength: 'Vakter', move: 'Flytta hit', away: 'rutor bort',
    legend: 'Grönt: ert · färgat: en fraktions · streckat: neutralt · gult: tas just nu · blinkar rött: under attack · ◆ en armé på marsch',
    training: 'tränar', bestGear: 'bästa utrustning', members: 'soldater', zoomIn: 'Zooma in', zoomOut: 'Zooma ut', me: 'Mig', camp: 'Basen',
    factions: 'Fraktioner', squares: 'territorier', ai: 'list', fallen: 'fallen', armies: 'arméer på marsch nära er', toYou: 'på väg mot er mark',
    tiers: { camp: 'läger', stronghold: 'fäste', hq: 'högkvarter' },
  },
};

// Where the map looked last time (the zoom is kept; it opens on you).
let lastZoom = 2.4;

function alpha(hex, a) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function open(game) {
  const p = game.player;
  const state = { cx: p.x, cy: p.y, zoom: lastZoom, squad: null, point: null, key: null };
  let view = null;
  let timer = null;
  let raf = 0;
  let more = false;

  const t = () => TEXT[view?.lang === 'sv' ? 'sv' : 'en'];
  const orderName = (k) => (view?.lang === 'sv' ? ORDER_NAMES_SV : ORDER_NAMES)[k] ?? k;
  const stanceName = (k) => (view?.lang === 'sv' ? STANCE_NAMES_SV : STANCE_NAMES)[k] ?? k;

  const canvas = h('canvas.strategy-map', { 'aria-label': 'Strategy map' });
  const sideEl = h('div.strategy-side');
  const listsEl = h('div.strategy-lists');
  const legendEl = h('p.small.muted.strategy-legend');

  function size() {
    return { w: canvas.clientWidth || 640, hh: canvas.clientHeight || 420 };
  }

  function box() {
    const { w, hh } = size();
    const hw = w / 2 / state.zoom;
    const hhh = hh / 2 / state.zoom;
    return { x0: state.cx - hw, y0: state.cy - hhh, x1: state.cx + hw, y1: state.cy + hhh };
  }

  function refresh() {
    const budget = { n: 4 };
    view = game.strategyView(box(), budget);
    more = view.territories.pending;
  }

  async function act(op, args) {
    const problem = await game.armyAction(op, args);
    if (problem) game.toast(problem, 'warn');
    rerender();
    return problem;
  }

  /** The side and the lists anew (the map stays where it is). */
  function rerender() {
    refresh();
    clear(sideEl).append(...side());
    clear(listsEl).append(...lists());
    legendEl.textContent = t().legend;
    schedule();
  }

  // --- The map ------------------------------------------------------------------------------------

  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (more) refresh();
    draw();
    if (more) schedule();
  }

  const explored = (x, y) => game.explored.has(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);

  function draw() {
    if (!view || !canvas.isConnected) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const { w, hh } = size();
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(hh * dpr)) canvas.height = Math.round(hh * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0a12';
    g.fillRect(0, 0, w, hh);
    const z = state.zoom;
    const toX = (x) => (x - state.cx) * z + w / 2;
    const toY = (y) => (y - state.cy) * z + hh / 2;
    // The land you know.
    if (drawExplored(g, game.world, game.explored, { cx: state.cx, cy: state.cy, zoom: z, w, h: hh, farZoom: 0.6 })) more = true;
    g.fillStyle = 'rgba(8, 6, 16, 0.18)';
    g.fillRect(0, 0, w, hh);
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    const budget = { n: 4 };
    // Territories: the land around each outpost, in its holder's colour.
    const shown = [];
    for (const c of view.territories.list) {
      const known = c.status !== 'neutral' || explored(c.x, c.y);
      if (!known) continue;
      const pts = regionOutline(game.world, game.data, c.home ? HOME_REGION : c.site, { budget });
      if (!pts) {
        more = true;
        continue;
      }
      shown.push(c);
      const color = c.home ? HOME : c.status === 'own' || c.status === 'attacked' ? OWN : c.status === 'foreign' ? c.color ?? '#c8364a' : c.status === 'contested' ? '#ffd24a' : '#e6e6f0';
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(toX(x), toY(y)) : g.moveTo(toX(x), toY(y))));
      g.closePath();
      if (c.status !== 'neutral') {
        g.fillStyle = alpha(color, c.home ? 0.12 : c.status === 'contested' ? 0.16 : 0.24);
        g.fill();
      }
      g.lineWidth = state.key === c.key ? 3 : 2;
      g.strokeStyle = state.key === c.key ? '#ffffff' : c.status === 'attacked' && blink ? '#ff4040' : alpha(color, c.status === 'neutral' ? 0.45 : 0.85);
      if (c.status === 'neutral' || c.status === 'contested') g.setLineDash([5, 4]);
      g.stroke();
      g.setLineDash([]);
    }
    // Their bases and flags.
    const r = Math.max(5, Math.min(9, z * 2.2));
    for (const c of shown) {
      const x = toX(c.x);
      const y = toY(c.y);
      if (x < -30 || y < -30 || x > w + 30 || y > hh + 30) continue;
      if (c.home) drawCamp(g, x, y, r);
      else if (c.status === 'foreign' && c.base) drawBase(g, x, y, r, c.base, c.color ?? '#c8364a');
      else drawFlag(g, x, y, r, c.status === 'own' || c.status === 'attacked' ? OWN : c.status === 'foreign' ? c.color ?? '#c8364a' : '#d8d8e4');
      if (!c.home && z >= 1.4) {
        // How strong its guards are (1-5).
        for (let i = 0; i < c.tier; i++) {
          g.fillStyle = INK;
          g.fillRect(x - c.tier * 2.5 + i * 5 - 0.5, y + r + 2.5, 4, 4);
          g.fillStyle = '#ffd24a';
          g.fillRect(x - c.tier * 2.5 + i * 5, y + r + 3, 3, 3);
        }
      }
      if (c.capture > 0 && c.capture < 1) {
        g.fillStyle = INK;
        g.fillRect(x - 13, y - r - 9, 26, 5);
        g.fillStyle = '#ffd24a';
        g.fillRect(x - 12, y - r - 8, 24 * c.capture, 3);
      }
      if (z >= 2 && (c.status === 'foreign' || c.home)) {
        // (Above the flag: below it is where you and your squads stand.)
        const label = c.home ? t().home : `${c.ownerName ?? ''}${c.base ? ` · ${t().tiers[c.base] ?? c.base}` : ''}`;
        text(g, label, x, y - r - (c.capture > 0 && c.capture < 1 ? 14 : 6), c.home ? HOME : '#f3ecdc');
      }
    }
    // The factions' armies on the march (near you or your land), and where they head.
    for (const a of view.factions?.armies ?? []) {
      const ax = toX(a.x);
      const ay = toY(a.y);
      g.strokeStyle = a.toMe ? '#ff5050' : alpha(a.color ?? '#c8364a', 0.9);
      g.lineWidth = 2;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(toX(a.toX), toY(a.toY));
      g.stroke();
      g.setLineDash([]);
      diamond(g, ax, ay, 9, INK);
      diamond(g, ax, ay, 7, a.color ?? '#c8364a');
      g.fillStyle = INK;
      g.font = 'bold 9px monospace';
      g.textAlign = 'center';
      g.fillText(String(a.troops), ax, ay + 3);
    }
    // Your soldiers, each where it is, in its squad's colour.
    const squadIndex = new Map(view.squads.map((sq, i) => [sq.id, i]));
    for (const s of view.troops ?? []) {
      const i = squadIndex.get(s.squad);
      const sx = toX(s.x);
      const sy = toY(s.y);
      g.fillStyle = INK;
      g.fillRect(sx - 2.5, sy - 2.5, 5, 5);
      g.fillStyle = i == null ? '#e8e0d0' : SQUAD_COLORS[i % SQUAD_COLORS.length];
      g.fillRect(sx - 1.5, sy - 1.5, 3, 3);
    }
    // You.
    const px = toX(view.player.x);
    const py = toY(view.player.y);
    g.save();
    g.translate(px, py);
    g.rotate(view.player.facing ?? 0);
    g.fillStyle = blink ? '#ffffff' : '#ffd24a';
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(9, 0);
    g.lineTo(-6, -6);
    g.lineTo(-3, 0);
    g.lineTo(-6, 6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // Squads: a marker where they are, a line to where they are headed.
    view.squads.forEach((sq, i) => {
      const color = SQUAD_COLORS[i % SQUAD_COLORS.length];
      const at = squadMarker(sq, toX, toY, px, py);
      if (!at) return;
      if (Number.isFinite(sq.order?.x)) {
        const ox = toX(sq.order.x);
        const oy = toY(sq.order.y);
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(at.x, at.y);
        g.lineTo(ox, oy);
        g.stroke();
        g.setLineDash([]);
        g.beginPath();
        g.arc(ox, oy, 4, 0, Math.PI * 2);
        g.stroke();
      }
      const big = state.squad === sq.id;
      g.fillStyle = INK;
      g.beginPath();
      g.arc(at.x, at.y, big ? 10 : 8, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = color;
      g.beginPath();
      g.arc(at.x, at.y, big ? 8 : 6.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK;
      g.font = 'bold 10px monospace';
      g.textAlign = 'center';
      g.fillText(String(i + 1), at.x, at.y + 3.5);
    });
    // The place you picked.
    if (state.point) {
      const x = toX(state.point.x);
      const y = toY(state.point.y);
      g.strokeStyle = INK;
      g.lineWidth = 4;
      cross(g, x, y);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      cross(g, x, y);
    }
  }

  /** Where a squad's marker sits on the canvas (a little aside if you stand there). */
  function squadMarker(sq, toX, toY, px, py) {
    if (sq.x == null) return null;
    let x = toX(sq.x);
    let y = toY(sq.y);
    if ((x - px) ** 2 + (y - py) ** 2 < 144) {
      x += 12;
      y -= 8;
    }
    return { x, y };
  }

  // --- Panning, zooming, picking --------------------------------------------------------------------

  const pointers = new Map();
  let pinch = 0;
  let moved = false;
  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.clientWidth / rect.width || 1;
    const sy = canvas.clientHeight / rect.height || 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };
  const worldAt = (lx, ly) => {
    const { w, hh } = size();
    return { x: state.cx + (lx - w / 2) / state.zoom, y: state.cy + (ly - hh / 2) / state.zoom };
  };
  function setZoom(zm, at = null) {
    const before = at ? worldAt(at.x, at.y) : null;
    state.zoom = Math.max(0.35, Math.min(8, zm));
    lastZoom = state.zoom;
    if (before) {
      const after = worldAt(at.x, at.y);
      state.cx += before.x - after.x;
      state.cy += before.y - after.y;
    }
    refresh();
    schedule();
  }
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) setZoom(state.zoom * (d / pinch), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      pinch = d;
      moved = true;
      return;
    }
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) {
      pointers.set(e.pointerId, prev);
      return;
    }
    moved = true;
    state.cx -= dx / state.zoom;
    state.cy -= dy / state.zoom;
    schedule();
  });
  const up = (e) => {
    const tap = pointers.size === 1 && !moved;
    const at = pointers.get(e.pointerId) ?? local(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (moved && !pointers.size) rerender();
    if (tap) pick(at.x, at.y);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinch = 0;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY > 0 ? 0.85 : 1.18), local(e));
  }, { passive: false });

  /** A tap on the map: a squad's marker picks the squad; anywhere else is the place for its orders. */
  function pick(lx, ly) {
    const { w, hh } = size();
    const toX = (x) => (x - state.cx) * state.zoom + w / 2;
    const toY = (y) => (y - state.cy) * state.zoom + hh / 2;
    const px = toX(view.player.x);
    const py = toY(view.player.y);
    for (const sq of view.squads) {
      const at = squadMarker(sq, toX, toY, px, py);
      if (at && (at.x - lx) ** 2 + (at.y - ly) ** 2 < 14 * 14) {
        state.squad = sq.id;
        rerender();
        return;
      }
    }
    const at = worldAt(lx, ly);
    state.point = at;
    state.key = regionAt(game.world, game.data, at.x, at.y)?.key ?? null;
    rerender();
  }

  // --- The side: what is at the picked place, and the squads ---------------------------------------------

  function pointBox() {
    const T = t();
    if (!state.point) return h('div.strategy-cell', h('p.small.muted', T.pick));
    const c = state.key ? view.territories.list.find((x) => x.key === state.key) : null;
    const sq = view.squads.find((s) => s.id === state.squad);
    const away = Math.round(Math.hypot(state.point.x - view.player.x, state.point.y - view.player.y));
    let label = T.wild;
    if (c?.home) label = T.home;
    else if (c) {
      label = c.status === 'foreign' ? `${T.foreign} ${c.ownerName ?? '?'}${c.base ? ` (${T.tiers[c.base] ?? c.base})` : ''}` : T[c.status] ?? c.status;
    }
    const buttons = [];
    if (sq) {
      const go = (kind, target) => buttons.push(h('button.small', { onclick: () => act('order', { squad: sq.id, kind, ...target }) }, orderName(kind)));
      if (c?.site && c.status !== 'own' && c.status !== 'attacked') go('attack', { key: c.key });
      if (c?.site && (c.status === 'own' || c.status === 'attacked')) {
        go('defend', { key: c.key });
        go('patrol', { key: c.key });
      }
      const spot = game.world?.findFreeSpot?.(state.point.x, state.point.y, 0.4) ?? state.point;
      buttons.push(h('button.small', { onclick: () => act('order', { squad: sq.id, kind: 'move', x: spot.x, y: spot.y }) }, T.move));
    }
    return h('div.strategy-cell',
      h('b', label),
      h('span.small.muted', ` · ${away} ${T.away}${c?.site ? ` · ${T.strength} ${'★'.repeat(c.tier)}` : ''}`),
      sq ? h('div.row', h('span.small', `${sq.name}:`), buttons) : h('p.small.muted', T.pickSquad));
  }

  function squadCard(sq, i) {
    const T = t();
    const hp = sq.members.reduce((a, m) => a + Math.max(0, m.hp), 0);
    const max = sq.members.reduce((a, m) => a + m.maxHp, 0) || 1;
    const selected = state.squad === sq.id;
    return h(`div.squad-card${selected ? '.selected' : ''}`, { 'data-squad': sq.id },
      h('div.row',
        h('span.squad-dot', { style: { background: SQUAD_COLORS[i % SQUAD_COLORS.length] } }, String(i + 1)),
        h('button.link', {
          onclick: () => {
            state.squad = sq.id;
            if (sq.x != null) {
              state.cx = sq.x;
              state.cy = sq.y;
            }
            rerender();
          },
        }, h('b', sq.name)),
        h('span.small.muted', `· ${sq.members.length} ${T.members}`),
        h('span.spacer'),
        h('button.small.btn-danger', { onclick: () => act('squad-disband', { squad: sq.id }) }, T.disband)),
      h('div.meter.small', h('div', { style: { width: `${(100 * hp) / max}%` } })),
      h('p.small', sq.doing),
      h('div.row',
        ['follow', 'hold', 'retreat'].map((k) => h('button.small', { onclick: () => act('order', { squad: sq.id, kind: k }) }, orderName(k))),
        h('label.small', `${T.stance}: `,
          h('select', { onchange: (e) => act('stance', { squad: sq.id, stance: e.target.value }) },
            STANCES.map((s) => h('option', { value: s, selected: s === sq.stance }, stanceName(s)))))));
  }

  function side() {
    const T = t();
    return [
      pointBox(),
      h('h3', T.squads),
      ...(view.squads.length ? view.squads.map(squadCard) : [h('p.small.muted', T.noSquads)]),
      h('button', { disabled: !view.canCreateSquad, onclick: () => act('squad-create', {}) }, icon('flag', 18), T.newSquad),
    ];
  }

  // --- Below: factions, soldiers, recruits -----------------------------------------------------------------

  function soldierRow(s) {
    const T = t();
    const gear = view.gear(s);
    return h('div.soldier-row', { 'data-soldier': s.id },
      h('div.worker-info',
        h('b', s.name),
        h('span.small.muted', `${s.roleName} · ${T.rank} ${s.rank} · ${T.gear} ${s.gear}${s.training ? ` · ${T.training} (${s.trainLeft} s)` : ''}`),
        s.maxHp ? h('div.meter.small', h('div', { style: { width: `${Math.max(0, (100 * s.hp) / s.maxHp)}%` } })) : null),
      h('span.spacer'),
      s.training ? null : h('label.small', `${T.squad}: `,
        h('select', { onchange: (e) => act('assign', { soldier: s.id, squad: Number(e.target.value) }) },
          h('option', { value: 0, selected: !s.squad }, T.none),
          view.squads.map((sq) => h('option', { value: sq.id, selected: sq.id === s.squad }, sq.name)))),
      s.training ? null : gear.next
        ? h('button.small', { disabled: Boolean(gear.problem), title: gear.problem ?? '', onclick: () => act('gear', { id: s.id }) },
          icon('up', 14), `${T.gear} ${gear.next.level}`, costChips(gear.next.cost))
        : h('span.small.muted', T.bestGear),
      s.training ? null : h('button.small', { onclick: () => act('muster', { id: s.id }) }, T.back));
  }

  function recruitRow(w) {
    const T = t();
    return h('div.soldier-row', { 'data-recruit': w.id },
      h('div.worker-info', h('b', w.name), h('span.small.muted', w.roleName)),
      h('span.spacer'),
      h('div.row.wrap', view.roles.map((r) => {
        const problem = view.trainProblem(w.id, r.id);
        return h('button.small', { disabled: Boolean(problem), title: problem ?? r.desc ?? '', onclick: () => act('train', { id: w.id, role: r.id }) },
          `${T.train}: ${view.lang === 'sv' ? r.sv ?? r.name : r.name}`, costChips(r.cost));
      })));
  }

  function factionsBox() {
    const T = t();
    const fx = view.factions;
    if (!fx?.list?.length) return null;
    const pers = (k) => (view.lang === 'sv' ? PERSONALITY_NAMES_SV : PERSONALITY_NAMES)[k] ?? k;
    const coming = fx.armies.filter((a) => a.toMe).length;
    return h('section.strategy-factions',
      h('h3', T.factions),
      h('div.faction-list', fx.list.map((f) => h(`div.faction-row${f.alive ? '' : '.fallen'}`,
        h('span.squad-dot', { style: { background: f.color } }, ''),
        f.alive && f.at
          ? h('button.link', { onclick: () => { state.cx = f.at.x; state.cy = f.at.y; rerender(); } }, h('b', f.name))
          : h('b', f.name),
        h('span.small.muted', f.alive ? ` · ${pers(f.personality)} · ${T.ai} ${'★'.repeat(f.quality)} · ${f.squares} ${T.squares}` : ` · ${T.fallen}`)))),
      fx.armies.length ? h('p.small', `${fx.armies.length} ${T.armies}${coming ? ` (${coming} ${T.toYou})` : ''}.`) : null);
  }

  function lists() {
    const T = t();
    return [
      factionsBox(),
      h('h3', `${T.soldiers} (${T.barracks} ${view.barracks.used} / ${view.barracks.cap})`),
      view.soldiers.length ? h('div.worker-list', view.soldiers.map(soldierRow)) : h('p.small.muted', T.noSoldiers),
      h('h3', T.recruits),
      view.recruits.length ? h('div.worker-list', view.recruits.map(recruitRow)) : h('p.small.muted', T.noRecruits),
    ].filter(Boolean);
  }

  refresh();
  const T = t();
  const body = h('div.strategy',
    h('div.strategy-top',
      h('div.strategy-mapbox',
        h('div.map-tools',
          h('button.icon-btn', { 'aria-label': T.zoomOut, onclick: () => setZoom(state.zoom / 1.4) }, '−'),
          h('button.icon-btn', { 'aria-label': T.zoomIn, onclick: () => setZoom(state.zoom * 1.4) }, '+'),
          h('button', { onclick: () => { state.cx = game.player.x; state.cy = game.player.y; rerender(); } }, icon('portal', 18), T.me),
          h('button', {
            onclick: () => {
              const b = game.mapHome?.() ?? { x: 0.5, y: 0.5 };
              state.cx = b.x;
              state.cy = b.y;
              rerender();
            },
          }, icon('home', 18), T.camp)),
        canvas,
        legendEl),
      sideEl),
    listsEl);
  openModal({
    title: T.title, icon: 'flag', body, className: 'wide strategy-panel',
    onDispose: () => {
      clearInterval(timer);
      cancelAnimationFrame(raf);
      removeEventListener('resize', schedule);
      off?.();
    },
  });
  rerender();
  // The map moves on while it is open (soldiers march, armies too).
  timer = setInterval(() => {
    refresh();
    schedule();
  }, 500);
  addEventListener('resize', schedule);
  const off = game.on?.('army', () => rerender());
}

// --- Map symbols ---------------------------------------------------------------------------------------

function text(g, s, x, y, color) {
  g.font = '12px "Pixelify Sans", monospace';
  g.textAlign = 'center';
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.strokeText(s, x, y);
  g.fillStyle = color;
  g.fillText(s, x, y);
}

function diamond(g, x, y, r, color) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.fill();
}

function cross(g, x, y) {
  g.beginPath();
  g.arc(x, y, 7, 0, Math.PI * 2);
  g.moveTo(x - 11, y);
  g.lineTo(x - 4, y);
  g.moveTo(x + 4, y);
  g.lineTo(x + 11, y);
  g.moveTo(x, y - 11);
  g.lineTo(x, y - 4);
  g.moveTo(x, y + 4);
  g.lineTo(x, y + 11);
  g.stroke();
}

/** An outpost's flag in its holder's colour. */
function drawFlag(g, x, y, r, color) {
  g.fillStyle = INK;
  g.fillRect(x - 2, y - r - 2, 3, r * 2 + 2);
  g.fillRect(x, y - r - 2, r + 3, r * 0.9 + 2);
  g.fillStyle = '#d8c8a8';
  g.fillRect(x - 1, y - r - 1, 1, r * 2);
  g.fillStyle = color;
  g.fillRect(x + 1, y - r - 1, r + 1, r * 0.9);
}

/** A faction's base: a camp is a tent, a stronghold a tower, the headquarters a castle. */
function drawBase(g, x, y, r, tier, color) {
  g.lineWidth = 2;
  g.strokeStyle = INK;
  g.fillStyle = color;
  if (tier === 'camp') {
    g.beginPath();
    g.moveTo(x - r, y + r * 0.7);
    g.lineTo(x, y - r);
    g.lineTo(x + r, y + r * 0.7);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = INK;
    g.fillRect(x - 1.5, y, 3, r * 0.7);
    return;
  }
  const wide = tier === 'hq' ? r * 1.3 : r * 0.7;
  const top = y - r * (tier === 'hq' ? 0.6 : 1);
  g.fillRect(x - wide, top, wide * 2, y + r * 0.8 - top);
  g.strokeRect(x - wide, top, wide * 2, y + r * 0.8 - top);
  // Battlements.
  const n = tier === 'hq' ? 4 : 2;
  const step = (wide * 2) / (n * 2 - 1);
  for (let i = 0; i < n; i++) {
    g.fillRect(x - wide + i * step * 2, top - 3, step, 3);
    g.strokeRect(x - wide + i * step * 2, top - 3, step, 3);
  }
  g.fillStyle = INK;
  g.fillRect(x - 2, y + r * 0.8 - 5, 4, 5);
  if (tier === 'hq') {
    g.fillRect(x - 1, top - r * 0.9, 2, r * 0.9);
    g.fillStyle = '#ffd24a';
    g.fillRect(x + 1, top - r * 0.9, r * 0.7, r * 0.4);
  }
}

function drawCamp(g, x, y, r) {
  g.fillStyle = HOME;
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x, y - r - 2);
  g.lineTo(x + r, y);
  g.lineTo(x + r - 2, y + r);
  g.lineTo(x - r + 2, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.fill();
  g.stroke();
}
