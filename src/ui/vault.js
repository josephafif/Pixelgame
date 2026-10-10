// The Vault (single player): the camp's supplies of wood, stone, scrap and
// essence. Put things in with one tap; workers bring theirs here too. The
// upkeep of walls, buildings and workers is paid from it every hour, and
// the panel says how long the supplies last.

import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal, replaceModalBody } from './modal.js';
import { upkeepBox } from './upkeep-view.js';
import { buildingLevel } from '../game/base.js';

const RES = [['wood', 'Wood'], ['stone', 'Stone'], ['scrap', 'Scrap'], ['essence', 'Essence']];

export function open(game, app) {
  const { data, save } = game;
  const wf = game.workforce;
  const rerender = () => {
    const body = document.querySelector('.vault-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  };

  function row([k, name]) {
    const own = Math.floor(save.resources[k] ?? 0);
    const stock = Math.floor(save.base.vault[k] ?? 0);
    const put = (n) => {
      if (n > 0 && game.vaultDeposit({ [k]: n })) game.audio.play('pickup');
    };
    const take = (n) => {
      if (n > 0 && game.vaultWithdraw({ [k]: n })) game.audio.play('pickup');
    };
    return h('div.vault-row', { 'data-res': k },
      h('span.vault-res', icon(k, 22), h('b', name)),
      h('span.vault-num', h('small', 'You'), h('b', String(own))),
      h('span.vault-num', h('small', 'Vault'), h('b.vault-stock', String(stock))),
      h('span.vault-btns',
        h('button.small', { disabled: own < 1, onclick: () => put(Math.min(own, 10)) }, '+10'),
        h('button.small', { disabled: own < 1, onclick: () => put(Math.min(own, 100)) }, '+100'),
        h('button.small.btn-primary', { disabled: own < 1, onclick: () => put(own) }, 'All'),
        h('button.small', { disabled: stock < 1, onclick: () => take(Math.min(stock, 100)), title: 'Take 100 out' }, '−100'),
        h('button.small', { disabled: stock < 1, onclick: () => take(stock), title: 'Take everything out' }, 'Take')));
  }

  function build() {
    const built = buildingLevel(data, save, 'vault') > 0;
    const everything = () => {
      const res = {};
      for (const [k] of RES) if ((save.resources[k] ?? 0) >= 1) res[k] = Math.floor(save.resources[k]);
      if (game.vaultDeposit(res)) game.audio.play('chest');
    };
    return h('div.vault',
      built ? null : h('p.warn.small', icon('lock', 16), ' Build the Vault at your camp to keep supplies here. Until then the upkeep is paid from what you carry.'),
      h('div.row.vault-top',
        h('button.btn-primary', { disabled: !built, onclick: everything }, icon('chest', 20), 'Put in all wood, stone, scrap and essence'),
        h('button', { onclick: () => app.panels.show('inventory', { tab: 'storage' }) }, icon('bag', 20), 'Weapon storage')),
      h('div.vault-rows', { class: built ? null : 'locked' }, RES.map(row)),
      upkeepBox({
        perDay: wf.perDay(), counts: wf.counts(), vault: save.base.vault, unpaid: save.base.unpaid, lang: 'en',
        note: 'Paid from the Vault once an hour; when it runs out, from what you carry. Unpaid, workers stop and walls crumble.',
      }),
      buildingLevel(data, save, 'lodge') > 0
        ? h('button', { onclick: () => app.panels.show('workers') }, icon('players', 20), `Workers (${save.base.workers.length})`)
        : h('p.small.muted', 'Build the Workers’ Lodge to hire workers who bring wood and stone to the Vault.'));
  }

  const offs = [game.on('base', rerender), game.on('inventory', rerender)];
  openModal({
    title: 'Vault', icon: 'chest', body: build(), className: 'vault-panel',
    onDispose: () => offs.forEach((off) => off()),
  });
}
