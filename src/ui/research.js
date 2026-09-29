// Weapon Research (spec §18/§19): discovered components can be researched
// with essence; each one widens the pool the weapon generator draws from.

import { h } from './dom.js';
import { openModal, replaceModalBody } from './modal.js';

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

export function open(game) {
  const rerender = () => replaceModalBody(build());

  function build() {
    const found = Object.entries(game.save.components)
      .map(([id, entry]) => ({ def: game.data.byId.components.get(id), entry }))
      .filter((x) => x.def)
      .sort((a, b) => Number(a.entry.researched) - Number(b.entry.researched));
    const total = game.data.components.length;
    const essence = game.save.resources.essence;
    return h('div.research',
      h('p', `Components discovered: ${found.length} / ${total} · Essence: ${essence} ◆`),
      found.length ? null : h('p.muted', 'Defeat enemies, open chests and slay bosses to find cores, materials and blueprints.'),
      h('ul.research-list', found.map(({ def, entry }) => {
        const color = game.data.byId.rarities.get(def.rarity)?.color;
        return h('li.research-item', { class: entry.researched ? 'done' : '' },
          h('div.research-head',
            h('b', { style: { color } }, def.name),
            h('span.muted', ` ${def.type}${def.boss ? ' · boss core' : ''}`)),
          h('p', def.desc),
          h('ul.unlocks', unlockList(game, def).map((t) => h('li', t))),
          entry.researched
            ? h('span.badge', 'Researched')
            : h('button.btn-primary', {
              disabled: essence < def.research,
              onclick: () => {
                game.research(def.id);
                rerender();
              },
            }, `Research (${def.research} ◆)`));
      })));
  }

  const off = game.on('components', () => rerender());
  openModal({ title: 'Research', body: build(), className: 'wide research-panel', onClose: off });
}
