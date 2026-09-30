// Pals panel: the pal walking with you (level, stats, what it does, upgrade),
// your other pals, and your eggs (warm one in the Pal Den to hatch it).

import { h, pixelCanvas } from './dom.js';
import { icon, costChips } from './icons.js';
import { openModal, replaceModalBody, closeModal } from './modal.js';
import { palSprites } from '../render/creatures.js';
import { pickupSprite } from '../render/sprites.js';
import { buildingLevel } from '../game/base.js';
import {
  palSpecies, palStats, palLevelCap, upgradeCost, palUpgradeBlockers, hatchBlockers, activePal, eggChance,
  PAL_MODES, MODE_LABEL,
} from '../game/pals.js';

const MODE_HELP = {
  fight: 'Fights the monsters around you.',
  gather: 'Chops trees and breaks rocks near you and hands you the wood and stone.',
  follow: 'Just tags along.',
};

function portrait(data, species, size = 64) {
  const sp = palSpecies(data, species);
  const img = palSprites(species, sp?.color ?? '#6ad35a').idle.right[0];
  const c = pixelCanvas(img);
  c.style.width = `${img.width * (size / 12)}px`;
  c.style.height = `${img.height * (size / 12)}px`;
  return h('div.pal-art', c);
}

function eggArt(data, egg) {
  const sp = palSpecies(data, egg.species);
  const c = pixelCanvas(pickupSprite('egg', sp?.color ?? '#9cf07a'));
  c.style.width = '42px';
  c.style.height = '48px';
  return h('div.pal-art.egg', { class: egg.hatchAt ? 'warming' : null }, c);
}

