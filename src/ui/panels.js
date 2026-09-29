// UI controller: routes game UI commands to panels. Heavy panels
// (inventory, forge, research, camp, settings) are lazy-loaded the first
// time they're opened and prefetched when the browser is idle.
//
// A command is either a panel name ('inventory') or an object
// ({ name: 'inventory', tab: 'storage' } / { name: 'base', focus: 'forge' }).

import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal, closeModal, isModalOpen, isModalLocked } from './modal.js';
import { isCraftingUnlocked } from '../weapons/crafting.js';
import { buildingLevel } from '../game/base.js';
import { BuildBar } from './build.js';

const loaders = {
  inventory: () => import('./inventory.js'),
  crafting: () => import('./crafting.js'),
  research: () => import('./research.js'),
  base: () => import('./base.js'),
  settings: () => import('./settings.js'),
};

const DOCK = {
  'btn-inventory': 'inventory',
  'btn-forge': 'crafting',
  'btn-research': 'research',
  'btn-base': 'base',
  'btn-build': 'build',
  'btn-menu': 'menu',
};

export class Panels {
  constructor(game, app) {
    this.game = game;
    this.app = app;
    this.open = null;
    game.on('ui', (cmd) => this.command(cmd));
    for (const [id, name] of Object.entries(DOCK)) {
      const btn = document.getElementById(id);
      btn?.addEventListener('click', () => {
        // Don't keep focus: Space/Enter must go to the game, not re-click this.
        btn.blur();
        this.command(name);
      });
    }
    this.buildBar = new BuildBar(game);
  }

  prefetch() {
    const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
    idle(() => Object.values(loaders).forEach((load) => load().catch(() => {})));
  }

  command(cmd) {
    if (!this.app.started || this.game.discoveryOpen || isModalLocked()) return;
    const { name, ...arg } = typeof cmd === 'string' ? { name: cmd } : cmd;
    if (name === 'back') {
      closeModal();
      return;
    }
    if (name === 'map') return;
    if (name === 'build') {
      if (isModalOpen()) closeModal(true);
      this.game.toggleBuildMode();
      return;
    }
    // Esc leaves build mode before it opens the menu.
    if (name === 'menu' && this.game.build.active && !isModalOpen()) {
      this.game.toggleBuildMode(false);
      return;
    }
    // Pressing the same key again closes the panel.
    if (isModalOpen() && this.open === name && !Object.keys(arg).length) {
      closeModal();
      return;
    }
    this.show(name, arg);
  }

  async show(name, arg = {}) {
    if (this.game.discoveryOpen || isModalLocked()) return;
    if (typeof arg === 'string') arg = { tab: arg };
    if (name === 'menu') {
      this.open = name;
      return this.#menu();
    }
    if (name === 'crafting' && !isCraftingUnlocked(this.game.data, this.game.save)) {
      this.game.toast('Build a Forge at your camp to craft weapons', 'warn');
      return this.show('base', { focus: 'forge' });
    }
    const load = loaders[name];
    if (!load) return;
    this.open = name;
    try {
      const mod = await load();
      mod.open(this.game, this.app, arg);
    } catch (err) {
      console.error(err);
      this.game.toast(`Could not open ${name}: ${err.message}`, 'warn');
    }
  }

  #menu() {
    const g = this.game;
    const go = (name, arg) => () => this.show(name, arg);
    const item = (iconName, label, onclick, key, extra = {}) =>
      h('button', { onclick, ...extra }, icon(iconName, 24), h('span', label), key ? h('kbd', key) : null);
    const update = this.app.updateReady
      ? h('button.btn-primary', { onclick: () => this.app.applyUpdate() }, 'Update available — install now')
      : null;
    const waystone = buildingLevel(g.data, g.save, 'waystone');
    const recallLeft = Math.ceil(g.recallReadyIn());
    const farFromCamp = Math.hypot(g.player.x, g.player.y) >= 8;
    const recall = waystone >= 1 && farFromCamp
      ? item('portal', recallLeft > 0 ? `Recall to camp (${recallLeft}s)` : 'Recall to camp', () => {
        closeModal();
        g.recall();
      }, null, { disabled: recallLeft > 0 })
      : null;
    const back = waystone >= 2 && g.save.base.recall && !farFromCamp
      ? item('portal', 'Return through the Waystone', () => {
        closeModal();
        g.returnFromRecall();
      })
      : null;
    const body = h('div.menu',
      update,
      h('button.btn-primary', { onclick: () => closeModal(), autofocus: true }, 'Resume'),
      recall,
      back,
      h('div.menu-grid',
        item('bag', 'Inventory', go('inventory'), 'I'),
        item('anvil', 'Forge', go('crafting'), 'C'),
        item('book', 'Research', go('research'), 'R'),
        item('home', 'Camp', go('base'), 'B')),
      item('gear', 'Settings & Save', go('settings')),
      h('p.menu-foot', this.app.statusLine()));
    openModal({ title: 'Paused', body, className: 'menu-panel', onClose: () => { this.open = null; } });
  }
}
