// World map: everything you have explored, with markers for the hotspots
// (camp, bosses, markets, shrines, chests, your Waystone return point) and
// pins you place yourself. Drag to pan, wheel/pinch or +/− to zoom.

import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { CHUNK, T } from '../game/world.js';

const COLORS = {
  [T.GRASS]: '#4f9a44', [T.FLOWERS]: '#58a24a', [T.MOSS]: '#3c7437', [T.SAND]: '#e3c886', [T.SAND2]: '#dcbf7a',
  [T.SNOW]: '#eef4fa', [T.ICE]: '#b8e0f4', [T.ASH]: '#4a4450', [T.BASALT]: '#3a3640', [T.ROCKGRASS]: '#6e8f5a',
  [T.VOIDSTONE]: '#2e2440', [T.VOIDMOSS]: '#3a2a52', [T.CAMP]: '#8a7f70', [T.PATH]: '#b89a6a',
  [T.WATER]: '#3f7fd0', [T.LAVA]: '#ff6a2a', [T.TREE]: '#2f6e2c', [T.PINE]: '#2a5a3a', [T.ROCK]: '#8d8a9e',
  [T.CACTUS]: '#5f9a40', [T.CRYSTAL]: '#9a5cff',
};

// Chunk images (1 px per tile), kept for the session.
const chunkImages = new Map();

