// App entry point: boots storage, data, the weapon worker and the game,
// then wires up PWA behaviour (offline status, updates, install) and the
// page lifecycle (pause + save when hidden, safe resume).

import { APP_NAME, APP_VERSION, CONFIG } from './config.js';
import { randomSeed } from './core/rng.js';
import { loadGameData } from './data/gamedata.js';
import { openStorage, requestPersistence } from './storage/db.js';
import { SaveManager, createNewSave, exportSave, parseImport, NewerSaveError } from './storage/save.js';
import { SyncManager } from './storage/sync.js';
import { WeaponService } from './weapons/weapon-service.js';
import { Renderer } from './render/renderer.js';
import { Input } from './input/input.js';
import { Audio } from './audio/audio.js';
import { Game } from './game/game.js';
import { Hud } from './ui/hud.js';
import { Panels } from './ui/panels.js';
import { initModals, openModal, closeModal } from './ui/modal.js';
import { showDiscovery } from './ui/discovery.js';
import { h, $ } from './ui/dom.js';
import { registerServiceWorker, serviceWorkerSupported } from './pwa/register.js';
import { canInstall, promptInstall, isStandalone, iosInstallHint, onInstallAvailabilityChange } from './pwa/install.js';
import { detectSupport } from './pwa/support.js';

const splashText = $('#splash-text');
const splashBar = $('#splash-bar');
function progress(text, frac) {
  if (splashText) splashText.textContent = text;
  if (splashBar) splashBar.style.width = `${Math.round(frac * 100)}%`;
}

function fatal(message) {
  const splash = $('#splash');
  splash?.classList.add('error');
  progress(message, 1);
  const retry = h('button.btn-primary', { onclick: () => location.reload() }, 'Try again');
  splash?.append(retry);
}

/** Only one tab may write the save at a time (Web Locks), others read-only. */
function acquireTabLock() {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('pixelgame-save', { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      return new Promise(() => {}); // hold for the lifetime of the page
    });
  });
}

class App {
  constructor() {
    this.updateReady = false;
    this.applyUpdateFn = null;
    this.offlineReady = false;
    this.persisted = false;
    this.support = detectSupport();
    this.syncStatus = 'disabled';
  }

  async boot() {
    progress('Starting…', 0.05);
    this.#watchNetwork();
    if (serviceWorkerSupported()) {
      registerServiceWorker({
        onUpdateReady: (apply) => this.#onUpdateReady(apply),
        onOfflineReady: () => {
          this.offlineReady = true;
          this.#renderTitleStatus();
        },
        onMessage: (msg) => this.#onSwMessage(msg),
      }).catch((err) => console.warn('[sw] registration failed', err));
    }

    progress('Opening save storage…', 0.15);
    this.storage = await openStorage();
    const owner = await acquireTabLock();
    this.saveManager = new SaveManager(this.storage, { appVersion: APP_VERSION });
    if (!owner) {
      this.saveManager.readOnly = true;
      this.saveManager.readOnlyReason = 'The game is open in another tab or window. Progress here is not saved.';
    }

    progress('Loading game data…', 0.3);
    const { raw, data } = await loadGameData();
    this.data = data;

    progress('Loading your progress…', 0.45);
    let save = null;
    try {
      save = await this.saveManager.load();
    } catch (err) {
      console.error('[save] load failed', err);
      if (!(err instanceof NewerSaveError)) {
        const backup = await this.saveManager.loadBackup().catch(() => null);
        if (backup) {
          try {
            save = (await import('./storage/save.js')).migrateSave(backup).save;
            this.bootWarning = 'Your save was damaged; the last backup was restored.';
          } catch {
            save = null;
          }
        }
      }
      this.bootWarning ??= err.message;
    }
    this.isNewGame = !save;
    save ??= createNewSave({ worldSeed: randomSeed(), appVersion: APP_VERSION });
    this.save = save;

    progress('Starting weapon forge…', 0.6);
    this.weapons = new WeaponService(raw, data);
    await this.weapons.init();

    progress('Building the world…', 0.75);
    this.audio = new Audio();
    this.renderer = new Renderer($('#game'));
    this.input = new Input({
      surface: $('#surface'),
      joystick: $('#joystick'),
      knob: $('#knob'),
      buttons: { attack: $('#btn-attack'), sprint: $('#btn-sprint'), ability: $('#btn-ability') },
      settings: () => this.game?.save.settings ?? save.settings,
    });
    this.input.onModeChange = (mode) => this.#applyInputMode(mode);
    this.sync = new SyncManager({
      endpoint: CONFIG.syncEndpoint,
      getSave: () => this.game?.save,
      onStatus: (status) => {
        this.syncStatus = status;
      },
    });
    this.game = new Game({
      data, save, saveManager: this.saveManager, weapons: this.weapons, renderer: this.renderer,
      input: this.input, audio: this.audio, sync: this.sync,
    });
    initModals(this.game);
    this.hud = new Hud(this.game);
    this.panels = new Panels(this.game, this);
    this.game.on('discovery', (d) => showDiscovery(this.game, d));
    this.#applyInputMode(this.input.mode);
    this.applySettings();
    this.#lifecycle();
    if (new URLSearchParams(location.search).has('debug')) this.#exposeDebug();

    progress('Ready', 1);
    this.#showTitle();
  }

