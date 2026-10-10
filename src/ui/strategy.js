// The strategy map (N): the territories around you from above (who holds
// what, outposts, fights), your squads on it, and their orders. Pick a
// squad, then a square: attack it, defend it, patrol it or move there.
// Below the map: the squads, your soldiers (gear, squad) and recruits to
// train. Works the same in single player and multiplayer: the game gives
// strategyView() and armyAction() (campaign.js / server/army.js).

import { h } from './dom.js';
import { icon, costChips } from './icons.js';
import { openModal, replaceModalBody } from './modal.js';
import { ORDER_NAMES, ORDER_NAMES_SV, STANCES, STANCE_NAMES, STANCE_NAMES_SV } from '../game/army.js';
import { PERSONALITY_NAMES, PERSONALITY_NAMES_SV } from '../game/factions.js';

const BIOME = {
  plains: '#4f9a44', forest: '#3c7437', desert: '#d8bc78', snow: '#dfe8f2', volcanic: '#4a4450', highlands: '#6e8f5a',
  void: '#3a2a52', isles: '#5fb050', prism: '#d8d0e6', fen: '#2f6a62', skyreach: '#bccde4',
};
const SQUAD_COLORS = ['#ffd24a', '#7ae0ff', '#ff8a5a', '#c09aff', '#8ef0a0', '#ff7ad8'];

const TEXT = {
  en: {
    title: 'Strategy map', squads: 'Squads', soldiers: 'Soldiers', recruits: 'Train recruits', newSquad: 'New squad',
    noSquads: 'No squads yet. Make one, then put soldiers in it.', noSoldiers: 'No soldiers yet: train workers at the Training Grounds below.',
    noRecruits: 'No workers to train. Hire some at the Workers’ Lodge.', pick: 'Pick a squad, then a square on the map.',
    pickSquad: 'Pick a squad first (tap it in the list or on the map).', none: '(none)', disband: 'Disband', back: 'Back to work',
    gear: 'Gear', rank: 'Rank', train: 'Train', barracks: 'Barracks', squad: 'Squad', stance: 'Stance', hp: 'Health',
    own: 'Yours', neutral: 'Neutral', foreign: 'Held by others', contested: 'Contested', attacked: 'Under attack', home: 'Your camp', empty: 'No outpost (sea or rough land)',
    tier: 'Tier', move: 'Move here', legend: 'Green: yours · grey flag: neutral · red: someone else’s · yellow: being taken · flashing: under attack',
    training: 'training', bestGear: 'best gear', squadOf: 'in', members: 'soldiers', zoomIn: 'Closer', zoomOut: 'Further',
    factions: 'Factions', squares: 'squares', ai: 'cunning', fallen: 'fallen', armies: 'armies on the march near you', toYou: 'coming for your land',
  },
  sv: {
    title: 'Strategikarta', squads: 'Trupper', soldiers: 'Soldater', recruits: 'Träna rekryter', newSquad: 'Ny trupp',
    noSquads: 'Inga trupper än. Skapa en och sätt soldater i den.', noSoldiers: 'Inga soldater än: träna arbetare vid träningsplatsen nedan.',
    noRecruits: 'Inga arbetare att träna. Anställ vid arbetarstugan.', pick: 'Välj en trupp och sedan en ruta på kartan.',
    pickSquad: 'Välj en trupp först (i listan eller på kartan).', none: '(ingen)', disband: 'Upplös', back: 'Tillbaka till jobbet',
    gear: 'Utrustning', rank: 'Grad', train: 'Träna', barracks: 'Kasern', squad: 'Trupp', stance: 'Hållning', hp: 'Hälsa',
    own: 'Er', neutral: 'Neutral', foreign: 'Någon annans', contested: 'Omstridd', attacked: 'Under attack', home: 'Er bas', empty: 'Ingen utpost (hav eller oländig mark)',
    tier: 'Nivå', move: 'Flytta hit', legend: 'Grön: er · grå flagga: neutral · röd: någon annans · gul: tas just nu · blinkar: under attack',
    training: 'tränar', bestGear: 'bästa utrustning', squadOf: 'i', members: 'soldater', zoomIn: 'Närmare', zoomOut: 'Längre ut',
    factions: 'Fraktioner', squares: 'rutor', ai: 'list', fallen: 'fallen', armies: 'arméer på marsch nära er', toYou: 'på väg mot er mark',
  },
};

