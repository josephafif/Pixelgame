// Case opening: a strip of weapons scrolls past a marker and slowly comes to
// rest on what you actually got (it was decided before the roll started).
// Legendaries hide behind a golden ★ until the reveal, like a rare special
// item in a case. Used for chests and the Forge.

import { h } from './dom.js';
import { weaponIconEl } from './weapon-card.js';
import { randomPreviewIcon } from './preview.js';

const ITEMS = 46;
const WINNER = 40;
const ITEM_W = 88; // px incl. gap (see .case-item in app.css)
const DURATION = 5200;
// How often each tier shows up in the strip (the real odds are far lower
// for legendaries, which is exactly why seeing ★ fly past is exciting).
const SHOW_WEIGHTS = { common: 52, uncommon: 26, rare: 13, epic: 6, legendary: 1.6 };

function pickRarity(data, allowed, rand) {
  const list = data.rarities.filter((r) => allowed.has(r.id));
  const total = list.reduce((s, r) => s + (SHOW_WEIGHTS[r.id] ?? 1), 0);
  let x = rand() * total;
  for (const r of list) {
    x -= SHOW_WEIGHTS[r.id] ?? 1;
    if (x <= 0) return r;
  }
  return list[list.length - 1];
}

function star() {
  return h('span.case-star', '★');
}

/**
 * Builds the roll. Returns { el, done } where `done` resolves when the strip
 * has stopped (or was skipped).
 * @param {object} range { min, max } rarity ids shown in the strip
 */
export function caseRoll(game, dna, range, title = 'Opening…') {
  const { data } = game;
  const idx = (id) => data.rarityIndex.get(id) ?? 0;
  const lo = Math.min(idx(range.min ?? 'common'), idx(dna.rarity));
  const hi = Math.max(idx(range.max ?? 'legendary'), idx(dna.rarity));
  const allowed = new Set(data.rarities.slice(lo, hi + 1).map((r) => r.id));
  const rand = Math.random;
  const items = [];
  for (let i = 0; i < ITEMS; i++) {
    const r = i === WINNER ? data.byId.rarities.get(dna.rarity) : pickRarity(data, allowed, rand);
    const inner = r.id === 'legendary'
      ? star()
      : i === WINNER ? weaponIconEl(dna, 48) : randomPreviewIcon(data, r.id, 48, rand);
    items.push(h('div.case-item', { class: `r-${r.id}`, style: { '--rarity': r.color } }, inner));
  }
  const strip = h('div.case-strip', items);
  const skip = h('button.skip', 'Skip');
  const el = h('div.case-roll',
    h('div.case-title', title),
    h('div.case-window', h('div.case-marker'), strip),
    h('div.case-foot', skip));

  const done = new Promise((resolve) => {
    let finished = false;
    let raf = 0;
    let lastIndex = -1;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      const win = items[WINNER];
      win.classList.add('win');
      const r = idx(dna.rarity);
      if (r >= 4) {
        // The ★ turns into the actual weapon.
        win.replaceChildren(weaponIconEl(dna, 48));
        el.classList.add('legendary');
      }
      game.audio.play('discover', { rarity: r });
      el.classList.add('stopped');
      setTimeout(resolve, r >= 3 ? 1300 : 700);
    };
    const start = () => {
      const windowW = strip.parentElement?.clientWidth || 320;
      const jitter = (Math.random() - 0.5) * (ITEM_W * 0.6);
      const target = WINNER * ITEM_W + ITEM_W / 2 - windowW / 2 + jitter;
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) {
        strip.style.transform = `translateX(${-target}px)`;
        finish();
        return;
      }
      strip.style.transition = `transform ${DURATION}ms cubic-bezier(0.06, 0.62, 0.1, 1)`;
      strip.style.transform = `translateX(${-target}px)`;
      const t0 = performance.now();
      const tick = () => {
        // A click each time an item passes the marker.
        const m = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
        const pos = Math.floor((-m.m41 + windowW / 2) / ITEM_W);
        if (pos !== lastIndex) {
          lastIndex = pos;
          game.audio.play('tick', { throttle: 30 });
        }
        if (performance.now() - t0 < DURATION + 50) raf = requestAnimationFrame(tick);
        else finish();
      };
      raf = requestAnimationFrame(tick);
      strip.addEventListener('transitionend', finish, { once: true });
    };
    skip.addEventListener('click', () => {
      const m = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
      strip.style.transition = 'none';
      strip.style.transform = `translateX(${m.m41}px)`;
      const windowW = strip.parentElement?.clientWidth || 320;
      strip.style.transform = `translateX(${-(WINNER * ITEM_W + ITEM_W / 2 - windowW / 2)}px)`;
      finish();
    });
    // Start after the modal is laid out.
    requestAnimationFrame(() => requestAnimationFrame(start));
  });
  return { el, done };
}
