// Weapon Research (spec §18/§19): discovered components can be researched
// with essence; each one widens the pool the weapon generator draws from.

import { h } from './dom.js';
import { icon, costChip } from './icons.js';
import { openModal, replaceModalBody } from './modal.js';
import { researchCost, baseBonuses } from '../game/base.js';

function unlockList(game, c) {
  const u = c.unlocks ?? {};
  const name = (kind, id) => game.data.byId[kind]?.get(id)?.name ?? id;
  const parts = [];
  for (const id of u.archetypes ?? []) parts.push(`Weapon type: ${name('archetypes', id)}`);
  for (const id of u.materials ?? []) parts.push(`Material: ${name('materials', id)}`);
  for (const id of u.effects ?? []) parts.push(`Effect: ${name('effects', id)}`);
  for (const id of u.abilities ?? []) parts.push(`Ability: ${name('abilities', id)}`);
  if (c.element) parts.push(`Forge element: ${game.data.byId.elements.get(c.element)?.name}`);
  return parts;
}

const TYPE_ICON = { core: 'essence', material: 'scrap', blueprint: 'sword', ability: 'star' };

export function open(game) {
  const rerender = () => {
    const body = document.querySelector('.research-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  };

  function build() {
    const found = Object.entries(game.save.components)
      .map(([id, entry]) => ({ def: game.data.byId.components.get(id), entry }))
      .filter((x) => x.def)
      .sort((a, b) => Number(a.entry.researched) - Number(b.entry.researched));
    const total = game.data.components.length;
    const essence = game.save.resources.essence;
    const discount = Math.min(60, baseBonuses(game.data, game.save).researchDiscountPct);
    return h('div.research',
      h('div.base-head',
        h('span.rank', `Discovered ${found.length} / ${total}`),
        discount ? h('span.small.good', `Library: -${discount}% research cost`) : null,
        h('span.spacer'),
        h('span.cost', icon('essence', 20), String(essence))),
      found.length ? null : h('div.empty-state', icon('book', 48),
        h('p', 'Defeat enemies, open chests and slay bosses to find cores, materials and blueprints.')),
      h('ul.research-list', found.map(({ def, entry }) => {
        const color = game.data.byId.rarities.get(def.rarity)?.color;
        const cost = researchCost(game.data, game.save, def);
        return h('li.research-item', { class: entry.researched ? 'done' : null },
          h('div.research-head',
            icon(TYPE_ICON[def.type] ?? 'book', 20),
            h('b', { style: { color } }, def.name),
            h('span.muted.small', ` ${def.type}${def.boss ? ' · boss core' : ''}`)),
          h('p', def.desc),
          h('ul.unlocks', unlockList(game, def).map((t) => h('li', t))),
          entry.researched
            ? h('span.badge', 'Researched')
            : h('div.row',
              costChip('essence', cost, essence),
              h('button.btn-primary', {
                disabled: essence < cost,
                onclick: () => {
                  game.research(def.id);
                  rerender();
                },
              }, 'Research')));
      })));
  }

  const off = game.on('components', () => rerender());
  openModal({ title: 'Research', icon: 'book', body: build(), className: 'wide research-panel', onDispose: off });
}
