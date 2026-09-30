// Heads-up display: portrait with health/XP, resources, dock buttons,
// network status, equipped weapon, boss bar, interaction hint, toasts, and
// the touch buttons' state.

import { $, clear, h, pixelCanvas } from './dom.js';
import { weaponIconEl } from './weapon-card.js';
import { playerSprites } from '../render/sprites.js';
import { pickaxeSprite } from '../render/structures.js';
import { currentPickaxe } from '../game/gathering.js';
import { icon } from './icons.js';

export class Hud {
  constructor(game) {
    this.game = game;
    this.el = {
      root: $('#hud'),
      hpBar: $('#hp-bar'),
      hpFill: $('#hp-fill'),
      hpText: $('#hp-text'),
      level: $('#lvl'),
      xpFill: $('#xp-fill'),
      essence: $('#res-essence'),
      scrap: $('#res-scrap'),
      wood: $('#res-wood'),
      stone: $('#res-stone'),
      buildBtn: $('#btn-build'),
      weapon: $('#hud-weapon'),
      campBtn: $('#btn-base'),
      boss: $('#boss-bar'),
      bossName: $('#boss-name'),
      bossFill: $('#boss-fill'),
      hint: $('#interact-hint'),
      toasts: $('#toasts'),
      ability: $('#btn-ability'),
      abilityCd: $('#btn-ability .cd'),
      attack: $('#btn-attack'),
      sprint: $('#btn-sprint'),
      fps: $('#fps'),
      compass: $('#compass'),
      death: $('#death'),
      hotbar: $('#hotbar'),
      resRow: document.querySelector('.res-row'),
    };
    // Phones get a compact HUD: fewer, shorter notices and a quieter resource bar.
    this.compact = globalThis.matchMedia?.('(max-width: 640px), (max-height: 520px)');
    for (const btn of this.el.hotbar?.querySelectorAll('.hslot') ?? []) {
      btn.addEventListener('pointerdown', (e) => {
        // Don't let the tap reach the game or keep focus.
        e.preventDefault();
        e.stopPropagation();
        game.switchSlot(btn.dataset.slot);
      });
    }
    this.drawPortrait();
    game.on('hud', (s) => this.update(s));
    game.on('toast', (t) => this.toast(t.text, t.kind));
    game.on('interact', ({ label }) => this.setHint(label));
    game.on('equip', (dna) => this.setWeapon(dna));
    game.on('slot', () => this.setWeapon(game.weapon?.dna ?? null));
    game.on('inventory', () => this.renderHotbar());
    game.on('tools', () => this.renderHotbar());
    game.on('boss', (b) => this.el.boss.toggleAttribute('hidden', !b.active));
    game.on('levelup', ({ level }) => this.toast(`Level ${level}! You feel stronger.`, 'level'));
    game.on('death', () => this.el.death.removeAttribute('hidden'));
    game.on('respawn', () => this.el.death.setAttribute('hidden', ''));
    game.on('build', ({ active }) => {
      this.el.attack.classList.toggle('build', active);
      this.el.attack.setAttribute('aria-label', active ? 'Place' : 'Attack');
      this.el.buildBtn?.classList.toggle('on', active);
      this.el.hotbar?.toggleAttribute('hidden', active);
    });
    this.setWeapon(game.weapon?.dna ?? null);
  }

  drawPortrait() {
    const c = $('#portrait');
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(playerSprites().right[0], 0, 0);
  }

