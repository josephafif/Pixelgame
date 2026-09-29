// Keeps the browser's own behaviour out of the way while playing: no
// right-click/long-press menus, no text selection or image dragging, no
// page zoom from Ctrl+wheel or pinch, no accidental "back" that leaves the
// game, and Ctrl+S saves the game instead of the web page. Text inputs
// (weapon codes, settings) keep working normally.

function editable(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || Boolean(target?.isContentEditable);
}

// Ctrl/Cmd shortcuts that would print, bookmark, search or open things.
const BLOCKED_CTRL = new Set(['KeyP', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyO', 'KeyU']);

/**
 * @param {object} hooks { playing(): boolean, save(): void, back(): 'handled'|'leave' }
 */
export function hardenBrowser(hooks) {
  const opts = { capture: true };
  addEventListener('contextmenu', (e) => {
    if (!editable(e.target)) e.preventDefault();
  }, opts);
  addEventListener('selectstart', (e) => {
    if (!editable(e.target)) e.preventDefault();
  }, opts);
  addEventListener('dragstart', (e) => e.preventDefault(), opts);
  // Middle-click autoscroll / open-in-new-tab, and mouse back/forward buttons.
  addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  }, opts);
  addEventListener('auxclick', (e) => e.preventDefault(), opts);
  addEventListener('mouseup', (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  }, opts);
  // Ctrl+wheel / trackpad pinch zoom, Safari gesture zoom.
  addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }, { passive: false, capture: true });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    addEventListener(type, (e) => e.preventDefault(), { passive: false, capture: true });
  }
  addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyS') {
      e.preventDefault();
      hooks.save();
      return;
    }
    if (editable(e.target)) return;
    if (mod && BLOCKED_CTRL.has(e.code)) e.preventDefault();
    // Alt+Left/Right and the Backspace key navigate history in some browsers.
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'BrowserBack' || e.key === 'F1' || e.key === 'F3' || e.key === 'F7') e.preventDefault();
    // Alt alone focuses the menu bar in some desktop browsers.
    if (e.key === 'Alt') e.preventDefault();
    // Tab would move focus to hidden controls while playing.
    if (e.key === 'Tab' && hooks.playing()) e.preventDefault();
  }, opts);
  addEventListener('keyup', (e) => {
    if (e.key === 'Alt') e.preventDefault();
  }, opts);
}

/**
 * Phone back button / swipe-back: the first press closes the open panel or
 * opens the pause menu; pressing back again from the pause menu leaves.
 */
export function trapBackNavigation(hooks) {
  if (!history.pushState) return;
  history.pushState({ pixelgame: true }, '');
  addEventListener('popstate', () => {
    if (!hooks.playing()) return;
    if (hooks.back() === 'leave') {
      history.back();
      return;
    }
    history.pushState({ pixelgame: true }, '');
  });
}
