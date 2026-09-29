// Heads-up display: portrait with health/XP, resources, dock buttons,
// network status, equipped weapon, boss bar, interaction hint, toasts, and
// the touch buttons' state.

import { $, clear, h } from './dom.js';
import { weaponIconEl } from './weapon-card.js';
import { playerSprites } from '../render/sprites.js';

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
    };
    this.drawPortrait();
    game.on('hud', (s) => this.update(s));
    game.on('toast', (t) => this.toast(t.text, t.kind));
    game.on('interact', ({ label }) => this.setHint(label));
    game.on('equip', (dna) => this.setWeapon(dna));
    game.on('boss', (b) => this.el.boss.toggleAttribute('hidden', !b.active));
    game.on('levelup', ({ level }) => this.toast(`Level ${level}! You feel stronger.`, 'level'));
    game.on('death', () => this.el.death.removeAttribute('hidden'));
    game.on('respawn', () => this.el.death.setAttribute('hidden', ''));
    this.setWeapon(game.weapon?.dna ?? null);
  }

  drawPortrait() {
    const c = $('#portrait');
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(playerSprites().right[0], 0, 0);
  }

  setWeapon(dna) {
    const el = this.el.weapon;
    clear(el);
    if (!dna) return;
    const color = this.game.data.byId.rarities.get(dna.rarity)?.color;
    el.append(
      h('div.slot.framed', { style: { '--rarity': color } }, weaponIconEl(dna, 32)),
      h('span.name', { style: { color } }, dna.name.text));
    el.title = `${dna.name.text} — ${dna.identity}`;
    this.el.ability.toggleAttribute('hidden', !dna.ability);
    if (dna.ability) this.el.ability.setAttribute('aria-label', `Ability: ${dna.ability.name}`);
  }

  setHint(label) {
    const { hint, attack } = this.el;
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
    const t = h(`div.toast.toast-${kind}`, { role: 'status' }, text);
    this.el.toasts.append(t);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3700);
  }
}