function pct(f) {
  if (f >= 1) return 'Always';
  const p = f * 100;
  return p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

export function open(game, app) {
  const { data, save } = game;

  function statRow(label, now, next) {
    return h('div.pal-stat', h('span.muted', label), h('b', now), next != null && next !== now ? h('span.next', ` → ${next}`) : null);
  }

  function activeCard(pal) {
    const sp = palSpecies(data, pal.species);
    const stats = palStats(data, pal.species, pal.level);
    const cap = palLevelCap(data, save);
    const maxed = pal.level >= data.pals.maxLevel;
    const next = maxed ? null : palStats(data, pal.species, pal.level + 1);
    const blockers = palUpgradeBlockers(data, save, pal);
    const hard = blockers.filter((b) => !/^Needs \d+ more /.test(b));
    const live = game.pal?.id === pal.id ? game.pal : null;
    return h('article.bcard.pal-card.active', { 'data-pal': pal.id },
      h('div.bcard-top',
        portrait(data, pal.species),
        h('div',
          h('h3', pal.name),
          h('div.small', { style: { color: sp?.color } }, sp?.role ?? ''),
          h('div.small.muted', `Level ${pal.level} / ${data.pals.maxLevel}${cap < data.pals.maxLevel ? ` (Den allows ${cap})` : ''}`),
          live?.state === 'down' ? h('div.small.warn', `Knocked out — back in ${Math.max(0, Math.ceil(live.downUntil - game.time))}s`) : null)),
      h('p.desc', sp?.desc ?? ''),
      h('div.pal-stats',
        statRow('Health', stats.maxHp, next?.maxHp),
        statRow('Damage', stats.damage, next?.damage),
        statRow('Gathering', stats.gatherPower, next?.gatherPower),
        statRow('Speed', stats.speed.toFixed(1), next?.speed.toFixed(1))),
      h('div.pal-modes', { role: 'radiogroup', 'aria-label': 'What your pal does' },
        PAL_MODES.map((m) => h('button.chip', {
          class: save.pals.mode === m ? 'on' : null,
          role: 'radio',
          'aria-checked': String(save.pals.mode === m),
          'data-mode': m,
          onclick: () => game.setPalMode(m),
        }, icon(m === 'fight' ? 'sword' : m === 'gather' ? 'pickaxe' : 'pal', 16), MODE_LABEL[m]))),
      h('p.small.muted', MODE_HELP[save.pals.mode] ?? ''),
      stats.gatherTier < 2 && save.pals.mode === 'gather' ? h('p.small.muted', 'Crystals need a level 5 pal.') : null,
      hard.length ? h('div.req', icon('lock', 16), ' ', hard.join(' · ')) : null,
      h('div.row',
        maxed ? h('span.badge', 'Max level') : costChips(upgradeCost(data, pal.level), save.resources),
        maxed ? null : h(`button${blockers.length ? '' : '.btn-primary'}`, {
          disabled: blockers.length > 0,
          'data-action': 'upgrade',
          onclick: () => game.upgradePal(pal.id),
        }, icon('up', 20), 'Upgrade'),
        h('button', { onclick: () => game.setActivePal(null) }, 'Leave at camp')));
  }

  function restingCard(pal) {
    const sp = palSpecies(data, pal.species);
    return h('article.bcard.pal-card', { 'data-pal': pal.id },
      h('div.bcard-top',
        portrait(data, pal.species, 48),
        h('div',
          h('h3', pal.name),
          h('div.small', { style: { color: sp?.color } }, `${sp?.role ?? ''} · level ${pal.level}`),
          h('div.small.muted', 'Resting at camp'))),
      h('div.row', h('button.btn-primary', { onclick: () => game.setActivePal(pal.id) }, icon('pal', 20), 'Take along')));
  }

  function eggCard(egg) {
    const left = egg.hatchAt ? Math.max(0, Math.ceil((egg.hatchAt - Date.now()) / 1000)) : null;
    const blockers = hatchBlockers(data, save, egg);
    const hard = blockers.filter((b) => !/^Needs \d+ more /.test(b));
    return h('article.bcard.pal-card.egg-card', { 'data-egg': egg.id },
      h('div.bcard-top',
        eggArt(data, egg),
        h('div',
          h('h3', 'Pal Egg'),
          h('div.small.muted', egg.hatchAt ? `Warming in the Den… hatches in ${left}s` : 'Something is moving inside.'))),
      egg.hatchAt ? h('div.meter', h('div', {
        style: { width: `${Math.min(100, 100 - (100 * left) / data.pals.hatchSeconds)}%` },
      })) : null,
      !egg.hatchAt && hard.length ? h('div.req', icon('lock', 16), ' ', hard.join(' · ')) : null,
      egg.hatchAt ? null : h('div.row',
        costChips({ essence: data.pals.hatchEssence }, save.resources),
        h(`button${blockers.length ? '' : '.btn-primary'}`, {
          disabled: blockers.length > 0,
          'data-action': 'hatch',
          onclick: () => game.hatchEgg(egg.id),
        }, 'Warm in Den')));
  }

  function build() {
    const den = buildingLevel(data, save, 'den');
    const active = activePal(save);
    const resting = save.pals.owned.filter((p) => p.id !== active?.id);
    const sources = [
      ['First kill of each boss', eggChance(data, 'bossFirst')],
      ['Boss (again)', eggChance(data, 'boss')],
      ['Buried island treasure', eggChance(data, 'treasure')],
      ['Sea serpent', eggChance(data, 'serpent')],
      ['Elite monster', eggChance(data, 'elite')],
    ];
    return h('div.pals',
      h('p.small.muted', 'Pals follow you around and fight at your side or gather wood and stone. '
        + 'They hatch from rare Pal Eggs, and grow stronger with essence and materials.'),
      den < 1 ? h('div.notice',
        icon('lock', 16), ' Build a Pal Den at your camp to hatch eggs and raise pals.',
        h('button', { onclick: () => app.panels.show('base', { focus: 'den' }) }, icon('home', 20), 'Camp')) : null,
      active ? activeCard(active) : null,
      !active && !save.pals.owned.length && !save.pals.eggs.length
        ? h('div.empty-pals', icon('pal', 48), h('p', 'No pals yet. Find a Pal Egg out in the world!'))
        : null,
      save.pals.eggs.length || resting.length
        ? h('div.base-grid', save.pals.eggs.map(eggCard), resting.map(restingCard))
        : null,
      h('details.egg-odds',
        h('summary', 'Where to find Pal Eggs'),
        h('table.odds-table', h('tbody', sources.map(([label, chance]) => h('tr', h('th', label), h('td.num', pct(chance))))))));
  }

  const rerender = () => {
    const body = document.querySelector('.pals-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  };
  // Countdowns (hatching eggs, a knocked-out pal) tick once a second.
  const timer = setInterval(() => {
    if (!save.pals.eggs.some((e) => e.hatchAt) && game.pal?.state !== 'down') return;
    game.checkHatch();
    rerender();
  }, 1000);
  const offs = [game.on('pals', rerender), game.on('inventory', rerender)];
  openModal({
    title: 'Pals', icon: 'pal', body: build(), className: 'wide pals-panel',
    onDispose: () => {
      clearInterval(timer);
      offs.forEach((off) => off());
    },
  });
  return { close: closeModal };
}