export function open(game) {
  const state = { radius: 3, cx: null, cy: null, squad: null, cell: null };
  let view = null;
  let canvas = null;
  let timer = null;

  const t = () => TEXT[view?.lang === 'sv' ? 'sv' : 'en'];
  const orderName = (k) => (view?.lang === 'sv' ? ORDER_NAMES_SV : ORDER_NAMES)[k] ?? k;
  const stanceName = (k) => (view?.lang === 'sv' ? STANCE_NAMES_SV : STANCE_NAMES)[k] ?? k;

  function refresh() {
    if (state.cx == null) {
      const here = game.strategyView(0, 0, 0).here;
      state.cx = here.tx;
      state.cy = here.ty;
    }
    view = game.strategyView(state.cx, state.cy, state.radius);
  }

  async function act(op, args) {
    const problem = await game.armyAction(op, args);
    if (problem) game.toast(problem, 'warn');
    rerender();
    return problem;
  }

  function rerender() {
    const body = document.querySelector('.strategy-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    refresh();
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  }

  // --- The map ------------------------------------------------------------------------------------

  function cellPx() {
    return Math.max(34, Math.min(64, Math.floor(420 / (state.radius * 2 + 1))));
  }

  function draw() {
    if (!canvas || !view) return;
    const R = state.radius;
    const n = R * 2 + 1;
    const cell = cellPx();
    canvas.width = n * cell;
    canvas.height = n * cell;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    const size = view.size;
    const toPx = (x, y) => [((x / size) + 0.5 - (state.cx - R)) * cell, ((y / size) + 0.5 - (state.cy - R)) * cell];
    for (const c of view.territories) {
      const x = (c.tx - state.cx + R) * cell;
      const y = (c.ty - state.cy + R) * cell;
      g.fillStyle = c.site ? BIOME[c.site.biome] ?? '#4f9a44' : c.home ? '#8a7f70' : '#2f6fa8';
      g.fillRect(x, y, cell, cell);
      g.fillStyle = 'rgba(10, 8, 20, 0.28)';
      g.fillRect(x, y, cell, cell);
      const tint = { own: 'rgba(63, 168, 106, 0.42)', home: 'rgba(255, 210, 74, 0.28)', foreign: 'rgba(200, 54, 74, 0.42)', attacked: 'rgba(255, 60, 60, 0.45)', contested: 'rgba(255, 210, 74, 0.32)' }[c.status];
      if (c.status === 'foreign' && c.color) {
        // Someone else's: in their colour.
        g.globalAlpha = 0.45;
        g.fillStyle = c.color;
        g.fillRect(x, y, cell, cell);
        g.globalAlpha = 1;
      } else if (tint && (c.status !== 'attacked' || blink)) {
        g.fillStyle = tint;
        g.fillRect(x, y, cell, cell);
      }
      g.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      g.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      const border = { own: '#3fa86a', home: '#ffd24a', foreign: c.color ?? '#c8364a', attacked: '#ff5050', contested: '#ffd24a' }[c.status];
      if (border) {
        g.strokeStyle = border;
        g.lineWidth = 2;
        g.strokeRect(x + 2, y + 2, cell - 4, cell - 4);
        g.lineWidth = 1;
      }
      // The outpost: a flag in its holder's colour, and pips for its tier.
      if (c.site) {
        const [fx, fy] = toPx(c.site.x, c.site.y);
        g.fillStyle = '#161622';
        g.fillRect(fx - 1, fy - 9, 2, 10);
        g.fillStyle = c.status === 'own' || c.status === 'attacked' ? '#3fa86a' : c.status === 'foreign' ? c.color ?? '#c8364a' : '#d8d8e4';
        g.fillRect(fx + 1, fy - 9, 6, 4);
        for (let i = 0; i < c.tier; i++) {
          g.fillStyle = '#ffd24a';
          g.fillRect(x + 4 + i * 4, y + 4, 2, 2);
        }
        if (c.capture > 0 && c.capture < 1) {
          g.fillStyle = '#161622';
          g.fillRect(x + 4, y + cell - 8, cell - 8, 4);
          g.fillStyle = '#ffd24a';
          g.fillRect(x + 4, y + cell - 8, (cell - 8) * c.capture, 4);
        }
      }
      if (c.home) {
        g.fillStyle = '#ffd24a';
        const [hx, hy] = toPx(0, 0);
        g.fillRect(hx - 4, hy - 2, 8, 6);
        g.fillRect(hx - 2, hy - 5, 4, 3);
      }
      if (state.cell && state.cell.tx === c.tx && state.cell.ty === c.ty) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
        g.lineWidth = 1;
      }
    }
    // Factions' armies on the march (close to you or your land), a line to where they head.
    for (const a of view.factions?.armies ?? []) {
      const [ax, ay] = toPx(a.x, a.y);
      const tk = a.to.split(',').map(Number);
      const target = view.territories.find((c) => c.tx === tk[0] && c.ty === tk[1]);
      if (target?.site) {
        const [tx2, ty2] = toPx(target.site.x, target.site.y);
        g.strokeStyle = a.toMe ? '#ff5050' : a.color;
        g.setLineDash([2, 3]);
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(tx2, ty2);
        g.stroke();
        g.setLineDash([]);
      }
      g.fillStyle = '#161622';
      g.beginPath();
      g.moveTo(ax, ay - 8);
      g.lineTo(ax + 8, ay);
      g.lineTo(ax, ay + 8);
      g.lineTo(ax - 8, ay);
      g.fill();
      g.fillStyle = a.color ?? '#c8364a';
      g.beginPath();
      g.moveTo(ax, ay - 6);
      g.lineTo(ax + 6, ay);
      g.lineTo(ax, ay + 6);
      g.lineTo(ax - 6, ay);
      g.fill();
      g.fillStyle = '#161622';
      g.font = 'bold 8px monospace';
      g.textAlign = 'center';
      g.fillText(String(a.troops), ax, ay + 3);
    }
    // You (under your squads' markers).
    const [px, py] = toPx(view.player.x, view.player.y);
    g.fillStyle = '#161622';
    g.fillRect(px - 4, py - 4, 8, 8);
    g.fillStyle = '#ffffff';
    g.fillRect(px - 3, py - 3, 6, 6);
    // Squads, with a line to where they are headed (a little aside, so you show).
    view.squads.forEach((sq, i) => {
      if (sq.x == null) return;
      let [sx, sy] = toPx(sq.x, sq.y);
      if ((sx - px) ** 2 + (sy - py) ** 2 < 100) {
        sx += 9;
        sy -= 6;
      }
      const color = SQUAD_COLORS[i % SQUAD_COLORS.length];
      if (Number.isFinite(sq.order?.x)) {
        const [ox, oy] = toPx(sq.order.x, sq.order.y);
        g.strokeStyle = color;
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(ox, oy);
        g.stroke();
        g.setLineDash([]);
      }
      g.fillStyle = '#161622';
      g.beginPath();
      g.arc(sx, sy, state.squad === sq.id ? 8 : 6.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = color;
      g.beginPath();
      g.arc(sx, sy, state.squad === sq.id ? 6.5 : 5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#161622';
      g.font = 'bold 9px monospace';
      g.textAlign = 'center';
      g.fillText(String(i + 1), sx, sy + 3);
    });
  }

  function onMapClick(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const cell = cellPx();
    const R = state.radius;
    // A squad marker?
    const size = view.size;
    for (const sq of view.squads) {
      if (sq.x == null) continue;
      const sx = ((sq.x / size) + 0.5 - (state.cx - R)) * cell;
      const sy = ((sq.y / size) + 0.5 - (state.cy - R)) * cell;
      if ((sx - mx) ** 2 + (sy - my) ** 2 < 11 * 11) {
        state.squad = sq.id;
        rerender();
        return;
      }
    }
    state.cell = { tx: state.cx - R + Math.floor(mx / cell), ty: state.cy - R + Math.floor(my / cell) };
    rerender();
  }

  // --- Panels -------------------------------------------------------------------------------------

  function cellBox() {
    const T = t();
    if (!state.cell) return h('p.small.muted', T.pick);
    const c = view.territories.find((x) => x.tx === state.cell.tx && x.ty === state.cell.ty);
    if (!c) return null;
    const sq = view.squads.find((s) => s.id === state.squad);
    const label = c.home ? T.home : !c.site ? T.empty : `${T[c.status] ?? c.status}${c.ownerName ? ` (${c.ownerName})` : ''} · ${T.tier} ${c.tier}`;
    const buttons = [];
    if (sq) {
      const go = (kind, target) => buttons.push(h('button.small', { onclick: () => act('order', { squad: sq.id, kind, ...target }) }, orderName(kind)));
      if (c.site && c.status !== 'own' && c.status !== 'attacked') go('attack', { key: c.key });
      if (c.site && (c.status === 'own' || c.status === 'attacked')) {
        go('defend', { key: c.key });
        go('patrol', { key: c.key });
      }
      const x = c.site ? c.site.x : c.tx * view.size;
      const y = c.site ? c.site.y + 7 : c.ty * view.size;
      buttons.push(h('button.small', { onclick: () => act('order', { squad: sq.id, kind: 'move', x, y }) }, T.move));
    }
    return h('div.strategy-cell',
      h('b', label),
      c.site?.biome ? h('span.small.muted', ` · ${c.site.biome}`) : null,
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
        h('button.link', { onclick: () => { state.squad = sq.id; rerender(); } }, h('b', sq.name)),
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
        h('b', f.name),
        h('span.small.muted', f.alive ? ` · ${pers(f.personality)} · ${T.ai} ${'★'.repeat(f.quality)} · ${f.squares} ${T.squares}` : ` · ${T.fallen}`)))),
      fx.armies.length ? h('p.small', `${fx.armies.length} ${T.armies}${coming ? ` (${coming} ${T.toYou})` : ''}.`) : null);
  }

  function build() {
    const T = t();
    canvas = h('canvas.strategy-map', { onclick: onMapClick, 'aria-label': T.title });
    requestAnimationFrame(draw);
    const pan = (dx, dy) => () => {
      state.cx += dx;
      state.cy += dy;
      rerender();
    };
    const zoom = (d) => () => {
      state.radius = Math.max(2, Math.min(5, state.radius + d));
      rerender();
    };
    return h('div.strategy',
      h('div.strategy-top',
        h('div.strategy-mapbox',
          canvas,
          h('div.row.strategy-nav',
            h('button.small', { onclick: pan(-1, 0), 'aria-label': 'West' }, '◀'),
            h('button.small', { onclick: pan(0, -1), 'aria-label': 'North' }, '▲'),
            h('button.small', { onclick: pan(0, 1), 'aria-label': 'South' }, '▼'),
            h('button.small', { onclick: pan(1, 0), 'aria-label': 'East' }, '▶'),
            h('button.small', { onclick: zoom(-1) }, T.zoomIn),
            h('button.small', { onclick: zoom(1) }, T.zoomOut)),
          h('p.small.muted', T.legend)),
        h('div.strategy-side',
          cellBox(),
          h('h3', T.squads),
          view.squads.length ? view.squads.map(squadCard) : h('p.small.muted', T.noSquads),
          h('button', { disabled: !view.canCreateSquad, onclick: () => act('squad-create', {}) }, icon('flag', 18), T.newSquad))),
      factionsBox(),
      h('h3', `${T.soldiers} (${T.barracks} ${view.barracks.used} / ${view.barracks.cap})`),
      view.soldiers.length ? h('div.worker-list', view.soldiers.map(soldierRow)) : h('p.small.muted', T.noSoldiers),
      h('h3', T.recruits),
      view.recruits.length ? h('div.worker-list', view.recruits.map(recruitRow)) : h('p.small.muted', T.noRecruits));
  }

  refresh();
  openModal({
    title: t().title, icon: 'flag', body: build(), className: 'wide strategy-panel',
    onDispose: () => {
      clearInterval(timer);
      off?.();
    },
  });
  // The map moves on while it is open (multiplayer, or when the game runs behind it).
  timer = setInterval(() => {
    refresh();
    draw();
  }, 500);
  const off = game.on?.('army', () => rerender());
}