  /** Adds a class for a while (restarting the timer if already set). */
  #light(el, cls, ms) {
    if (!el) return;
    el.classList.add(cls);
    clearTimeout(el[`_${cls}`]);
    el[`_${cls}`] = setTimeout(() => el.classList.remove(cls), ms);
  }

  setWeapon(dna) {
    const el = this.el.weapon;
    clear(el);
    // On phones the weapon name only shows for a moment after you switch.
    this.#light(el, 'show', 2200);
    this.renderHotbar();
    const g = this.game;
    this.el.attack.classList.toggle('unarmed', g.handsEmpty);
    if (g.toolActive) {
      const tool = currentPickaxe(g.data, g.save);
      const art = pixelCanvas(pickaxeSprite(tool.color));
      art.style.width = '24px';
      art.style.height = '28px';
      el.append(h('div.slot.framed', art), h('span.name', tool.name));
      el.title = `${tool.name}: chop trees and break rocks`;
      this.el.ability.setAttribute('hidden', '');
      return;
    }
    if (g.handsEmpty) {
      el.append(h('div.slot.framed.empty-hands', icon('hand', 22)), h('span.name.muted', 'Empty hands'));
      el.title = 'Nothing in hand: press 1, 2 or 3 to take something out';
      this.el.ability.setAttribute('hidden', '');
      return;
    }
    if (!dna) return;
    const color = g.data.byId.rarities.get(dna.rarity)?.color;
    el.append(
      h(`div.slot.framed.r-${dna.rarity}`, { style: { '--rarity': color } }, weaponIconEl(dna, 32)),
      h('span.name', { style: { color } }, dna.name.text));
    el.title = `${dna.name.text} — ${dna.identity}`;
    this.el.ability.toggleAttribute('hidden', !dna.ability);
    if (dna.ability) this.el.ability.setAttribute('aria-label', `Ability: ${dna.ability.name}`);
  }

  /** The three loadout slots: main weapon, secondary weapon, pickaxe. */
  renderHotbar() {
    const bar = this.el.hotbar;
    if (!bar) return;
    const g = this.game;
    const inv = g.save.inventory;
    const active = g.activeSlot;
    const fill = (slot, node, color, title) => {
      const btn = bar.querySelector(`[data-slot="${slot}"]`);
      const art = btn.querySelector('.art');
      clear(art).append(node);
      btn.classList.toggle('on', active === slot);
      btn.style.setProperty('--rarity', color ?? 'transparent');
      btn.title = title;
    };
    for (const slot of ['main', 'secondary']) {
      const id = slot === 'main' ? inv.equipped : inv.secondary;
      const dna = id ? inv.bag.find((w) => w.id === id) : null;
      const color = dna ? g.data.byId.rarities.get(dna.rarity)?.color : null;
      fill(slot, dna ? weaponIconEl(dna, 32) : h('span.plus', '+'), color,
        dna ? `${slot === 'main' ? 'Main' : 'Secondary'}: ${dna.name.text}` : `${slot === 'main' ? 'Main' : 'Secondary'} weapon (empty — pick one in the inventory)`);
      bar.querySelector(`[data-slot="${slot}"]`).classList.toggle('empty', !dna);
    }
    const tool = currentPickaxe(g.data, g.save);
    if (tool) {
      const art = pixelCanvas(pickaxeSprite(tool.color));
      art.style.width = '24px';
      art.style.height = '28px';
      fill('tool', art, null, tool.name);
    } else {
      fill('tool', icon('lock', 20), null, 'Pickaxe slot: forge a pickaxe at the Forge');
    }
    bar.querySelector('[data-slot="tool"]').classList.toggle('empty', !tool);
  }

  setHint(label) {
    const { hint, attack } = this.el;
    if (this.game.build.active) label = null;
    if (label) {
      hint.textContent = this.game.input.mode === 'keyboard' ? `E / Space — ${label}` : label;
      hint.removeAttribute('hidden');
      attack.classList.add('use');
      attack.setAttribute('aria-label', label);
    } else {
      hint.setAttribute('hidden', '');
      attack.classList.remove('use');
      attack.setAttribute('aria-label', 'Attack');
    }
  }

  update(s) {
    const e = this.el;
    const hpFrac = s.hp / s.maxHp;
    e.hpFill.style.width = `${100 * hpFrac}%`;
    e.hpText.textContent = `${s.hp} / ${s.maxHp}`;
    e.hpBar.classList.toggle('low', hpFrac < 0.3 && !s.dead);
    e.level.textContent = s.level;
    e.xpFill.style.width = `${Math.min(100, (100 * s.xp) / s.xpNext)}%`;
    e.essence.textContent = s.essence;
    e.scrap.textContent = s.scrap;
    if (e.wood) e.wood.textContent = s.wood;
    if (e.stone) e.stone.textContent = s.stone;
    // The resource bar lights up for a few seconds whenever something changes.
    const res = `${s.essence}|${s.scrap}|${s.wood}|${s.stone}`;
    if (res !== this.lastRes) {
      if (this.lastRes !== undefined) this.#light(e.resRow, 'lit', 4000);
      this.lastRes = res;
    }
    e.buildBtn?.toggleAttribute('hidden', !s.nearCamp && !s.building);
    e.campBtn?.classList.toggle('alert', Boolean(s.campAlert));
    const sprintOn = this.game.save.settings.sprintMode === 'hold' ? s.sprinting : this.game.input.sprintToggle;
    e.sprint.classList.toggle('on', sprintOn);
    e.sprint.setAttribute('aria-pressed', String(sprintOn));
    if (s.ability) {
      const frac = s.ability.ready ? 0 : s.ability.left / s.ability.total;
      e.ability.style.setProperty('--cd', `${Math.round(frac * 360)}deg`);
      e.ability.classList.toggle('ready', s.ability.ready);
      e.abilityCd.textContent = s.ability.ready ? '' : Math.ceil(s.ability.left);
    }
    if (s.boss) {
      e.bossName.textContent = `${s.boss.name}${s.boss.phase === 2 ? ' — ENRAGED' : ''}`;
      e.bossFill.style.width = `${(100 * Math.max(0, s.boss.hp)) / s.boss.maxHp}%`;
    }
    if (this.game.save.settings.showFps) {
      e.fps.textContent = `${s.fps} fps · ${this.game.qualityLevel}`;
      e.fps.removeAttribute('hidden');
    } else {
      e.fps.setAttribute('hidden', '');
    }
    if (s.compass && s.compass.dist > 18) {
      const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
      const dir = arrows[((Math.round(s.compass.angle / (Math.PI / 4)) % 8) + 8) % 8];
      e.compass.textContent = `${dir} ${s.compass.name} · ${Math.round(s.compass.dist)}m`;
      e.compass.style.color = s.compass.color;
      e.compass.removeAttribute('hidden');
    } else {
      e.compass.setAttribute('hidden', '');
    }
  }

  toast(text, kind = 'info') {
    const box = this.el.toasts;
    const compact = this.compact?.matches;
    const life = compact ? 2600 : 3200;
    // The same message again just counts up ("×3") instead of stacking.
    const last = box.lastElementChild;
    if (last && last.dataset.text === text && !last.classList.contains('out')) {
      last.dataset.count = String(Number(last.dataset.count ?? 1) + 1);
      last.querySelector('.count').textContent = ` ×${last.dataset.count}`;
      this.#expire(last, life);
      return;
    }
    const t = h(`div.toast.toast-${kind}`, { role: 'status' }, text, h('span.count'));
    t.dataset.text = text;
    box.append(t);
    // Too many: plain notices give way before important ones (finds, bosses, loot).
    while (box.children.length > (compact ? 2 : 4)) {
      const plain = [...box.children].find((c) => c.classList.contains('toast-info') || c.classList.contains('toast-warn'));
      (plain ?? box.firstChild).remove();
    }
    this.#expire(t, life);
  }

  #expire(t, life) {
    clearTimeout(t._out);
    clearTimeout(t._rm);
    t._out = setTimeout(() => t.classList.add('out'), life);
    t._rm = setTimeout(() => t.remove(), life + 500);
  }
}