  // --- Title / first run ---------------------------------------------------------

  #showTitle() {
    $('#splash').classList.add('done');
    setTimeout(() => $('#splash')?.remove(), 600);
    const title = $('#title');
    setTimeout(() => title.removeAttribute('hidden'), 350);
    $('#title-play').textContent = this.isNewGame ? 'New adventure' : 'Continue';
    $('#title-play').addEventListener('click', () => this.#play(), { once: true });
    $('#title-install').addEventListener('click', () => this.install());
    onInstallAvailabilityChange(() => this.#renderTitleStatus());
    this.#renderTitleStatus();
    if (this.bootWarning) this.game.toast(this.bootWarning, 'warn');
    // Draw the world behind the title screen.
    this.renderer.draw(this.game);
  }

  #renderTitleStatus() {
    const el = $('#title-status');
    if (!el) return;
    const bits = [`v${APP_VERSION}`];
    bits.push(navigator.onLine === false ? 'Offline' : 'Online');
    if (this.offlineReady) bits.push('Offline play ready');
    else if (!serviceWorkerSupported()) bits.push('Offline play unavailable in this browser');
    el.textContent = bits.join(' · ');
    $('#title-install')?.toggleAttribute('hidden', !canInstall());
    $('#title-ios')?.toggleAttribute('hidden', !iosInstallHint());
  }

