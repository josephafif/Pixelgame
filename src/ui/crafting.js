// The Forge (spec §17): Blueprint + Material + Core + Modifier rune +
// Catalyst (+ unlocked Ability) → procedural weapon generator.

import { h } from './dom.js';
import { openModal, replaceModalBody } from './modal.js';
import { craftingOptions, validateCraft, craftCost } from '../weapons/crafting.js';

export function open(game) {
  const opts = craftingOptions(game.data, game.save);
  const choice = {
    archetype: opts.blueprints[0]?.id ?? null,
    material: null,
    core: null,
    rune: null,
    catalyst: 'none',
    ability: null,
  };
  choice.material = opts.materialsFor(choice.archetype)[0]?.id ?? null;
  let busy = false;

  const select = (label, key, items, { allowNone = false, noneLabel = 'None', describe } = {}) => h('label.field',
    h('span', label),
    h('select', {
      onchange: (e) => {
        choice[key] = e.target.value || null;
        if (key === 'archetype') choice.material = opts.materialsFor(choice.archetype)[0]?.id ?? null;
        rerender();
      },
    },
    allowNone ? h('option', { value: '', selected: !choice[key] }, noneLabel) : null,
    items.map((it) => h('option', { value: it.id, selected: choice[key] === it.id, disabled: it.locked ? true : null },
      describe ? describe(it) : it.name))));

  const rerender = () => replaceModalBody(build());

  function build() {
    const errors = validateCraft(game.data, game.save, choice);
    const cost = craftCost(game.data, choice);
    const res = game.save.resources;
    const core = opts.cores.find((c) => c.id === choice.core);
    return h('div.forge',
      h('p.muted', 'Combine components. The generator still rolls stats, extra modifiers, effects and the name — no two crafts are alike.'),
      h('div.forge-grid',
        select('Blueprint (weapon type)', 'archetype', opts.blueprints),
        select('Material', 'material', opts.materialsFor(choice.archetype)),
        select('Core (element)', 'core', opts.cores, { allowNone: true, noneLabel: 'None (physical)' }),
        select('Modifier rune', 'rune', opts.runes, { allowNone: true, noneLabel: opts.runes.length ? 'None' : 'Discover weapons to learn runes' }),
        select('Catalyst (rarity)', 'catalyst', opts.catalysts, {
          describe: (c) => `${c.name}${c.essence ? ` (${c.essence}◆)` : ''}${c.locked ? ` — ${c.locked}` : ''}`,
        }),
        select('Ability', 'ability', opts.abilities, { allowNone: true, noneLabel: opts.abilities.length ? 'None' : 'Find ability weapons to unlock' })),
      core ? h('p.core-desc', core.desc) : null,
      h('div.cost', `Cost: ${cost.scrap} ⚙ scrap (you have ${res.scrap}) · ${cost.essence} ◆ essence (you have ${res.essence})`),
      errors.length ? h('ul.errors', errors.map((e) => h('li', e))) : null,
      h('div.actions',
        h('button.btn-primary', {
          disabled: Boolean(errors.length) || busy,
          onclick: async () => {
            busy = true;
            rerender();
            try {
              await game.craft({ ...choice });
            } catch (err) {
              game.toast(err.message, 'warn');
              busy = false;
              rerender();
            }
          },
        }, busy ? 'Forging…' : 'Forge weapon')),
      h('p.muted.small', 'Crafting works fully offline. Research components to expand what the forge can make.'));
  }

  openModal({ title: 'Forge', body: build(), className: 'wide forge-panel' });
}
