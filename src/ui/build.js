// Build bar: shown while build mode is on. Pick a structure (or the
// remove or upgrade tool), then click the ground in your camp; drag to build
// a line of walls (or upgrade a whole run of them). Keyboard: 1–9 pick,
// X remove, U upgrade, Space builds in front of you, Esc/G leaves build mode.
//
// On touch screens the bar is a slim strip of icons along the top (the
// picked structure's name and cost underneath), so the camp stays in view:
// tap a tile to pick it, tap it again (or the hammer button) to build, and
// drag from the picked tile to draw a line.

import { $, h, clear, pixelCanvas } from './dom.js';
import { icon, costChips } from './icons.js';
import { structureDefs, structureDef } from '../game/construction.js';
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
    } else if (e.code === 'KeyU') {
      g.selectStructure('upgrade');
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
        'aria-label': def.name,
        'data-id': def.id,
        title: lock ? `${def.name} — ${lock}` : `${def.name}: ${def.desc}`,
        onclick: (e) => {
          e.currentTarget.blur();
          if (lock) g.toast(lock, 'warn');
          else g.selectStructure(def.id);
        },
      },
      h('span.art', art, lock ? h('span.lock', icon('lock', 16)) : null),
      touch ? null : h('span.name', def.name),
      touch ? null : h('span.bcost', costChips(g.structureCost?.(def) ?? def.cost, g.buildWallet?.(def) ?? g.save.resources)),
      touch ? null : h('span.num', String(i + 1)));
    });
    const removing = g.build.tool === 'remove';
    const upgrading = g.build.tool === 'upgrade';
    const done = h('button.btn-primary.done', {
      onclick: (e) => {
        e.currentTarget.blur();
        g.toggleBuildMode(false);
      },
    }, 'Done');
    const sel = structureDef(g.data, g.build.selected);
    el.classList.toggle('compact', touch);
    clear(el).append(
      h('div.build-list', { role: 'toolbar', 'aria-label': 'Structures' },
        h('button.bitem.remove', {
          class: removing ? 'on' : null,
          'aria-pressed': String(removing),
          'aria-label': 'Remove',
          title: 'Take structures down (you get half the materials back)',
          onclick: (e) => {
            e.currentTarget.blur();
            g.selectStructure('remove');
          },
        }, h('span.art', icon('remove', touch ? 24 : 32)), touch ? null : h('span.name', 'Remove'), touch ? null : h('span.num', 'X')),
        h('button.bitem.upgrade', {
          class: upgrading ? 'on' : null,
          'aria-pressed': String(upgrading),
          'aria-label': 'Upgrade',
          title: 'Make walls, gates, turrets, traps and floors stronger in place (wood → stone → reinforced)',
          onclick: (e) => {
            e.currentTarget.blur();
            g.selectStructure('upgrade');
          },
        }, h('span.art', icon('up', touch ? 24 : 32)), touch ? null : h('span.name', 'Upgrade'), touch ? null : h('span.num', 'U')),
        items),
      touch
        ? h('div.build-foot',
          h('div.build-sel',
            upgrading
              ? [icon('up', 16), h('b', 'Upgrade'), h('span.small.muted', 'wood → stone → reinforced')]
              : removing || !sel
                ? [icon('remove', 16), h('b', 'Remove'), h('span.small.muted', 'half the materials back')]
                : [h('b', sel.name), h('span.bcost', costChips(g.structureCost?.(sel) ?? sel.cost, g.buildWallet?.(sel) ?? g.save.resources))]),
          done)
        : h('div.build-foot', h('span.status'), done));
    if (touch) el.append(h('div.status'));
    this.refresh();
  }

  /** Cheap per-tick update: status line and affordability. */
  refresh() {
    const g = this.game;
    if (!g.build.active || !this.el) return;
    const status = this.el.querySelector('.status');
    if (status) {
      const touch = g.input.mode === 'touch';
      const tool = g.build.tool;
      const hint = tool === 'remove'
        ? (touch ? 'Tap a structure, then tap it again (or the hammer) to take it down.' : 'Click a structure to take it down.')
        : tool === 'upgrade'
          ? (touch ? 'Tap a wall, gate, turret or floor, then tap it again to upgrade it.' : 'Click a structure to upgrade it · drag along a wall to upgrade it all.')
          : touch ? 'Tap a tile, then tap it again (or the hammer) to build · drag from it for a line.' : 'Click to build · drag for a line · right-click removes · Space builds ahead.';
      // Upgrading: what the picked structure becomes, and what it costs.
      const up = tool === 'upgrade' && g.build.ghost && !g.build.reason ? g.upgradeInfo?.(g.build.ghost.tx, g.build.ghost.ty) : null;
      const upText = up ? `→ ${up.to.name}: ${Object.entries(up.cost).map(([k, n]) => `${n} ${k}`).join(', ') || 'free'}` : null;
      status.textContent = g.build.reason && g.build.ghost ? g.build.reason : upText ?? hint;
      status.classList.toggle('bad', Boolean(g.build.reason));
    }
    const costOf = (def) => g.structureCost?.(def) ?? def.cost;
    const walletOf = (def) => g.buildWallet?.(def) ?? g.save.resources;
    const sel = structureDef(g.data, g.build.selected);
    for (const chip of this.el.querySelectorAll('.build-sel .cost')) {
      chip.classList.toggle('short', sel ? (walletOf(sel)[chip.dataset.kind] ?? 0) < (costOf(sel)[chip.dataset.kind] ?? 0) : false);
    }
    for (const btn of this.el.querySelectorAll('.bitem[data-id]')) {
      const def = structureDefs(g.data).find((d) => d.id === btn.dataset.id);
      const ok = canAfford(walletOf(def), costOf(def));
      btn.classList.toggle('poor', !ok);
      for (const chip of btn.querySelectorAll('.cost')) {
        const kind = chip.dataset.kind;
        chip.classList.toggle('short', (walletOf(def)[kind] ?? 0) < (costOf(def)[kind] ?? 0));
      }
    }
  }
}