  async #play() {
    this.audio.unlock();
    $('#title').setAttribute('hidden', '');
    $('#hud').removeAttribute('hidden');
    requestPersistence().then((p) => {
      this.persisted = p;
    });
    this.game.start();
    this.panels.prefetch();
    if (this.isNewGame || !this.save.flags.tutorialSeen) this.#tutorial();
    else await this.game.ensureStarterWeapon();
  }

  #tutorial() {
    const touch = this.input.mode === 'touch';
    const body = h('div.tutorial',
      h('p', 'Every weapon in this world is generated from its own Weapon DNA. No two are alike — find them, forge them, and build your own playstyle.'),
      h('ul',
        touch ? h('li', 'Left thumb: move with the joystick.') : h('li', 'WASD / arrows to move, mouse to aim.'),
        touch ? h('li', '⚔ attacks — and uses chests, shrines and altars when you stand next to them.') : h('li', 'Click, Space or J to attack. E or Space to use chests, shrines and altars.'),
        touch ? h('li', '» toggles sprint (no stamina — sprint forever).') : h('li', 'Shift to sprint (no stamina — sprint forever).'),
        touch ? h('li', '★ appears when your weapon grants an ability.') : h('li', 'Q or right-click casts your weapon\'s ability, when it has one.'),
        h('li', 'Follow the arrow at the screen edge to find the bosses.')),
      h('button.btn-primary', {
        autofocus: true,
        onclick: async () => {
          this.save.flags.tutorialSeen = true;
          closeModal(true);
          await this.game.ensureStarterWeapon();
        },
      }, 'Let\'s go'));
    openModal({ title: APP_NAME, body, locked: true, className: 'tutorial-panel' });
  }

  // --- Settings / input ---------------------------------------------------------------

  applySettings() {
    const s = this.game.save.settings;
    document.body.classList.toggle('left-handed', Boolean(s.leftHanded));
    document.documentElement.style.setProperty('--joy-scale', String(s.joystickSize ?? 1));
  }

  #applyInputMode(mode) {
    document.body.dataset.input = mode;
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      this.game.toast(`Fullscreen not available: ${err.message}`, 'warn');
    }
  }

  // --- Lifecycle ------------------------------------------------------------------------

  #lifecycle() {
    const hide = () => {
      this.game.pause('hidden');
      this.audio.suspend();
      this.game.saveNow();
    };
    const show = () => {
      this.game.resume('hidden');
      this.audio.resume();
    };
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? hide() : show()));
    addEventListener('pagehide', () => this.game.saveNow());
    addEventListener('pageshow', (e) => {
      if (e.persisted) show();
    });
    // Page Lifecycle API (Chromium): the tab may be frozen without warning.
    document.addEventListener('freeze', () => this.game.saveNow());
    document.addEventListener('resume', show);
    addEventListener('blur', () => this.input.reset());
  }

  // --- Network / sync status -----------------------------------------------------------

  #watchNetwork() {
    const el = $('#net-status');
    const update = () => {
      const online = navigator.onLine !== false;
      document.body.classList.toggle('offline', !online);
      if (el) {
        el.textContent = online ? '● Online' : '● Offline';
        el.title = online ? 'Connected' : 'Offline — the game works fully; cloud sync and update checks wait for a connection.';
      }
      this.#renderTitleStatus();
    };
    addEventListener('online', () => {
      update();
      this.game?.toast('Back online');
    });
    addEventListener('offline', () => {
      update();
      this.game?.toast('You are offline — everything keeps working and is saved on this device.', 'warn');
    });
    update();
  }

  status() {
    return {
      storage: this.storage?.kind ?? 'unknown',
      persisted: this.persisted,
      offlineReady: this.offlineReady,
      swSupported: serviceWorkerSupported(),
      standalone: isStandalone(),
      canInstall: canInstall(),
      iosInstallHint: iosInstallHint(),
      unsupported: this.support.unsupported,
      syncEnabled: this.sync.enabled,
      sync: this.syncStatus,
    };
  }

  statusLine() {
    const s = this.status();
    return [
      `v${APP_VERSION}`,
      navigator.onLine === false ? 'Offline' : 'Online',
      s.offlineReady ? 'offline-ready' : null,
      `saves: ${s.storage}`,
    ].filter(Boolean).join(' · ');
  }

  async install() {
    const ok = await promptInstall();
    if (ok) this.game.toast('Installed! Launch it from your home screen or app menu.');
    this.#renderTitleStatus();
  }

  // --- Updates --------------------------------------------------------------------------

  #onUpdateReady(apply) {
    this.updateReady = true;
    this.applyUpdateFn = apply;
    const banner = $('#update-banner');
    banner.removeAttribute('hidden');
    $('#btn-menu')?.classList.add('badge');
  }

  async applyUpdate() {
    if (!this.applyUpdateFn) return;
    if (this.game?.boss && !confirm('Updating now restarts the boss fight. Update anyway?')) return;
    $('#update-banner').setAttribute('hidden', '');
    this.game?.pause('update');
    await this.game?.saveNow();
    this.applyUpdateFn();
    // Fallback in case controllerchange never fires.
    setTimeout(() => location.reload(), 4000);
  }

  laterUpdate() {
    $('#update-banner').setAttribute('hidden', '');
    this.game?.toast('The update will install next time you start the game.');
  }

  async checkForUpdates() {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (!reg) return false;
    await reg.update();
    return Boolean(reg.installing || reg.waiting);
  }

  #onSwMessage(msg) {
    if (msg.type === 'DATA_UPDATED') {
      this.game?.toast('New game content downloaded — it applies next time you start.', 'component');
    } else if (msg.type === 'SYNC_REQUESTED') {
      this.sync?.flush();
    }
  }

  // --- Save management ------------------------------------------------------------------

  async exportSave() {
    await this.game.saveNow();
    const text = exportSave(this.game.save);
    const blob = new Blob([text], { type: 'application/json' });
    const date = new Date().toISOString().slice(0, 10);
    const a = h('a', { href: URL.createObjectURL(blob), download: `pixelgame-save-${date}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.game.toast('Save exported');
  }

  async importSave(file) {
    try {
      const imported = parseImport(await file.text());
      if (!confirm('Replace your current progress with this save? (Your current save is kept as a backup.)')) return;
      await this.saveManager.replace(imported);
      location.reload();
    } catch (err) {
      this.game.toast(err.message, 'warn');
    }
  }

  async resetSave() {
    if (!confirm('Start a brand-new world? Export your save first if you want to keep it. (A backup of the current save is kept.)')) return;
    const fresh = createNewSave({ worldSeed: randomSeed(), appVersion: APP_VERSION });
    await this.saveManager.replace(fresh);
    location.reload();
  }

  #exposeDebug() {
    window.__pixelgame = { app: this, game: this.game, data: this.data };
    console.info('[debug] window.__pixelgame exposed');
  }
}

const app = new App();
// Module scripts run after the document is parsed, so the DOM is ready here.
$('#update-now')?.addEventListener('click', () => app.applyUpdate());
$('#update-later')?.addEventListener('click', () => app.laterUpdate());
app.boot().catch((err) => {
  console.error(err);
  fatal(`Could not start: ${err.message}`);
});
