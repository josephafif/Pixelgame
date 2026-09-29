// Modal panels. One panel open at a time; opening a panel pauses the game
// and closing it resumes. Esc / gamepad B / the close button close it.

import { h, clear } from './dom.js';
import { icon as pixelIcon } from './icons.js';

let current = null;
let game = null;

export function initModals(g) {
  game = g;
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current && !current.locked) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeModal();
    }
  }, true);
}

export function isModalOpen() {
  return Boolean(current);
}

/** Locked dialogs (tutorial, discovery) must be answered, not replaced. */
export function isModalLocked() {
  return Boolean(current?.locked);
}

/**
 * @param {object} opts { title, icon, body (Node), className, onClose, onDispose, locked, label }
 *   onClose runs when the player dismisses the panel; onDispose runs whenever
 *   it goes away (also when another panel replaces it) — unsubscribe there.
 */
export function openModal({ title, icon, body, className = '', onClose, onDispose, locked = false, label }) {
  closeModal(true);
  const root = document.getElementById('overlay-root');
  const closeBtn = locked ? null : h('button.icon-btn.close', { 'aria-label': 'Close', onclick: () => closeModal() }, pixelIcon('close', 20));
  const panel = h(`div.panel${className ? `.${className.split(' ').join('.')}` : ''}`, {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': label ?? title ?? 'Dialog',
  },
  title ? h('header.panel-head', h('h2', icon ? pixelIcon(icon, 32) : null, title), closeBtn) : closeBtn,
  h('div.panel-body', body));
  const backdrop = h('div.backdrop', {
    onpointerdown: (e) => {
      if (e.target === backdrop && !locked) closeModal();
    },
  }, panel);
  clear(root).append(backdrop);
  current = { backdrop, onClose, onDispose, locked };
  game?.pause('modal');
  requestAnimationFrame(() => {
    const focusable = panel.querySelector('[autofocus], button:not([disabled]), select, input');
    focusable?.focus({ preventScroll: true });
  });
  return { panel, close: () => closeModal() };
}

export function closeModal(silent = false) {
  if (!current) return;
  const { backdrop, onClose, onDispose } = current;
  current = null;
  backdrop.remove();
  game?.resume('modal');
  onDispose?.();
  if (!silent) onClose?.();
}

export function replaceModalBody(node) {
  if (!current) return;
  const body = current.backdrop.querySelector('.panel-body');
  clear(body).append(node);
}
