// Unified input: touch (virtual joystick + on-screen buttons), mouse and
// keyboard, and gamepads all feed the same small action state, so every
// control works with every input method.
//
// Touch: a joystick on the left half of the play area (right half in
// left-handed mode). Touching the other half aims and attacks toward the
// finger. The game area uses `touch-action: none`, so these gestures never
// scroll or zoom the page, while menus and panels stay scrollable.

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'attack', KeyJ: 'attack', Enter: 'attack',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyQ: 'ability', KeyK: 'ability',
  KeyE: 'interact', KeyF: 'interact',
  KeyI: 'inventory', KeyC: 'crafting', KeyR: 'research', KeyM: 'map',
  Escape: 'menu', KeyP: 'menu',
};

const DEADZONE = 0.18;
const UI_ACTIONS = new Set(['inventory', 'crafting', 'research', 'menu', 'map', 'back']);

export class Input {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.surface element receiving play-area pointer input
   * @param {HTMLElement} opts.joystick joystick base element
   * @param {HTMLElement} opts.knob joystick knob element
   * @param {{attack: HTMLElement, sprint: HTMLElement, ability: HTMLElement}} opts.buttons
   * @param {() => object} opts.settings returns current settings
   */
  constructor({ surface, joystick, knob, buttons, settings }) {
    this.surface = surface;
    this.joyEl = joystick;
    this.knobEl = knob;
    this.buttons = buttons;
    this.settings = settings;

    this.keys = new Set();
    this.move = { x: 0, y: 0 };
    this.joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.aimTouch = { id: null, x: 0, y: 0 };
    this.pointer = { x: 0, y: 0, active: false, lastMove: 0 };
    this.mouseAttack = false;
    this.touchAttack = false;
    this.buttonAttack = false;
    this.keyAttack = false;
    this.padAttack = false;
    this.sprintToggle = false;
    this.sprintHeld = false;
    this.padAim = null;
    this.commands = [];
    this.mode = matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'keyboard';
    this.enabled = true;
    this.padPrev = [];
    this.onModeChange = () => {};
    // UI commands (open inventory, menu, ...) are dispatched immediately so
    // they also work while the game is paused behind a panel.
    this.onUiCommand = null;
    this.#bind();
  }

