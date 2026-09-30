// Settings, save management (export/import/reset), app status (version,
// offline readiness, storage), install and update controls.

import { h } from './dom.js';
import { openModal, replaceModalBody } from './modal.js';
import { APP_VERSION } from '../config.js';

export function open(game, app) {
  const s = game.save.settings;
  const rerender = () => replaceModalBody(build());
  const set = (patch) => {
    game.updateSettings(patch);
    app.applySettings?.();
    rerender();
  };

  const toggle = (label, key, hint) => h('label.field.toggle',
    h('input', { type: 'checkbox', checked: s[key] ? true : null, onchange: (e) => set({ [key]: e.target.checked }) }),
    h('span', label), hint ? h('small.muted', hint) : null);

  const choice = (label, key, options) => h('label.field',
    h('span', label),
    h('select', { onchange: (e) => set({ [key]: e.target.value }) },
      options.map(([v, text]) => h('option', { value: v, selected: s[key] === v ? true : null }, text))));

  const range = (label, key, min, max, step) => h('label.field',
    h('span', `${label}: ${Math.round(s[key] * 100)}%`),
    h('input', { type: 'range', min, max, step, value: s[key], onchange: (e) => set({ [key]: Number(e.target.value) }) }));

  function build() {
    const st = app.status();
    const online = navigator.onLine !== false;
    return h('div.settings',
      h('section',
        h('h3', 'Controls'),
        choice('Sprint', 'sprintMode', [['toggle', 'Tap to toggle'], ['hold', 'Hold']]),
        choice('Joystick', 'joystickMode', [['dynamic', 'Appears under your thumb'], ['fixed', 'Fixed position']]),
        range('Joystick size', 'joystickSize', 0.7, 1.5, 0.1),
        toggle('Left-handed layout', 'leftHanded', 'Joystick on the right, buttons on the left'),
        toggle('Vibration', 'vibration')),
      h('section',
        h('h3', 'Audio & video'),
        range('Volume', 'volume', 0, 1, 0.05),
        toggle('Sound effects', 'sfx'),
        choice('Quality', 'quality', [['auto', 'Auto (adapts to your device)'], ['high', 'High'], ['low', 'Low (battery saver)']]),
        choice('View', 'viewSize', [['auto', 'Auto (wider on phones held upright)'], ['close', 'Close'], ['normal', 'Normal'], ['wide', 'Wide (see more)']]),
        toggle('Screen shake', 'screenShake'),
        toggle('Damage numbers', 'damageNumbers'),
        toggle('Show FPS', 'showFps'),
        document.fullscreenEnabled ? toggle('Full screen on phones', 'autoFullscreen', 'Hides the browser bars when you start playing') : null,
        document.fullscreenEnabled ? h('button', { onclick: () => app.toggleFullscreen() }, 'Toggle fullscreen') : null),
      h('section',
        h('h3', 'Save data'),
        h('p.muted', `Saved locally on this device (${st.storage}${st.persisted ? ', protected from cleanup' : ''}). Revision ${game.save.rev}.`),
        game.saveManager.readOnly ? h('p.warn', game.saveManager.readOnlyReason) : null,
        h('div.actions',
          h('button', { onclick: () => app.exportSave() }, 'Export save file'),
          h('label.button', 'Import save file',
            h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => e.target.files[0] && app.importSave(e.target.files[0]) })),
          h('button.btn-danger', { onclick: () => app.resetSave() }, 'Start a new world'))),
      h('section',
        h('h3', 'Cloud sync'),
        st.syncEnabled
          ? h('p', online ? `Status: ${st.sync}` : 'Offline — changes are kept and will sync automatically when you reconnect.')
          : h('p.muted', 'Not configured. The game is fully playable offline; cloud sync requires an internet connection and a server.')),
      h('section',
        h('h3', 'App'),
        h('dl.stats.small',
          h('dt', 'Version'), h('dd', `${APP_VERSION} (data ${game.data.dataVersion})`),
          h('dt', 'Offline play'), h('dd', st.offlineReady ? 'Ready' : st.swSupported ? 'Preparing…' : 'Not supported in this browser'),
          h('dt', 'Connection'), h('dd', online ? 'Online' : 'Offline'),
          h('dt', 'Weapon generator'), h('dd', game.weapons.mode === 'worker' ? 'Web Worker' : 'Main thread'),
          h('dt', 'Installed'), h('dd', st.standalone ? 'Yes' : 'No (running in browser)')),
        st.unsupported.length ? h('p.muted.small', `Limited features: ${st.unsupported.join(', ')}. The game still works.`) : null,
        h('div.actions',
          st.canInstall ? h('button.btn-primary', { onclick: () => app.install() }, 'Install app') : null,
          st.iosInstallHint ? h('p.small', 'To install: tap Share, then “Add to Home Screen”.') : null,
          app.updateReady ? h('button.btn-primary', { onclick: () => app.applyUpdate() }, 'Install update now') : null,
          h('button', { disabled: !online || !st.swSupported, onclick: async () => {
            const found = await app.checkForUpdates();
            game.toast(found ? 'Update found — downloading…' : 'You have the latest version');
          } }, online ? 'Check for updates' : 'Check for updates (requires internet)'))));
  }

  openModal({ title: 'Settings & Save', body: build(), className: 'wide settings-panel' });
}
