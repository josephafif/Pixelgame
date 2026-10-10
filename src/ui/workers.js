// Workers (single player): hire people at the Workers' Lodge, choose who
// chops trees and who breaks rocks, and see what each one is doing. Their
// wages are part of the camp's upkeep (shown in the Vault).

import { h, pixelCanvas } from './dom.js';
import { icon, costChips } from './icons.js';
import { openModal, replaceModalBody, askConfirm } from './modal.js';
import { buildingLevel } from '../game/base.js';
import { workerStats, ROLE_NAMES, WORKER_ROLES } from '../game/workers.js';
import { isSoldier } from '../game/army.js';
import { formatHours, roundUp } from '../game/upkeep.js';
import { workerPortrait } from '../render/workers-art.js';

const TIER_TEXT = ['', 'trees and rocks', 'crystals too', 'obsidian too', 'iron ore too'];

export function open(game, app) {
  const { data, save } = game;
  const wf = game.workforce;
  const rerender = () => {
    const body = document.querySelector('.workers-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  };

  function workerRow(w) {
    const art = pixelCanvas(workerPortrait(w));
    art.style.width = '30px';
    art.style.height = '36px';
    return h('div.worker-row', { 'data-worker': w.id },
      art,
      h('div.worker-info',
        h('b', w.name),
        h('span.small.muted', wf.describe(w)),
        w.hp < w.maxHp ? h('div.meter.small', h('div', { style: { width: `${Math.max(0, (100 * w.hp) / w.maxHp)}%` } })) : null),
      h('span.spacer'),
      h('div.worker-roles', WORKER_ROLES.map((role) => h(`button.small${w.role === role ? '.btn-primary' : ''}`, {
        'aria-pressed': String(w.role === role),
        onclick: () => game.setWorkerRole(w.id, role),
      }, icon(role === 'wood' ? 'wood' : 'stone', 16), ROLE_NAMES[role]))),
      h('button.small.btn-danger', {
        onclick: async () => {
          const sure = await askConfirm({ title: `Let ${w.name} go?`, text: 'They leave the camp for good. Hiring someone new costs the full price again.', ok: 'Let go', danger: true });
          if (sure) game.fireWorker(w.id);
        },
      }, 'Let go'));
  }

  function build() {
    const level = buildingLevel(data, save, 'lodge');
    if (level < 1) {
      return h('div.workers',
        h('p', 'Build the Workers’ Lodge at your camp to hire workers. They chop trees and break rocks out in the wild and carry it all to the Vault, for a daily wage.'),
        h('button.btn-primary', { onclick: () => app.panels.show('base', { focus: 'lodge' }) }, icon('home', 20), 'To the camp'));
    }
    const stats = workerStats(data, level);
    const cap = wf.cap();
    const cost = wf.hireCost();
    const problem = wf.hireProblem();
    const wage = roundUp(data.base.workers.wagePerDay ?? {});
    const hire = (role) => game.hireWorker(role);
    // Soldiers and recruits are on the strategy map; these are the ones who work.
    const workers = wf.list.filter((w) => !isSoldier(data, w.role) && !save.base.workers.find((r) => r.id === w.id)?.trainingTo);
    return h('div.workers',
      h('p.small.muted', `Lodge level ${level}: room for ${cap} workers. They work on ${TIER_TEXT[stats.tier]}, up to ${stats.range} tiles from camp, and come back with what they gathered.`),
      h('div.row.worker-wage', h('span.small', 'Wage per worker and day:'), costChips(wage), h('span.small.muted', '(paid from the Vault)')),
      save.base.unpaid ? h('p.warn.small', icon('skull', 16), ' The upkeep isn’t paid, so your workers have stopped. Put supplies in the Vault.') : null,
      h('div.worker-list', workers.length ? workers.map(workerRow) : h('p.muted', 'No workers yet.')),
      wf.soldierCount() ? h('p.small', `${wf.soldierCount()} of your people are soldiers (or training to be).`) : null,
      h('button', { onclick: () => app.panels.show('strategy') }, icon('flag', 20), 'Army and strategy map (N)'),
      wf.workerCount() < cap
        ? h('section.worker-hire',
          h('h3', `Hire a worker (${wf.workerCount()} / ${cap})`),
          h('div.row', costChips(cost, save.resources)),
          problem ? h('p.small.req', problem) : null,
          h('div.row',
            h('button.btn-primary', { disabled: Boolean(problem), onclick: () => hire('wood') }, icon('wood', 20), 'Hire a lumberjack'),
            h('button.btn-primary', { disabled: Boolean(problem), onclick: () => hire('stone') }, icon('stone', 20), 'Hire a miner')))
        : h('p.small.muted', level < 5 ? 'The lodge is full. Upgrade it to house one more worker.' : 'The lodge is full.'),
      h('p.small.muted', 'Careful: a worker you hit turns on you until it calms down, and a worker that dies is gone.'),
      h('div.row',
        h('button', { onclick: () => app.panels.show('vault') }, icon('chest', 20), wf.suppliesLast() > 0 ? `Vault (supplies last ${formatHours(wf.suppliesLast())})` : 'Vault (empty)'),
        h('button', { onclick: () => app.panels.show('base', { focus: 'lodge' }) }, icon('up', 20), 'Upgrade the lodge')));
  }

  // Workers come and go: keep what each one is doing up to date.
  const timer = setInterval(() => {
    for (const el of document.querySelectorAll('.workers-panel .worker-row')) {
      const w = wf.list.find((x) => x.id === Number(el.dataset.worker));
      const line = el.querySelector('.worker-info .small');
      if (w && line) line.textContent = wf.describe(w);
    }
  }, 1000);
  const offs = [game.on('base', rerender), game.on('inventory', rerender)];
  openModal({
    title: 'Workers', icon: 'players', body: build(), className: 'workers-panel',
    onDispose: () => {
      clearInterval(timer);
      offs.forEach((off) => off());
    },
  });
}
