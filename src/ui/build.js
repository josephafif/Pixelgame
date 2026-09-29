// Build bar: shown while build mode is on. Pick a structure (or the
// remove tool), then click/tap the ground in your camp. Drag to build a
// line of walls. Keyboard: 1–9 pick, X remove, Space builds in front of
// you, Esc/G leaves build mode.

import { $, h, clear, pixelCanvas } from './dom.js';
import { icon, costChips } from './icons.js';
import { structureDefs } from '../game/construction.js';
import { structureIcon } from '../render/structures.js';
import { canAfford } from '../game/base.js';

export class BuildBar {
  constructor(game) {
    this.game = game;
    this.el = $('#build-bar');
    if (!this.el) return;
    game.on('build', () => this.render());
    game.on('hud', () => this.refresh());
    game.on('structures', () => this.refresh());
    addEventListener('keydown', (e) => this.#onKey(e));
  }

  #onKey(e) {
    const g = this.game;
    if (!g.build.active || g.paused || e.repeat) return;
    if (e.target instanceof HTMLInputElement) return;
    const defs = structureDefs(g.data);
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, defs.length)) {
      g.selectStructure(defs[n - 1].id);
      e.preventDefault();
    } else if (e.code === 'KeyX' || e.key === 'Delete') {
      g.selectStructure('remove');
      e.preventDefault();
    }
  }

  render() {
    const g = this.game;
    const el = this.el;
    el.toggleAttribute('hidden', !g.build.active);
    if (!g.build.active) return;
    const touch = g.input.mode === 'touch';
    const items = structureDefs(g.data).map((def, i) => {
      const lock = g.structureLock(def);
      const on = g.build.tool === 'place' && g.build.selected === def.id;
      const art = pixelCanvas(structureIcon(def.id));
      art.style.width = '32px';
      art.style.height = '48px';
      return h('button.bitem', {
        class: [on ? 'on' : null, lock ? 'locked' : null].filter(Boolean).join(' ') || null,
        'aria-pressed': String(on),
        'data-id': def.id,
        title: lock ? `${def.name} — ${lock}` : `${def.name}: ${def.desc}`,
        onclick: (e) => {
          e.currentTarget.blur();
          if (lock) g.toast(lock, 'warn');
          else g.selectStructure(def.id);
        },
      },
      h('span.art', art, lock ? h('span.lock', icon('lock', 16)) : null),
      h('span.name', def.name),
      h('span.bcost', costChips(def.cost, g.save.resources)),
      touch ? null : h('span.num', String(i + 1)));
    });
    const removing = g.build.tool === 'remove';
    clear(el).append(
      h('div.build-list', { role: 'toolbar', 'aria-label': 'Structures' },
        items,
        h('button.bitem.remove', {
          class: removing ? 'on' : null,
          'aria-pressed': String(removing),
          title: 'Take structures down (you get half the materials back)',
          onclick: (e) => {
            e.currentTarget.blur();
            g.selectStructure('remove');
          },
        }, h('span.art', icon('remove', 32)), h('span.name', 'Remove'), touch ? null : h('span.num', 'X'))),
      h('div.build-foot',
        h('span.status'),
        h('button.btn-primary.done', {
          onclick: (e) => {
            e.currentTarget.blur();
            g.toggleBuildMode(false);
          },
        }, 'Done')));
    this.refresh();
  }

  /** Cheap per-tick update: status line and affordability. */
  refresh() {
    const g = this.game;
    if (!g.build.active || !this.el) return;
    const status = this.el.querySelector('.status');
    if (status) {
      const touch = g.input.mode === 'touch';
      const hint = g.build.tool === 'remove'
        ? (touch ? 'Tap a structure to take it down.' : 'Click a structure to take it down.')
        : touch ? 'Tap the ground to build · drag for a line.' : 'Click to build · drag for a line · right-click removes · Space builds ahead.';
      status.textContent = g.build.reason && g.build.ghost ? g.build.reason : hint;
      status.classList.toggle('bad', Boolean(g.build.reason));
    }
    for (const btn of this.el.querySelectorAll('.bitem[data-id]')) {
      const def = structureDefs(g.data).find((d) => d.id === btn.dataset.id);
      const ok = canAfford(g.save.resources, def.cost);
      btn.classList.toggle('poor', !ok);
      for (const chip of btn.querySelectorAll('.cost')) {
        const kind = chip.title.toLowerCase();
        chip.classList.toggle('short', (g.save.resources[kind] ?? 0) < (def.cost[kind] ?? 0));
      }
    }
  }
}
