// Camp panel: every building of the base with its level, what it does now,
// what the next level adds and what it costs. Buildings are upgraded here
// and the Essence Well / Waystone are used from here too.

import { h, pixelCanvas } from './dom.js';
import { icon, costChips } from './icons.js';
import { openModal, replaceModalBody, closeModal } from './modal.js';
import { buildingSprite } from '../render/buildings.js';
import { horseSprite } from '../render/horses.js';
import { describeHorse, MAX_HORSES } from '../game/horses.js';
import {
  buildingDefs, buildingLevel, maxLevel, nextLevelInfo, upgradeBlockers, describeBonus, campRank,
  wellPending, baseBonuses, TONIC,
} from '../game/base.js';
import { structureDef, upgradeDef, upgradeCost, structureLock } from '../game/construction.js';

function pips(level, max) {
  return h('div.pips', { 'aria-label': `Level ${level} of ${max}` },
    Array.from({ length: max }, (_, i) => h('i', { class: i < level ? 'on' : null })));
}

export function open(game, app, { focus = null } = {}) {
  const { data, save } = game;
  let focusId = focus;
  const rerender = () => {
    const body = document.querySelector('.base-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  };

  function extraActions(def, level) {
    if (level < 1) return [];
    switch (def.id) {
      case 'forge':
        return [h('button', { onclick: () => app.panels.show('crafting') }, icon('anvil', 20), 'Craft')];
      case 'vault':
        return [
          h('button', { onclick: () => app.panels.show('vault') }, icon('chest', 20), 'Supplies'),
          h('button', { onclick: () => app.panels.show('inventory', { tab: 'storage' }) }, icon('bag', 20), 'Storage')];
      case 'lodge':
        return [h('button', { onclick: () => app.panels.show('workers') }, icon('players', 20), `Workers (${save.base.workers.length})`)];
      case 'library':
        return [h('button', { onclick: () => app.panels.show('research') }, icon('book', 20), 'Research')];
      case 'den':
        return [h('button', { onclick: () => app.panels.show('pals') }, icon('pal', 20), 'Pals')];
      case 'training':
        return [h('button', { onclick: () => app.panels.show('strategy') }, icon('flag', 20), 'Train soldiers · strategy map')];
      case 'well': {
        const n = wellPending(data, save);
        return [h('button', {
          disabled: n <= 0,
          onclick: () => {
            game.collectWell();
            rerender();
          },
        }, icon('essence', 20), n > 0 ? `Collect ${n}` : 'Filling…')];
      }
      case 'garden': {
        // Lumen Tonic: healing over time and a ward against the bogs, brewed from Lumen Spores.
        const left = Math.max(0, Math.ceil((game.tonicUntil ?? 0) - game.time));
        const have = Math.floor(save.resources.spores ?? 0);
        return [h('button', {
          disabled: have < TONIC.cost.spores,
          title: `Heals ${TONIC.regenPct}% Health a second and wards against the fen's bogs for ${TONIC.seconds / 60} minutes`,
          onclick: () => {
            const problem = game.brewTonic();
            if (problem) game.toast(problem, 'warn');
            rerender();
          },
        }, icon('spores', 20), left > 0
          ? `Tonic: ${Math.ceil(left / 60)} min left`
          : `Brew Lumen Tonic (${TONIC.cost.spores} spores, you have ${have})`)];
      }
      case 'waystone': {
        const far = !game.atCamp();
        const out = [];
        if (far) {
          const left = Math.ceil(game.recallReadyIn());
          out.push(h('button', {
            disabled: left > 0,
            onclick: () => {
              closeModal();
              game.recall();
            },
          }, icon('portal', 20), left > 0 ? `Recall (${left}s)` : 'Recall to camp'));
        } else if (level >= 2 && save.base.recall) {
          out.push(h('button', {
            onclick: () => {
              closeModal();
              game.returnFromRecall();
            },
          }, icon('portal', 20), 'Return'));
        }
        return out;
      }
      default:
        return [];
    }
  }

  function wellMeter(level) {
    if (level < 1) return null;
    const rate = baseBonuses(data, save).essencePerHour;
    const cap = Math.floor(rate * data.base.wellCapHours);
    const n = wellPending(data, save);
    return h('div',
      h('div.meter', { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': cap, 'aria-valuenow': n },
        h('div', { style: { width: `${Math.min(100, (100 * n) / Math.max(1, cap))}%` } })),
      h('div.small.muted', `${n} / ${cap} essence stored`));
  }

  function card(def) {
    const level = buildingLevel(data, save, def.id);
    const max = maxLevel(def);
    const next = nextLevelInfo(data, save, def.id);
    const blockers = upgradeBlockers(data, save, def.id);
    const hardBlockers = next ? blockers.filter((b) => !/^Needs \d+ more /.test(b)) : [];
    const canUpgrade = next && blockers.length === 0;
    const art = pixelCanvas(buildingSprite(def.id, level));
    art.style.width = '64px';
    art.style.height = '72px';
    return h('article.bcard', {
      class: [focusId === def.id ? 'focus' : null, level === 0 ? 'unbuilt' : null].filter(Boolean).join(' ') || null,
      'data-building': def.id,
    },
    h('div.bcard-top',
      h('div.bcard-art', art),
      h('div',
        h('h3', def.name),
        pips(level, max),
        h('div.small.muted', level === 0 ? 'Not built' : `Level ${level} / ${max}`))),
    h('p.desc', def.desc),
    level > 0 ? h('div.now', icon('star', 16), ' ', describeBonus(data, def.id, level)) : null,
    def.id === 'well' ? wellMeter(level) : null,
    next ? h('div.next', icon('up', 16), ' ', level === 0 ? 'Build: ' : 'Next: ', describeBonus(data, def.id, next.level)) : null,
    hardBlockers.length ? h('div.req', icon('lock', 16), ' ', hardBlockers.join(' · ')) : null,
    h('div.row',
      next ? costChips(next, save.resources) : null,
      next
        ? h(`button${canUpgrade ? '.btn-primary' : ''}`, {
          disabled: !canUpgrade,
          onclick: () => {
            focusId = def.id;
            game.upgradeBuilding(def.id);
          },
        }, level === 0 ? 'Build' : 'Upgrade')
        : h('span.badge', 'Max level'),
      ...extraActions(def, level)));
  }

  /** Fortify: upgrade every wall (gate, turret …) of one kind at once. */
  function fortify() {
    const counts = new Map();
    for (const st of save.base.structures) if (st.def?.upgradesTo) counts.set(st.id, (counts.get(st.id) ?? 0) + 1);
    if (!counts.size) return null;
    const rows = [...counts].map(([id, n]) => {
      const from = structureDef(data, id);
      const to = upgradeDef(data, from);
      const each = upgradeCost(data, from, to);
      const lock = structureLock(data, save, to);
      const affordable = Math.min(n, ...Object.entries(each).map(([k, c]) => Math.floor((save.resources[k] ?? 0) / c)));
      return h('div.fortify-row',
        h('span', h('b', `${n} × ${from.name}`), ' → ', to.name),
        h('span.bcost', costChips(each, save.resources), h('span.small.muted', ' each')),
        lock ? h('span.small.req', icon('lock', 14), ' ', lock)
          : h('button.small', { disabled: affordable < 1, onclick: () => game.fortify(id) }, icon('up', 16), affordable >= n ? 'Upgrade all' : `Upgrade ${Math.max(0, affordable)}`));
    });
    return h('section.fortify',
      h('h3', 'Fortify'),
      h('p.small.muted', 'Upgrade in place: wood → stone → reinforced walls, iron gates, ballistas and iron spikes. Or use the Upgrade tool in build mode (U).'),
      rows);
  }

  /** Your horses: where each one is, and letting one go. */
  function horses() {
    const st = save.horses;
    if (!st?.owned.length) return null;
    return h('section.horse-list',
      h('h3', `Horses (${st.owned.length} / ${MAX_HORSES})`),
      h('p.small.muted', 'Leave a horse in camp and it stays. Left out in the wild, it wanders off if you go far away for long.'),
      st.owned.map((rec) => {
        const art = pixelCanvas(horseSprite(rec.breed, 0, true));
        art.style.width = '45px';
        art.style.height = '36px';
        const where = rec.id === st.riding ? 'Riding' : rec.stabled ? 'In camp' : 'Out in the world';
        return h('div.horse-row',
          art,
          h('div',
            h('b', rec.name),
            h('div.small.muted', `${describeHorse(rec)} · ${where}`)),
          h('span.spacer'),
          rec.id === st.riding ? null : h('button', {
            onclick: () => {
              if (game.stable.release(rec.id)) {
                game.toast(`${rec.name} gallops off into the wild.`, 'info');
                rerender();
              }
            },
          }, 'Let go'));
      }));
  }

  function build() {
    const defs = buildingDefs(data);
    const maxRank = defs.reduce((s, d) => s + maxLevel(d), 0);
    return h('div.base',
      h('div.base-head',
        h('span.rank', `Camp rank ${campRank(data, save)} / ${maxRank}`),
        h('span.spacer'),
        ['scrap', 'essence', 'wood', 'stone'].map((k) => h('span.cost', { title: k }, icon(k, 20), String(save.resources[k] ?? 0)))),
      h('div.row.base-actions',
        h('button.btn-primary', {
          onclick: () => {
            closeModal();
            game.toggleBuildMode(true);
          },
        }, icon('hammer', 20), 'Build walls & turrets'),
        h('span.small.muted', 'Camp area grows with every Hearth upgrade. Chop trees and break rocks with a pickaxe (Forge) for wood and stone.')),
      h('p.small.muted', 'Upgrade buildings with scrap, essence, wood and stone. Walk up to a building in camp to use it.'),
      h('div.base-grid', defs.map(card)),
      fortify(),
      horses());
  }

  const offs = [game.on('base', rerender), game.on('inventory', rerender), game.on('riding', rerender), game.on('structures', rerender)];
  openModal({
    title: 'Camp', icon: 'home', body: build(), className: 'wide base-panel',
    onDispose: () => offs.forEach((off) => off()),
  });
  if (focusId) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.bcard[data-building="${focusId}"]`);
      el?.scrollIntoView({ block: 'nearest' });
      el?.querySelector('button.btn-primary, button:not([disabled])')?.focus({ preventScroll: true });
    });
  }
}
