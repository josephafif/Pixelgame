// UI controller: routes game UI commands to panels. Heavy panels
// (inventory, forge, research, settings) are lazy-loaded the first time
// they're opened and prefetched when the browser is idle.

import { h } from './dom.js';
import { openModal, closeModal, isModalOpen, isModalLocked } from './modal.js';
import { isCraftingUnlocked } from '../weapons/crafting.js';

const loaders = {
  inventory: () => import('./inventory.js'),
  crafting: () => import('./crafting.js'),
  research: () => import('./research.js'),
  settings: () => import('./settings.js'),
};

export class Panels {
  constructor(game, app) {
    this.game = game;
    this.app = app;
    this.open = null;
    game.on('ui', (cmd) => this.command(cmd));
    document.getElementById('btn-menu').addEventListener('click', () => this.show('menu'));
  }

  prefetch() {
    const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
    idle(() => Object.values(loaders).forEach((load) => load().catch(() => {})));
  }

  command(cmd) {
    if (!this.app.started || this.game.discoveryOpen || isModalLocked()) return;
    if (cmd === 'back') {
      closeModal();
      return;
    }
    if (cmd === 'map') return;
    // Pressing the same key again closes the panel.
    if (isModalOpen() && this.open === cmd) {
      closeModal();
      return;
    }
    this.show(cmd);
  }

  async show(name, arg) {
    if (this.game.discoveryOpen || isModalLocked()) return;
    this.open = name;
    if (name === 'menu') return this.#menu();
    if (name === 'camp') return this.#camp();
    if (name === 'crafting' && !isCraftingUnlocked(this.game.data, this.game.save)) {
      this.game.toast(`The Forge unlocks at level ${this.game.data.crafting.unlockLevel}`, 'warn');
      return;
    }
    const load = loaders[name];
    if (!load) return;
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
    const craftingOk = isCraftingUnlocked(g.data, g.save);
    const go = (name) => () => this.show(name);
    const update = this.app.updateReady
      ? h('button.btn-primary', { onclick: () => this.app.applyUpdate() }, 'Update available — install now')
      : null;
    const body = h('div.menu',
      update,
      h('button.btn-primary', { onclick: () => closeModal(), autofocus: true }, 'Resume'),
      h('button', { onclick: go('inventory') }, 'Inventory', h('kbd', 'I')),
      h('button', { onclick: go('crafting'), disabled: !craftingOk },
        craftingOk ? 'Forge' : `Forge (unlocks at Lv ${g.data.crafting.unlockLevel})`, h('kbd', 'C')),
      h('button', { onclick: go('research') }, 'Research', h('kbd', 'R')),
      h('button', { onclick: go('settings') }, 'Settings & Save'),
      h('p.menu-foot', this.app.statusLine()));
    openModal({ title: 'Paused', body, className: 'menu-panel', onClose: () => { this.open = null; } });
  }

  #camp() {
    const g = this.game;
    const craftingOk = isCraftingUnlocked(g.data, g.save);
    const body = h('div.menu',
      h('p', 'You rest by the fire. Health restored.'),
      h('button', { onclick: () => this.show('inventory', 'storage') }, 'Storage chest'),
      h('button', { onclick: () => this.show('crafting'), disabled: !craftingOk },
        craftingOk ? 'Forge' : `Forge (unlocks at Lv ${g.data.crafting.unlockLevel})`),
      h('button', { onclick: () => this.show('research') }, 'Research table'),
      h('button.btn-primary', { onclick: () => closeModal(), autofocus: true }, 'Continue'));
    openModal({ title: 'Camp', body, className: 'menu-panel', onClose: () => { this.open = null; } });
  }
}
