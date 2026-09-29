// Modal panels. One panel open at a time; opening a panel pauses the game
// and closing it resumes. Esc / gamepad B / the close button close it.

import { h, clear } from './dom.js';

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

/**
 * @param {object} opts { title, body (Node), className, onClose, locked, actions }
 */
export function openModal({ title, body, className = '', onClose, locked = false, label }) {
  closeModal(true);
  const root = document.getElementById('overlay-root');
  const closeBtn = locked ? null : h('button.icon-btn.close', { 'aria-label': 'Close', onclick: () => closeModal() }, '✕');
  const panel = h(`div.panel${className ? `.${className.split(' ').join('.')}` : ''}`, {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': label ?? title ?? 'Dialog',
  },
  title ? h('header.panel-head', h('h2', title), closeBtn) : closeBtn,
  h('div.panel-body', body));
  const backdrop = h('div.backdrop', {
    onpointerdown: (e) => {
      if (e.target === backdrop && !locked) closeModal();
    },
  }, panel);
  clear(root).append(backdrop);
  current = { backdrop, onClose, locked };
  game?.pause('modal');
  requestAnimationFrame(() => {
    const focusable = panel.querySelector('[autofocus], button:not([disabled]), select, input');
    focusable?.focus({ preventScroll: true });
  });
  return { panel, close: () => closeModal() };
}

export function closeModal(silent = false) {
  if (!current) return;
  const { backdrop, onClose } = current;
  current = null;
  backdrop.remove();
  game?.resume('modal');
  if (!silent) onClose?.();
}

export function replaceModalBody(node) {
  if (!current) return;
  const body = current.backdrop.querySelector('.panel-body');
  clear(body).append(node);
}
