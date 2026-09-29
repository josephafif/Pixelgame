// "NEW WEAPON DISCOVERED" screen (spec §16). Chests and the Forge first
// play a case-opening roll; the card appears when it stops.

import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal, closeModal, replaceModalBody } from './modal.js';
import { weaponCard } from './weapon-card.js';
import { caseRoll } from './case-roll.js';
import { weaponValue } from '../game/economy.js';

function discoveryBody(game, { dna, canKeep, canStore, salvage, equipped }, choose) {
  const isFirst = !equipped;
  const rarity = game.data.byId.rarities.get(dna.rarity);
  const r = game.data.rarityIndex.get(dna.rarity) ?? 0;
  // Pixel confetti for epic and legendary finds.
  const confetti = r >= 3
    ? h('div.confetti', { 'aria-hidden': 'true' }, Array.from({ length: r >= 4 ? 28 : 14 }, (_, i) => h('i', {
      style: {
        left: `${(i * 37) % 100}%`,
        animationDelay: `${((i * 7) % 10) / 10}s`,
        animationDuration: `${1.6 + ((i * 3) % 7) / 10}s`,
        background: i % 3 ? rarity.color : '#ffffff',
      },
    })))
    : null;
  const gain = [
    `+${salvage.scrap}`, icon('scrap', 16), `+${salvage.essence}`, icon('essence', 16),
    salvage.shards ? [`+${salvage.shards}`, icon('shard', 16)] : null,
  ];
  return h('div.discovery', { class: `r-${dna.rarity}`, style: { '--rarity': rarity?.color } },
    r >= 2 ? h('div.rays', { 'aria-hidden': 'true' }) : null,
    confetti,
    h('div.discovery-banner', { class: `r-${dna.rarity}`, 'aria-live': 'assertive' }, 'NEW WEAPON DISCOVERED'),
    h('div.rarity-ribbon', { class: `r-${dna.rarity}` }, h('span', rarity?.name.toUpperCase() ?? '')),
    r >= 4 ? h('p.jackpot', icon('coin', 16), ` Worth about ${weaponValue(dna).toLocaleString()} gold to a trader`) : null,
    weaponCard(game.data, dna, { compareTo: equipped }),
    h('div.actions',
      h('button.btn-primary', { onclick: () => choose('equip'), autofocus: true, disabled: !canKeep && !canStore }, icon('sword', 20), 'Equip'),
      isFirst ? null : h('button', { onclick: () => choose('secondary'), disabled: !canKeep }, h('span.slotnum', '2'), 'Secondary'),
      isFirst ? null : h('button', { onclick: () => choose('keep'), disabled: !canKeep }, icon('bag', 20), canKeep ? 'Keep in bag' : 'Bag full'),
      isFirst ? null : h('button', { onclick: () => choose('storage'), disabled: !canStore }, icon('chest', 20), 'Send to storage'),
      isFirst ? null : h('button.btn-danger', { onclick: () => choose('salvage') }, 'Salvage', h('span.gain', gain))));
}

export function showDiscovery(game, info) {
  const { dna, caseRoll: range } = info;
  const choose = (choice) => {
    closeModal(true);
    game.resolveDiscovery(dna, choice);
  };
  const rarity = game.data.byId.rarities.get(dna.rarity);
  const label = `New ${rarity?.name ?? ''} weapon discovered`;
  if (!range) {
    openModal({ body: discoveryBody(game, info, choose), className: `discovery-panel r-${dna.rarity}`, locked: true, label });
    return;
  }
  const roll = caseRoll(game, dna, range, range.title ?? 'Opening…');
  const { panel } = openModal({ body: roll.el, className: 'discovery-panel case-panel', locked: true, label: 'Opening' });
  roll.done.then(() => {
    panel.classList.remove('case-panel');
    panel.classList.add(`r-${dna.rarity}`);
    panel.setAttribute('aria-label', label);
    replaceModalBody(discoveryBody(game, info, choose));
    panel.querySelector('[autofocus]')?.focus({ preventScroll: true });
  });
}
