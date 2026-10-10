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
import { initModals, openModal, closeModal, isModalOpen, isModalLocked, isDialogOpen, closeDialog, askConfirm } from './ui/modal.js';
import { hardenBrowser, trapBackNavigation } from './pwa/harden.js';
import { showDiscovery } from './ui/discovery.js';
import { h, $ } from './ui/dom.js';
import { hydrateIcons } from './ui/icons.js';
import { registerServiceWorker, serviceWorkerSupported } from './pwa/register.js';
import { canInstall, promptInstall, isStandalone, iosInstallHint, onInstallAvailabilityChange } from './pwa/install.js';
import { detectSupport } from './pwa/support.js';

// ?mp=play starts the multiplayer game; ?mp=auth is the way back from a login.
const MP_MODE = new URLSearchParams(location.search).get('mp');

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
    this.started = false;
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
    this.mpMode = MP_MODE === 'play';
    if (this.mpMode) {
      const { MpGame } = await import('./mp/mp-game.js');
      this.game = new MpGame({
        data, save, saveManager: this.saveManager, weapons: this.weapons, renderer: this.renderer,
        input: this.input, audio: this.audio,
      });
    } else {
      this.game = new Game({
        data, save, saveManager: this.saveManager, weapons: this.weapons, renderer: this.renderer,
        input: this.input, audio: this.audio, sync: this.sync,
      });
    }
    initModals(this.game);
    this.hud = new Hud(this.game);
    if (this.mpMode) {
      const { MpPanels } = await import('./mp/panels.js');
      this.panels = new MpPanels(this.game, this);
    } else {
      this.panels = new Panels(this.game, this);
    }
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
    if (this.mpMode) {
      // Straight into the multiplayer world.
      this.enterFullscreen();
      this.audio.unlock();
      trapBackNavigation({ playing: () => this.started, back: () => this.#onBack() });
      import('./mp/lobby.js').then((m) => m.startMultiplayer(this)).then(() => this.panels.prefetch());
      return;
    }
    if (MP_MODE === 'auth') import('./mp/lobby.js').then((m) => m.handleAuthRedirect(this));
    // A friend's invitation: ?join=K7QX2M (a server's code) or ?server=host opens the lobby on it.
    const invite = new URLSearchParams(location.search);
    if (!MP_MODE && (invite.get('join') || invite.get('server'))) {
      const joinCode = invite.get('join');
      const server = invite.get('server');
      history.replaceState(null, '', location.pathname + (invite.has('debug') ? '?debug=1' : ''));
      import('./mp/lobby.js').then(async (m) => {
        const { serverUrlFrom } = await import('./mp/registry.js');
        setTimeout(() => m.openLobby(this, { joinCode, serverUrl: server ? serverUrlFrom(server) : null }), 400);
      });
    }
    const title = $('#title');
    setTimeout(() => title.removeAttribute('hidden'), 350);
    $('#title-play').textContent = this.isNewGame ? 'New adventure' : 'Continue';
    $('#title-play').addEventListener('click', () => this.#play(), { once: true });
    $('#title-install').addEventListener('click', () => this.install());
    // The rest of the main menu.
    $('#title-new')?.toggleAttribute('hidden', this.isNewGame);
    $('#title-new')?.addEventListener('click', () => this.resetSave());
    $('#title-settings')?.addEventListener('click', () => import('./ui/settings.js').then((m) => m.open(this.game, this)));
    $('#title-howto')?.addEventListener('click', () => this.#howToPlay());
    $('#title-multiplayer')?.addEventListener('click', () => this.#multiplayer());
    $('#title-workshop')?.addEventListener('click', () => this.openWorkshop());
    // Served by a game server (a friend's `npm run share` link) or opened from
    // an invitation: multiplayer first.
    if (document.querySelector('meta[name="pixelgame-server"]') || invite.get('join') || invite.get('server')) {
      const mp = $('#title-multiplayer');
      const play = $('#title-play');
      if (mp && play) {
        play.classList.remove('btn-primary', 'big');
        play.removeAttribute('autofocus');
        mp.classList.add('btn-primary', 'big');
        play.before(mp);
      }
    }
    const line = $('#title-save');
    if (line && !this.isNewGame) {
      const pl = this.save.player;
      const inv = this.save.inventory;
      const mins = Math.floor((pl.playTime ?? 0) / 60);
      line.textContent = `Level ${pl.level} · ${inv.bag.length + inv.storage.length} weapons · ${mins >= 60 ? `${Math.floor(mins / 60)} h ` : ''}${mins % 60} min played`;
      line.removeAttribute('hidden');
    }
    onInstallAvailabilityChange(() => this.#renderTitleStatus());
    this.#renderTitleStatus();
    if (this.bootWarning) this.game.toast(this.bootWarning, 'warn');
    // The world lives behind the menu: redraw it (so every chunk fills in)
    // while the camera drifts slowly across the landscape.
    const t0 = performance.now();
    const frame = (now) => {
      if (this.started) return;
      const t = (now - t0) / 1000;
      this.renderer.pan.x = Math.sin(t * 0.05) * 14 + t * 0.35;
      this.renderer.pan.y = Math.cos(t * 0.04) * 6;
      this.renderer.draw(this.game);
      this.titleRaf = requestAnimationFrame(frame);
    };
    this.titleRaf = requestAnimationFrame(frame);
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

  /** Phones/tablets: fill the whole screen (no browser bars). Needs a tap. */
  enterFullscreen() {
    const touch = matchMedia('(pointer: coarse)').matches;
    if (!touch || !this.game?.save.settings.autoFullscreen || !document.fullscreenEnabled || document.fullscreenElement) return;
    if (matchMedia('(display-mode: fullscreen)').matches) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }

  async #play() {
    this.enterFullscreen();
    this.started = true;
    cancelAnimationFrame(this.titleRaf);
    this.renderer.pan.x = 0;
    this.renderer.pan.y = 0;
    this.renderer.snapCamera();
    this.audio.unlock();
    $('#title').setAttribute('hidden', '');
    $('#hud').removeAttribute('hidden');
    this.input.reset();
    requestPersistence().then((p) => {
      this.persisted = p;
    });
    this.game.start();
    this.panels.prefetch();
    trapBackNavigation({
      playing: () => this.started,
      back: () => this.#onBack(),
    });
    if (this.isNewGame || !this.save.flags.tutorialSeen) this.#tutorial();
    else await this.game.ensureStarterWeapon();
  }

  /** Phone back button: close what's open, else open the menu; leave from the menu. */
  #onBack() {
    if (isDialogOpen()) {
      closeDialog(false);
      return 'handled';
    }
    if (isModalOpen()) {
      if (this.panels.open === 'menu') {
        this.game.saveNow();
        if (this.mpMode) this.game.disconnect();
        return 'leave';
      }
      if (!isModalLocked()) closeModal();
      return 'handled';
    }
    if (this.game.build.active) {
      this.game.toggleBuildMode(false);
      return 'handled';
    }
    this.panels.show('menu');
    return 'handled';
  }

  /** Controls and first steps (shown on a new game and from the main menu). */
  #howToList() {
    const touch = this.input.mode === 'touch';
    return [
      h('p', 'Every weapon in this world is generated from its own Weapon DNA. No two are alike — find them, forge them, and build your own playstyle.'),
      h('ul',
        touch ? h('li', 'Left thumb: move with the joystick.') : h('li', 'WASD / arrows to move.'),
        h('li', 'Your weapon aims itself at the nearest enemy — just attack.'),
        touch ? h('li', 'The sword button attacks — and uses chests, shrines and buildings when you stand next to them.') : h('li', 'Click, Space or J to attack. E or Space to use chests, shrines and buildings.'),
        touch ? h('li', 'The boot toggles sprint (no stamina — sprint forever).') : h('li', 'Shift to sprint (no stamina — sprint forever).'),
        touch ? h('li', 'The star appears when your weapon grants an ability.') : h('li', 'Q or right-click casts your weapon\'s ability, when it has one.'),
        h('li', 'Your camp is at the centre of the world. Build a Forge, forge a pickaxe, and gather wood and stone to upgrade your camp and raise walls and turrets (G / hammer button).'),
        h('li', 'Enemies only notice you when you get close. Rarer weapons shine brighter on the ground.'),
        h('li', 'Follow the arrow at the top-left to find the bosses.'),
        h('li', 'Press 1, 2 and 3 (or tap the hotbar) for your main weapon, second weapon and pickaxe; press the same one again to put it away.'),
        h('li', 'Far out lie seas and islands: build a boat at the Forge to sail there — but beware of what swims beneath.'),
        h('li', 'Villages dot the land, with traders on the green. At home, a Workers\u2019 Lodge lets you hire workers who chop and mine for you; keep supplies in the Vault to pay their wages and the camp\u2019s upkeep.'),
        h('li', 'The Weapon Workshop (main menu) lets you make and change any weapon you like and share its code.'),
        h('li', touch
          ? 'Rare Pal Eggs hatch at the Pal Den into pals that fight with you or gather wood and stone (menu → Pals).'
          : 'Rare Pal Eggs hatch at the Pal Den into pals that fight with you or gather wood and stone (H).'))];
  }

  /** The Weapon Workshop: make and change any weapon, copy its code. */
  openWorkshop(opts = {}) {
    import('./ui/workshop.js')
      .then((m) => m.open(this.game, this, opts))
      .catch((err) => this.game.toast(`The workshop could not open: ${err.message}`, 'warn'));
  }

  #howToPlay() {
    const body = h('div.tutorial', this.#howToList(),
      h('button.btn-primary', { autofocus: true, onclick: () => closeModal() }, 'Got it'));
    openModal({ title: 'How to play', icon: 'book', body, className: 'tutorial-panel' });
  }

  #multiplayer() {
    import('./mp/lobby.js')
      .then((m) => m.openLobby(this))
      .catch((err) => this.game.toast(`Multiplayer kunde inte laddas: ${err.message}`, 'warn'));
  }

  #tutorial() {
    const body = h('div.tutorial',
      this.#howToList(),
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
    if (this.game?.boss && !await askConfirm({ title: 'Update now?', text: 'Updating now restarts the boss fight. Update anyway?', ok: 'Update' })) return;
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
      if (!await askConfirm({ title: 'Import save?', text: 'Replace your current progress with this save? (Your current save is kept as a backup.)', ok: 'Replace', danger: true })) return;
      await this.saveManager.replace(imported);
      location.reload();
    } catch (err) {
      this.game.toast(err.message, 'warn');
    }
  }

  async resetSave() {
    if (!await askConfirm({ title: 'New world?', text: 'Start a brand-new world? Export your save first if you want to keep it. (A backup of the current save is kept.)', ok: 'New world', danger: true })) return;
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
hydrateIcons();
hardenBrowser({
  playing: () => app.started && !isModalOpen(),
  save: () => app.game?.saveNow().then((ok) => ok && app.game.toast('Game saved')),
});
$('#update-now')?.addEventListener('click', () => app.applyUpdate());
$('#update-later')?.addEventListener('click', () => app.laterUpdate());
app.boot().catch((err) => {
  console.error(err);
  fatal(`Could not start: ${err.message}`);
});
