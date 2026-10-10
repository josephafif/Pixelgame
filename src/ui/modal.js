// Modal panels. One panel open at a time; opening a panel pauses the game
// and closing it resumes. Esc / gamepad B / the close button close it.
//
// Small in-game dialogs (askConfirm, showText) open on top of whatever panel
// is showing, so the game never needs the browser's confirm()/prompt().

import { h, clear } from './dom.js';
import { icon as pixelIcon } from './icons.js';

let current = null;
let game = null;

export function initModals(g) {
  game = g;
  addEventListener('keydown', (e) => {
    if (dialog) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeDialog(false);
      }
      return;
    }
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

// --- Dialogs -------------------------------------------------------------------------

let dialog = null;

export function isDialogOpen() {
  return Boolean(dialog);
}

/** Cancels the open dialog (as if the player said no). */
export function closeDialog(answer = false) {
  if (!dialog) return;
  const { root, resolve, paused } = dialog;
  dialog = null;
  root.remove();
  if (paused) game?.resume('dialog');
  resolve(answer);
}

function openDialog({ title, icon, body, buttons, className = '' }) {
  closeDialog(false);
  return new Promise((resolve) => {
    const panel = h(`div.panel.dialog${className ? `.${className}` : ''}`, { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title ?? 'Dialog' },
      title ? h('header.panel-head', h('h2', icon ? pixelIcon(icon, 24) : null, title)) : null,
      h('div.panel-body', body, h('div.actions.dialog-actions', buttons.map((b) => h(`button${b.primary ? '.btn-primary' : ''}${b.danger ? '.btn-danger' : ''}`, {
        autofocus: b.focus ? true : null,
        onclick: () => closeDialog(b.value),
      }, b.label)))));
    const root = h('div.dialog-backdrop', {
      onpointerdown: (e) => {
        if (e.target === root) closeDialog(false);
      },
    }, panel);
    (document.getElementById('dialog-root') ?? document.body).append(root);
    // Panels already pause the game; a dialog on its own does it itself.
    const paused = !current;
    if (paused) game?.pause('dialog');
    dialog = { root, resolve, paused };
    requestAnimationFrame(() => {
      const focusable = panel.querySelector('[autofocus], input, button:not([disabled])');
      focusable?.focus({ preventScroll: true });
      if (focusable instanceof HTMLInputElement) focusable.select();
    });
  });
}

/**
 * Asks a yes/no question inside the game. Resolves true when confirmed.
 * opts: { title, text, ok, cancel, danger, icon }
 */
export function askConfirm({ title = 'Are you sure?', text = '', ok = 'OK', cancel = 'Cancel', danger = false, icon = null } = {}) {
  const lines = Array.isArray(text) ? text : String(text).split('\n\n');
  return openDialog({
    title, icon,
    body: h('div.dialog-text', lines.map((line) => h('p', line))),
    buttons: [
      { label: cancel, value: false, focus: danger },
      { label: ok, value: true, primary: !danger, danger, focus: !danger },
    ],
  });
}

/** Shows a value the player can select and copy (a weapon code, a link). */
export function showText({ title, text = '', value = '', copy = 'Copy', close = 'Close', copied = 'Copied' } = {}) {
  const field = h('input.dialog-field', { type: 'text', readonly: true, value, 'aria-label': title ?? 'Text' });
  field.addEventListener('keydown', (e) => e.stopPropagation());
  const copyBtn = h('button.btn-primary', {
    onclick: async () => {
      field.select();
      try {
        await navigator.clipboard.writeText(value);
        copyBtn.textContent = copied;
      } catch {
        try {
          if (document.execCommand('copy')) copyBtn.textContent = copied;
        } catch { /* the text stays selected: copy it by hand */ }
      }
    },
  }, copy);
  return openDialog({
    title,
    body: h('div.dialog-text', text ? h('p', text) : null, h('div.row.dialog-copy', field, copyBtn)),
    buttons: [{ label: close, value: true, focus: false }],
  });
}