function chunkImage(world, cx, cy) {
  const key = `${world.seed}:${cx},${cy}`;
  let c = chunkImages.get(key);
  if (c) return c;
  const chunk = world.getChunk(cx, cy);
  c = document.createElement('canvas');
  c.width = c.height = CHUNK;
  const g = c.getContext('2d');
  const img = g.createImageData(CHUNK, CHUNK);
  for (let i = 0; i < CHUNK * CHUNK; i++) {
    const hex = COLORS[chunk.block[i] || chunk.ground[i]] ?? '#4f9a44';
    const n = parseInt(hex.slice(1), 16);
    img.data[i * 4] = n >> 16;
    img.data[i * 4 + 1] = (n >> 8) & 255;
    img.data[i * 4 + 2] = n & 255;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  chunkImages.set(key, c);
  return c;
}

export function open(game) {
  const { world, save, data } = game;
  const p = game.player;
  let zoom = 3; // screen px per tile
  let cx = p.x;
  let cy = p.y;
  let pinMode = false;
  const canvas = h('canvas.map-canvas', { 'aria-label': 'World map' });
  const status = h('span.map-status.small.muted');
  const pinBtn = h('button', { 'aria-pressed': 'false' }, icon('pin', 20), 'Pin');
  const legend = h('div.map-legend.small',
    h('span', h('i.lg.you'), 'You'), h('span', h('i.lg.camp'), 'Camp'), h('span', h('i.lg.boss'), 'Boss'),
    h('span', h('i.lg.market'), 'Market'), h('span', h('i.lg.shrine'), 'Shrine'), h('span', h('i.lg.chest'), 'Chest'),
    h('span', h('i.lg.pin'), 'Your pins'));

  const markers = () => {
    const out = [{ kind: 'camp', x: 0.5, y: 0.5, label: 'Camp' }];
    for (const lm of world.landmarks) {
      const boss = data.byId.bosses.get(lm.bossId);
      const known = game.explored.has(`${Math.floor(lm.x / CHUNK)},${Math.floor(lm.y / CHUNK)}`);
      out.push({ kind: 'boss', x: lm.x, y: lm.y, color: boss.color, done: Boolean(save.bosses.defeated[lm.bossId]), faded: !known, label: boss.name });
    }
    for (const [id, st] of Object.entries(save.markets)) {
      if (!st.seen && !st.visited) continue;
      const m = world.marketById(id);
      if (m) out.push({ kind: 'market', x: m.x + 0.5, y: m.y + 0.5, color: m.color, label: m.name });
    }
    // Shrines and unopened chests in explored areas that are in memory.
    for (const key of game.explored) {
      const chunk = world.chunks.get(key);
      if (!chunk) continue;
      for (const o of chunk.objects) {
        if (o.type === 'shrine' && !save.world.shrines.includes(o.key)) out.push({ kind: 'shrine', x: o.x, y: o.y, label: 'Shrine' });
        if (o.type === 'chest' && !save.world.chests.includes(o.key)) out.push({ kind: 'chest', x: o.x, y: o.y, label: 'Chest' });
      }
    }
    if (save.base.recall) out.push({ kind: 'portal', x: save.base.recall.x, y: save.base.recall.y, label: 'Waystone return point' });
    save.world.pins.forEach((pin, i) => out.push({ kind: 'pin', x: pin.x, y: pin.y, index: i, label: pin.label || 'Pin' }));
    return out;
  };

  let pending = [];
  let raf = 0;

  function draw() {
    raf = 0;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(hgt * dpr)) canvas.height = Math.round(hgt * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0a12';
    g.fillRect(0, 0, w, hgt);
    const toX = (x) => (x - cx) * zoom + w / 2;
    const toY = (y) => (y - cy) * zoom + hgt / 2;
    // Explored chunks (generate a few per frame, then keep them).
    const c0 = Math.floor((cx - w / 2 / zoom) / CHUNK) - 1;
    const c1 = Math.floor((cx + w / 2 / zoom) / CHUNK) + 1;
    const r0 = Math.floor((cy - hgt / 2 / zoom) / CHUNK) - 1;
    const r1 = Math.floor((cy + hgt / 2 / zoom) / CHUNK) + 1;
    let built = 0;
    pending = [];
    for (let ry = r0; ry <= r1; ry++) {
      for (let rx = c0; rx <= c1; rx++) {
        if (!game.explored.has(`${rx},${ry}`)) continue;
        const cached = chunkImages.get(`${world.seed}:${rx},${ry}`);
        if (!cached && built >= 12) {
          pending.push(1);
          continue;
        }
        if (!cached) built += 1;
        g.drawImage(chunkImage(world, rx, ry), toX(rx * CHUNK), toY(ry * CHUNK), CHUNK * zoom + 0.5, CHUNK * zoom + 0.5);
      }
    }
    // Your camp's structures.
    g.fillStyle = '#3a2e22';
    for (const st of save.base.structures) {
      if (st.def?.walkable) continue;
      g.fillRect(toX(st.x), toY(st.y), Math.max(1, zoom), Math.max(1, zoom));
    }
    // Markers.
    const r = Math.max(4, Math.min(9, zoom * 1.5));
    for (const mk of markers()) {
      const x = toX(mk.x);
      const y = toY(mk.y);
      if (x < -20 || y < -20 || x > w + 20 || y > hgt + 20) continue;
      g.globalAlpha = mk.faded ? 0.45 : 1;
      g.lineWidth = 2;
      g.strokeStyle = '#0e0c18';
      switch (mk.kind) {
        case 'camp':
          g.fillStyle = '#ffd24a';
          g.beginPath();
          g.moveTo(x, y - r - 2);
          g.lineTo(x + r, y);
          g.lineTo(x + r - 2, y + r);
          g.lineTo(x - r + 2, y + r);
          g.lineTo(x - r, y);
          g.closePath();
          g.fill();
          g.stroke();
          break;
        case 'boss':
          g.fillStyle = mk.done ? '#6a6a7a' : mk.color;
          g.beginPath();
          g.arc(x, y, r + 1, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          g.fillStyle = '#f3ecdc';
          g.fillRect(x - 3, y - 3, 6, 4);
          g.fillStyle = '#0e0c18';
          g.fillRect(x - 2, y - 2, 1, 1);
          g.fillRect(x + 1, y - 2, 1, 1);
          if (mk.done) {
            g.strokeStyle = '#f3ecdc';
            g.beginPath();
            g.moveTo(x - r, y - r);
            g.lineTo(x + r, y + r);
            g.stroke();
          }
          break;
        case 'market':
          g.fillStyle = '#ffd24a';
          g.fillRect(x - r, y - r, r * 2, r * 2);
          g.strokeRect(x - r, y - r, r * 2, r * 2);
          g.fillStyle = mk.color;
          g.fillRect(x - r + 2, y - r + 2, r * 2 - 4, 3);
          break;
        case 'shrine':
          g.fillStyle = '#7ae0ff';
          g.beginPath();
          g.moveTo(x, y - r);
          g.lineTo(x + r * 0.7, y);
          g.lineTo(x, y + r);
          g.lineTo(x - r * 0.7, y);
          g.closePath();
          g.fill();
          g.stroke();
          break;
        case 'chest':
          g.fillStyle = '#e0b040';
          g.fillRect(x - r * 0.7, y - r * 0.5, r * 1.4, r);
          g.strokeRect(x - r * 0.7, y - r * 0.5, r * 1.4, r);
          break;
        case 'portal':
          g.strokeStyle = '#cdb2ff';
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.stroke();
          break;
        case 'pin':
          g.fillStyle = '#e8364a';
          g.beginPath();
          g.arc(x, y - r, r * 0.8, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          g.beginPath();
          g.moveTo(x - 3, y - r + 2);
          g.lineTo(x, y + 2);
          g.lineTo(x + 3, y - r + 2);
          g.fill();
          break;
        default:
          break;
      }
      if (zoom >= 4 && mk.kind !== 'chest' && mk.kind !== 'shrine') {
        g.font = '12px "Pixelify Sans", monospace';
        g.textAlign = 'center';
        g.lineWidth = 3;
        g.strokeStyle = '#0e0c18';
        g.strokeText(mk.label, x, y + r + 13);
        g.fillStyle = '#f3ecdc';
        g.fillText(mk.label, x, y + r + 13);
      }
      g.globalAlpha = 1;
    }
    // You (blinking arrow).
    const px = toX(p.x);
    const py = toY(p.y);
    g.save();
    g.translate(px, py);
    g.rotate(p.facing);
    g.fillStyle = Math.floor(performance.now() / 400) % 2 ? '#ffffff' : '#ffd24a';
    g.strokeStyle = '#0e0c18';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(r + 3, 0);
    g.lineTo(-r, -r + 1);
    g.lineTo(-r + 3, 0);
    g.lineTo(-r, r - 1);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    status.textContent = `${game.explored.size} areas explored · ${Math.round(Math.hypot(p.x, p.y))} m from camp${pending.length ? ' · drawing…' : ''}`;
    if (pending.length) schedule();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  // --- Interaction ---------------------------------------------------------------------

  const pointers = new Map();
  let pinchDist = 0;
  let moved = false;
  const worldAt = (ex, ey) => {
    const rect = canvas.getBoundingClientRect();
    // Undo any transform on the panel (e.g. its opening animation's scale).
    const sx = canvas.offsetWidth / rect.width || 1;
    const sy = canvas.offsetHeight / rect.height || 1;
    return {
      x: cx + ((ex - rect.left - rect.width / 2) * sx) / zoom,
      y: cy + ((ey - rect.top - rect.height / 2) * sy) / zoom,
    };
  };
  const setZoom = (z, ax, ay) => {
    const before = ax !== undefined ? worldAt(ax, ay) : null;
    zoom = Math.max(0.75, Math.min(10, z));
    if (before) {
      const after = worldAt(ax, ay);
      cx += before.x - after.x;
      cy += before.y - after.y;
    }
    schedule();
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist) setZoom(zoom * (d / pinchDist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinchDist = d;
      moved = true;
      return;
    }
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    cx -= dx / zoom;
    cy -= dy / zoom;
    schedule();
  });
  const up = (e) => {
    const wasTap = pointers.size === 1 && !moved;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!wasTap || !pinMode) return;
    // Tap in pin mode: remove a pin under the finger, or place a new one.
    const at = worldAt(e.clientX, e.clientY);
    const hitR = 12 / zoom;
    const idx = save.world.pins.findIndex((pin) => Math.hypot(pin.x - at.x, pin.y - at.y + 6 / zoom) < hitR);
    if (idx >= 0) game.removePin(idx);
    else game.addPin(at.x, at.y);
    schedule();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY > 0 ? 0.85 : 1.18), e.clientX, e.clientY);
  }, { passive: false });

  pinBtn.addEventListener('click', () => {
    pinMode = !pinMode;
    pinBtn.setAttribute('aria-pressed', String(pinMode));
    pinBtn.classList.toggle('on', pinMode);
    canvas.classList.toggle('pinning', pinMode);
  });

  const body = h('div.map',
    h('div.map-tools',
      h('button.icon-btn', { 'aria-label': 'Zoom out', onclick: () => setZoom(zoom / 1.4) }, '−'),
      h('button.icon-btn', { 'aria-label': 'Zoom in', onclick: () => setZoom(zoom * 1.4) }, '+'),
      h('button', { onclick: () => { cx = p.x; cy = p.y; schedule(); } }, icon('portal', 20), 'Me'),
      h('button', { onclick: () => { cx = 0.5; cy = 0.5; schedule(); } }, icon('home', 20), 'Camp'),
      pinBtn,
      status),
    canvas,
    legend);

  const off = game.on('explored', schedule);
  const onResize = () => schedule();
  addEventListener('resize', onResize);
  openModal({
    title: 'Map', icon: 'map', body, className: 'wide map-panel',
    onDispose: () => {
      off();
      removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    },
  });
  requestAnimationFrame(draw);
}