  #setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onModeChange(mode);
  }

  #command(name) {
    if (UI_ACTIONS.has(name) && this.onUiCommand) this.onUiCommand(name);
    else this.commands.push(name);
  }

  get joystickRadius() {
    const base = Math.min(innerWidth, innerHeight) * 0.13;
    return Math.max(40, Math.min(90, base)) * (this.settings().joystickSize ?? 1);
  }

  #isJoystickSide(clientX) {
    const left = clientX < innerWidth / 2;
    return this.settings().leftHanded ? !left : left;
  }

  #bind() {
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const action = KEYMAP[e.code];
      if (!action) return;
      this.#setMode('keyboard');
      // Inside dialogs, Space/Enter/arrows belong to the focused control.
      const inDialog = e.target instanceof Element && e.target.closest('#overlay-root, #title, #update-banner');
      if (inDialog && !UI_ACTIONS.has(action)) return;
      if (UI_ACTIONS.has(action)) {
        if (!e.repeat) this.#command(action);
        e.preventDefault();
        return;
      }
      if (!this.enabled) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(action);
      if (action === 'ability') this.#command('ability');
      // Attack doubles as Use: the game interacts instead when something usable is near.
      if (action === 'interact' || action === 'attack') this.#command('interact');
      if (action === 'sprint') this.#pressSprint();
    });
    addEventListener('keyup', (e) => {
      const action = KEYMAP[e.code];
      if (!action) return;
      this.keys.delete(action);
      if (action === 'sprint') this.sprintHeld = false;
    });
    addEventListener('blur', () => this.reset());

    const s = this.surface;
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    s.addEventListener('pointermove', (e) => this.#pointerMove(e));
    s.addEventListener('pointerup', (e) => this.#pointerUp(e));
    s.addEventListener('pointercancel', (e) => this.#pointerUp(e));
    s.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.pointer.active = false;
    });

    const hold = (el, onDown, onUp) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('pressed');
        if (e.pointerType !== 'mouse') this.#setMode('touch');
        onDown();
      });
      const up = (e) => {
        el.classList.remove('pressed');
        e.stopPropagation();
        onUp?.();
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      // Keyboard activation for accessibility (Enter/Space on a focused button).
      el.addEventListener('click', (e) => {
        if (e.detail === 0) onDown(true);
      });
    };
    hold(this.buttons.attack, (kbd) => {
      if (kbd) this.#command('interact-or-attack');
      else {
        this.buttonAttack = true;
        this.#command('interact');
      }
    }, () => { this.buttonAttack = false; });
    hold(this.buttons.sprint, () => this.#pressSprint(), () => { this.sprintHeld = false; });
    hold(this.buttons.ability, () => this.#command('ability'));
  }

  #pressSprint() {
    if (this.settings().sprintMode === 'hold') this.sprintHeld = true;
    else this.sprintToggle = !this.sprintToggle;
  }

  #pointerDown(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse') {
      this.#setMode('keyboard');
      this.pointer = { x: e.clientX, y: e.clientY, active: true, lastMove: performance.now() };
      if (e.button === 0) this.mouseAttack = true;
      if (e.button === 2) this.#command('ability');
      return;
    }
    e.preventDefault();
    this.#setMode('touch');
    this.surface.setPointerCapture?.(e.pointerId);
    if (this.joy.id === null && this.#isJoystickSide(e.clientX)) {
      const fixed = this.settings().joystickMode === 'fixed';
      const r = this.joystickRadius;
      const ox = fixed ? (this.settings().leftHanded ? innerWidth - r * 1.6 : r * 1.6) : e.clientX;
      const oy = fixed ? innerHeight - r * 1.6 : e.clientY;
      this.joy = { id: e.pointerId, ox, oy, x: 0, y: 0 };
      this.#updateJoystick(e.clientX, e.clientY);
      this.joyEl.classList.add('active');
    } else if (this.aimTouch.id === null) {
      this.aimTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.touchAttack = true;
    }
  }

  #pointerMove(e) {
    if (e.pointerType === 'mouse') {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.active = true;
      this.pointer.lastMove = performance.now();
      return;
    }
    if (e.pointerId === this.joy.id) this.#updateJoystick(e.clientX, e.clientY);
    else if (e.pointerId === this.aimTouch.id) {
      this.aimTouch.x = e.clientX;
      this.aimTouch.y = e.clientY;
    }
  }

  #pointerUp(e) {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) this.mouseAttack = false;
      return;
    }
    if (e.pointerId === this.joy.id) {
      this.joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
      this.joyEl.classList.remove('active');
      this.joyEl.style.left = this.joyEl.style.top = this.joyEl.style.width = this.joyEl.style.height = '';
      this.knobEl.style.transform = 'translate(-50%, -50%)';
    } else if (e.pointerId === this.aimTouch.id) {
      this.aimTouch.id = null;
      this.touchAttack = false;
    }
  }

  #updateJoystick(cx, cy) {
    const r = this.joystickRadius;
    let dx = cx - this.joy.ox;
    let dy = cy - this.joy.oy;
    const len = Math.hypot(dx, dy);
    if (len > r) {
      dx = (dx / len) * r;
      dy = (dy / len) * r;
    }
    this.joy.x = dx / r;
    this.joy.y = dy / r;
    const el = this.joyEl;
    el.style.left = `${this.joy.ox}px`;
    el.style.top = `${this.joy.oy}px`;
    el.style.width = el.style.height = `${r * 2}px`;
    this.knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  #pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return null;
    const ax = (i) => (Math.abs(pad.axes[i] ?? 0) > DEADZONE ? pad.axes[i] : 0);
    const pressed = (i) => Boolean(pad.buttons[i]?.pressed);
    const edge = (i) => pressed(i) && !this.padPrev[i];
    const move = { x: ax(0), y: ax(1) };
    const aim = { x: ax(2), y: ax(3) };
    const any = move.x || move.y || aim.x || aim.y || pad.buttons.some((b) => b.pressed);
    if (any) this.#setMode('gamepad');
    this.padAttack = pressed(0) || pressed(7);
    if (edge(0)) this.#command('interact');
    if (edge(2)) this.#command('ability');
    if (edge(3)) this.#command('inventory');
    if (edge(9)) this.#command('menu');
    if (edge(1)) this.#command('back');
    if (this.settings().sprintMode === 'hold') {
      if (this.mode === 'gamepad') this.sprintHeld = pressed(4) || pressed(10);
    } else if (edge(4) || edge(10)) {
      this.sprintToggle = !this.sprintToggle;
    }
    this.padPrev = pad.buttons.map((b) => b.pressed);
    this.padAim = aim.x || aim.y ? aim : null;
    return move;
  }

  reset() {
    this.commands = [];
    this.keys.clear();
    this.mouseAttack = this.touchAttack = this.buttonAttack = this.padAttack = false;
    this.sprintHeld = false;
    this.joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.aimTouch.id = null;
    this.joyEl?.classList.remove('active');
  }

  /**
   * Samples the current state. Commands (edge-triggered actions) are
   * drained each call.
   */
  sample() {
    const padMove = this.#pollGamepad();
    let x = 0;
    let y = 0;
    if (this.keys.has('left')) x -= 1;
    if (this.keys.has('right')) x += 1;
    if (this.keys.has('up')) y -= 1;
    if (this.keys.has('down')) y += 1;
    if (x || y) {
      const len = Math.hypot(x, y);
      x /= len;
      y /= len;
    } else if (this.joy.id !== null) {
      const len = Math.hypot(this.joy.x, this.joy.y);
      if (len > DEADZONE) {
        const scaled = Math.min(1, (len - DEADZONE) / (1 - DEADZONE));
        x = (this.joy.x / len) * scaled;
        y = (this.joy.y / len) * scaled;
      }
    } else if (padMove && (padMove.x || padMove.y)) {
      x = padMove.x;
      y = padMove.y;
    }
    this.keyAttack = this.keys.has('attack');
    const commands = this.commands;
    this.commands = [];
    let aimScreen = null;
    if (this.aimTouch.id !== null) aimScreen = { x: this.aimTouch.x, y: this.aimTouch.y };
    else if (this.mode === 'keyboard' && this.pointer.active && performance.now() - this.pointer.lastMove < 4000) {
      aimScreen = { x: this.pointer.x, y: this.pointer.y };
    }
    return {
      moveX: this.enabled ? x : 0,
      moveY: this.enabled ? y : 0,
      attack: this.enabled && (this.mouseAttack || this.touchAttack || this.buttonAttack || this.keyAttack || this.padAttack),
      sprint: this.settings().sprintMode === 'hold' ? this.sprintHeld : this.sprintToggle,
      aimScreen,
      aimStick: this.padAim,
      commands,
      mode: this.mode,
    };
  }
}
