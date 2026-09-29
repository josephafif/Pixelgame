// Heads-up display: health/XP, resources, network status, equipped weapon,
// boss bar, interaction hint, toasts, and the touch buttons' state.

import { $, clear, h } from './dom.js';
import { weaponIconEl } from './weapon-card.js';

export class Hud {
  constructor(game) {
    this.game = game;
    this.el = {
      root: $('#hud'),
      hpFill: $('#hp-fill'),
      hpText: $('#hp-text'),
      level: $('#lvl'),
      xpFill: $('#xp-fill'),
      essence: $('#res-essence'),
      scrap: $('#res-scrap'),
      weapon: $('#hud-weapon'),
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

  setWeapon(dna) {
    const el = this.el.weapon;
    clear(el);
    if (!dna) return;
    const color = this.game.data.byId.rarities.get(dna.rarity)?.color;
    el.append(weaponIconEl(dna, 28), h('span', { style: { color } }, dna.name.text));
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
    e.hpFill.style.width = `${(100 * s.hp) / s.maxHp}%`;
    e.hpText.textContent = `${s.hp} / ${s.maxHp}`;
    e.level.textContent = `Lv ${s.level}`;
    e.xpFill.style.width = `${Math.min(100, (100 * s.xp) / s.xpNext)}%`;
    e.essence.textContent = s.essence;
    e.scrap.textContent = s.scrap;
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
      e.compass.textContent = `${s.compass.name}: ${Math.round(s.compass.dist)}m`;
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
